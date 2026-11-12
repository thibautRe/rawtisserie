import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AUTO_RECIPE_LABEL, defaultEditParams, defaultRecipe, normalizeEditParams } from '@rawtisserie/pipeline';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, historyEntries, photos, sql, versions } from '../db.ts';
import type { Queryable } from '@databases/pg';
import { HttpError, badRequest, conflict, notFound } from '../errors.ts';
import type HistoryEntries from '../__generated__/history_entries.ts';
import type Photos from '../__generated__/photos.ts';
import type Versions from '../__generated__/versions.ts';
import type { RenderQueue } from '../render/queue.ts';
import { renderSource } from '../render/source.ts';
import { ZoomError, type ZoomRenderer } from '../render/zoom.ts';
import { ZOOM_TILE } from '../render/zoomTypes.ts';
import { storage } from '../storage/index.ts';
import { VERSIONS_FROM, VERSION_COLUMNS, type VersionRow, versionDetailDto, versionDto } from './dto.ts';
import { PhotoFilters, PhotoListQuery, SORTS, whereClause } from './query.ts';
import {
  RAW_EXTENSIONS,
  RENDER_SIZES,
  commitUpload,
  deleteOriginal,
  deleteRenders,
  discardUpload,
  originalKey,
  receiveUpload,
  renderKey,
  type RenderSize,
} from './storage.ts';

const Id = z.object({ id: z.uuid() });
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => s || null);
const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;

/**
 * Fields a user may edit on a library item. Curation belongs to the version; metadata
 * corrections belong to the photo (shared by its versions). Originals are never modified.
 */
const VersionPatch = z
  .object({
    versionName: nullableText(200),
    title: nullableText(500),
    description: nullableText(10_000),
    rating: z.number().int().min(0).max(5),
    flag: z.enum(['picked', 'rejected']).nullable(),
    colorLabel: z.enum(COLOR_LABELS).nullable(),
    tags: z.array(z.string().trim().min(1).max(100)).max(100),
    cameraMake: nullableText(200),
    cameraModel: nullableText(200),
    lens: nullableText(200),
    iso: z.number().int().positive().nullable(),
    exposureTime: z.number().positive().nullable(),
    fNumber: z.number().positive().nullable(),
    focalLength: z.number().positive().nullable(),
    exposureBias: z.number().nullable(),
    capturedAt: z.coerce.date().nullable(),
    gpsLatitude: z.number().min(-90).max(90).nullable(),
    gpsLongitude: z.number().min(-180).max(180).nullable(),
    artist: nullableText(200),
    copyright: nullableText(500),
  })
  .partial()
  .strict();
type VersionPatch = z.infer<typeof VersionPatch>;

const VERSION_FIELDS: Partial<Record<keyof VersionPatch, keyof Versions>> = {
  versionName: 'name',
  title: 'title',
  description: 'description',
  rating: 'rating',
  flag: 'flag',
  colorLabel: 'color_label',
  tags: 'tags',
};

const PHOTO_FIELDS: Partial<Record<keyof VersionPatch, keyof Photos>> = {
  cameraMake: 'camera_make',
  cameraModel: 'camera_model',
  lens: 'lens',
  iso: 'iso',
  exposureTime: 'exposure_time',
  fNumber: 'f_number',
  focalLength: 'focal_length',
  exposureBias: 'exposure_bias',
  capturedAt: 'captured_at',
  gpsLatitude: 'gps_latitude',
  gpsLongitude: 'gps_longitude',
  artist: 'artist',
  copyright: 'copyright',
};

function toColumns<T>(patch: VersionPatch, fields: Partial<Record<keyof VersionPatch, keyof T>>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = fields[key as keyof VersionPatch];
    if (column && value !== undefined) out[column as string] = value;
  }
  return out as Partial<T>;
}

const Bulk = z.object({
  ids: z.array(z.uuid()).min(1).max(5000),
  patch: VersionPatch.pick({ rating: true, flag: true, colorLabel: true }).extend({
    addTags: z.array(z.string().trim().min(1).max(100)).optional(),
    removeTags: z.array(z.string().trim().min(1).max(100)).optional(),
  }),
});

const Duplicate = z.object({
  /** Start from the original (an empty history) instead of copying the history. */
  fromOriginal: z.boolean().default(false),
});

const HistoryEntryInput = z.object({
  label: z.string().trim().min(1).max(200),
  recipe: z.unknown().refine((r) => r !== null && r !== undefined, 'A recipe is required'),
  createdAt: z.coerce.date().optional(),
});

/**
 * A change to a version's history. Entries are numbered from 1; `end` is the new
 * `history_end` (0 = the original).
 * - `splice`: drop the entries from `from` on, then insert `entries` there. Appending
 *   is `from = end + 1`, replacing the latest entry is `from = end`.
 * - `goto`: move `history_end` (undo/redo, or a click in the history stack).
 */
const HistoryOp = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('splice'),
    from: z.number().int().min(1),
    entries: z.array(HistoryEntryInput).max(1000),
    end: z.number().int().min(0),
  }),
  z.object({ type: z.literal('goto'), end: z.number().int().min(0) }),
]);

const HistoryChange = z.object({
  ops: z.array(HistoryOp).min(1).max(100),
  /** The `revision` the client based its changes on; a mismatch means someone else edited it. */
  baseRevision: z.number().int().optional(),
});
type HistoryChange = z.infer<typeof HistoryChange>;

const Ids = z.object({ ids: z.array(z.uuid()).min(1).max(5000) });

/** History changes to several versions (a preset or style applied to a selection, or its undo). */
const BatchHistoryChange = z.object({
  changes: z
    .array(HistoryChange.extend({ id: z.uuid(), baseRevision: z.number().int() }))
    .min(1)
    .max(200),
});

export async function photoRoutes(
  app: FastifyInstance,
  { renderQueue, zoom }: { renderQueue: RenderQueue; zoom: ZoomRenderer },
) {
  app.addHook('preHandler', requireUser);

  const findVersion = async (ownerId: string, id: string) => {
    const [row] = (await db.query(sql`
      SELECT ${VERSION_COLUMNS} FROM ${VERSIONS_FROM} WHERE v.id = ${id} AND p.owner_id = ${ownerId}`)) as VersionRow[];
    if (!row) throw notFound('Photo not found');
    return row;
  };

  const versionDetail = async (ownerId: string, id: string) => {
    const row = await findVersion(ownerId, id);
    const [photo, history, siblings] = await Promise.all([
      photos(db).findOne({ id: row.photo_id }),
      historyEntries(db).find({ version_id: id }).orderByAsc('seq').all(),
      versions(db).find({ photo_id: row.photo_id }).orderByAsc('position').orderByAsc('id').all(),
    ]);
    return versionDetailDto(row, photo!, history, siblings);
  };

  // ── Library (versions) ────────────────────────────────────────────────────

  app.get('/api/versions', async (request) => {
    const user = currentUser(request);
    const q = PhotoListQuery.parse(request.query);
    const where = whereClause(user.id, q);
    const [rows, [{ count }]] = await Promise.all([
      db.query(sql`
        SELECT ${VERSION_COLUMNS} FROM ${VERSIONS_FROM}
        WHERE ${where} ORDER BY ${SORTS[q.sort]} LIMIT ${q.limit} OFFSET ${q.offset}`),
      db.query(sql`SELECT count(*)::int AS count FROM ${VERSIONS_FROM} WHERE ${where}`),
    ]);
    return { versions: (rows as VersionRow[]).map(versionDto), total: count as number };
  });

  /** Distinct values (with counts) to populate the filter sidebar. */
  app.get('/api/versions/facets', async (request) => {
    const user = currentUser(request);
    const filters = PhotoFilters.parse(request.query);
    const where = whereClause(user.id, filters);
    const facet = (column: SQLColumn) =>
      db.query(sql`
        SELECT ${sql.ident('p', column)} AS value, count(*)::int AS count FROM ${VERSIONS_FROM}
        WHERE ${where} AND ${sql.ident('p', column)} IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`);
    const [cameras, lenses, tags, ratings, ranges] = await Promise.all([
      facet('camera_model'),
      facet('lens'),
      db.query(sql`
        SELECT t AS value, count(*)::int AS count FROM ${VERSIONS_FROM}, unnest(v.tags) t
        WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 200`),
      db.query(sql`
        SELECT v.rating AS value, count(*)::int AS count FROM ${VERSIONS_FROM} WHERE ${where} GROUP BY 1 ORDER BY 1`),
      db.query(sql`
        SELECT count(*)::int AS total, min(p.captured_at) AS "capturedFrom", max(p.captured_at) AS "capturedTo",
          min(p.iso) AS "isoMin", max(p.iso) AS "isoMax", min(p.focal_length) AS "focalMin",
          max(p.focal_length) AS "focalMax", min(p.f_number) AS "apertureMin", max(p.f_number) AS "apertureMax"
        FROM ${VERSIONS_FROM} WHERE ${where}`),
    ]);
    return { cameras, lenses, tags, ratings, ranges: ranges[0] };
  });

  /** Every tag in the user's library, most used first: for completing tags as they're typed. */
  app.get('/api/tags', async (request) => {
    const where = whereClause(currentUser(request).id, PhotoFilters.parse({}));
    return db.query(sql`
      SELECT t AS value, count(*)::int AS count FROM ${VERSIONS_FROM}, unnest(v.tags) t
      WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1`);
  });

  app.get('/api/versions/:id', async (request) => {
    const { id } = Id.parse(request.params);
    return versionDetail(currentUser(request).id, id);
  });

  app.patch('/api/versions/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const patch = VersionPatch.parse(request.body);
    const row = await findVersion(user.id, id);
    const versionColumns = toColumns<Versions>(patch, VERSION_FIELDS);
    const photoColumns = toColumns<Photos>(patch, PHOTO_FIELDS);
    await db.tx(async (tx) => {
      if (Object.keys(versionColumns).length)
        await versions(tx).update({ id }, { ...versionColumns, updated_at: new Date() });
      if (Object.keys(photoColumns).length) {
        await photos(tx).update({ id: row.photo_id }, { ...photoColumns, updated_at: new Date() });
      }
    });
    return versionDetail(user.id, id);
  });

  app.post('/api/versions/bulk', async (request) => {
    const user = currentUser(request);
    const { ids, patch } = Bulk.parse(request.body);
    const { addTags, removeTags, ...simple } = patch;
    const sets = [sql`updated_at = now()`];
    for (const [key, value] of Object.entries(toColumns<Versions>(simple, VERSION_FIELDS))) {
      sets.push(sql`${sql.ident(key)} = ${value}`);
    }
    if (addTags?.length)
      sets.push(sql`tags = ARRAY(SELECT DISTINCT t FROM unnest(tags || ${addTags}::text[]) t ORDER BY 1)`);
    if (removeTags?.length)
      sets.push(sql`tags = ARRAY(SELECT unnest(tags) EXCEPT SELECT unnest(${removeTags}::text[]))`);
    const updated = await db.query(sql`
      UPDATE versions SET ${sql.join(sets, sql`, `)}
      WHERE id = ANY(${ids}) AND photo_id IN (SELECT id FROM photos WHERE owner_id = ${user.id})
      RETURNING id`);
    const rows = (await db.query(sql`
      SELECT ${VERSION_COLUMNS} FROM ${VERSIONS_FROM} WHERE v.id = ANY(${updated.map((r) => r.id)})`)) as VersionRow[];
    return { versions: rows.map(versionDto) };
  });

  /** Delete versions. A photo left without any version is deleted too, original file included. */
  app.post('/api/versions/delete', async (request) => {
    const user = currentUser(request);
    const { ids } = Ids.parse(request.body);
    const { deleted, orphans } = await db.tx(async (tx) => {
      const deleted = (await tx.query(sql`
        DELETE FROM versions
        WHERE id = ANY(${ids}) AND photo_id IN (SELECT id FROM photos WHERE owner_id = ${user.id})
        RETURNING id, photo_id`)) as Pick<Versions, 'id' | 'photo_id'>[];
      const orphans = (await tx.query(sql`
        DELETE FROM photos p WHERE p.id = ANY(${deleted.map((d) => d.photo_id)})
          AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.photo_id = p.id)
        RETURNING storage_key`)) as Pick<Photos, 'storage_key'>[];
      return { deleted, orphans };
    });
    await Promise.all([
      ...deleted.map((d) => deleteRenders(d.id)),
      ...orphans.map((p) => deleteOriginal(p.storage_key)),
    ]);
    return { deleted: deleted.map((d) => d.id) };
  });

  /**
   * Duplicate a version, right after it among its photo's versions. The copy keeps the
   * curation (rating, flag, labels, tags, title, description) and, unless `fromOriginal`,
   * the whole history, undone entries included.
   */
  app.post('/api/versions/:id/duplicate', async (request, reply) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { fromOriginal } = Duplicate.parse(request.body ?? {});
    const { photo_id } = await findVersion(user.id, id);
    const created = await db.tx(async (tx) => {
      // Lock the photo's versions: positions are renumbered below.
      const siblings = (await tx.query(sql`
        SELECT * FROM versions WHERE photo_id = ${photo_id} ORDER BY position, id FOR UPDATE`)) as Versions[];
      const index = siblings.findIndex((v) => v.id === id);
      const source = siblings[index];
      if (!source) throw notFound('Photo not found');
      const [copy] = await versions(tx).insert({
        photo_id,
        position: index + 1,
        title: source.title,
        description: source.description,
        rating: source.rating,
        flag: source.flag,
        color_label: source.color_label,
        tags: source.tags,
        history_end: fromOriginal ? 0 : source.history_end,
        edited: fromOriginal ? false : source.edited,
        edited_at: fromOriginal ? null : source.edited_at,
      });
      await setPositions(
        tx,
        siblings.toSpliced(index + 1, 0, copy!).map((v) => v.id),
      );
      if (!fromOriginal) {
        await tx.query(sql`
          INSERT INTO history_entries (version_id, seq, created_at, label, recipe)
          SELECT ${copy!.id}, seq, created_at, label, recipe FROM history_entries WHERE version_id = ${id}`);
      } else {
        // From the original: what a new upload starts with (lens correction when the file
        // has its data), now rather than after its first render, which the developer
        // opening it right away would miss.
        const photo = await photos(tx).findOne({ id: photo_id });
        const recipe = photo?.exif && defaultRecipe({ lensCorrection: photo.exif.lensCorrection ?? null });
        if (recipe && recipe !== defaultEditParams) {
          await historyEntries(tx).insert({ version_id: copy!.id, seq: 1, label: AUTO_RECIPE_LABEL, recipe });
          await versions(tx).update({ id: copy!.id }, { history_end: 1 });
        }
      }
      return copy!;
    });
    renderQueue.enqueue(created.id);
    return reply.code(201).send(await versionDetail(user.id, created.id));
  });

  /** Move a version to `position` (0-based) among its photo's versions. */
  app.post('/api/versions/:id/move', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { position } = z.object({ position: z.number().int().min(0) }).parse(request.body);
    const { photo_id } = await findVersion(user.id, id);
    await db.tx(async (tx) => {
      const ids = (
        (await tx.query(sql`
          SELECT id FROM versions WHERE photo_id = ${photo_id} ORDER BY position, id FOR UPDATE`)) as Pick<
          Versions,
          'id'
        >[]
      ).map((v) => v.id);
      const others = ids.filter((v) => v !== id);
      await setPositions(tx, others.toSpliced(Math.min(position, others.length), 0, id));
    });
    return versionDetail(user.id, id);
  });

  /**
   * Apply a batch of history changes (see `HistoryOp`) in one transaction. The client
   * sends everything it has queued at once, so a batch also works with `keepalive`
   * while the page unloads. Previews are re-rendered in the background.
   */
  app.post('/api/versions/:id/history', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const change = HistoryChange.parse(request.body);
    await db.tx((tx) => applyHistoryChange(tx, user.id, id, change));
    renderQueue.enqueue(id);
    return versionDetail(user.id, id);
  });

  /**
   * The current recipe of each version (for editing them all from the library): the
   * history entry at `history_end`, or the recipe a new image starts with. Versions that
   * aren't found are left out. New uploads whose file hasn't been read yet are listed in
   * `notReady` instead: their starting recipe (lens correction) isn't known, and the
   * render queue only records it while their history is empty.
   */
  app.post('/api/versions/recipes', async (request) => {
    const user = currentUser(request);
    const { ids } = Ids.parse(request.body);
    const rows = (await db.query(sql`
      SELECT v.id, v.history_end, v.revision, v.render_status, h.recipe, p.exif,
        NOT EXISTS (SELECT 1 FROM history_entries e WHERE e.version_id = v.id) AS no_history
      FROM ${VERSIONS_FROM}
      LEFT JOIN history_entries h ON h.version_id = v.id AND h.seq = v.history_end
      WHERE v.id = ANY(${ids}) AND p.owner_id = ${user.id}`)) as (Pick<
      Versions,
      'id' | 'history_end' | 'revision' | 'render_status'
    > &
      Pick<HistoryEntries, 'recipe'> &
      Pick<Photos, 'exif'> & { no_history: boolean })[];
    // Without history, a version starts from the recipe for its file, which needs its
    // metadata: not known yet for a new upload. Undone to the original, it's the default.
    const notReady = (r: (typeof rows)[number]) => r.no_history && !r.exif && r.render_status === 'pending';
    return {
      versions: rows
        .filter((r) => !notReady(r))
        .map((r) => ({
          id: r.id,
          historyEnd: r.history_end,
          revision: r.revision,
          recipe: r.recipe
            ? normalizeEditParams(r.recipe)
            : r.no_history
              ? defaultRecipe({ lensCorrection: r.exif?.lensCorrection ?? null })
              : defaultEditParams,
        })),
      notReady: rows.filter(notReady).map((r) => r.id),
    };
  });

  /**
   * History changes to several versions, in one transaction. A version that changed
   * since the client read it (`baseRevision`) is left alone and listed in `conflicts`,
   * so the client can read it again and retry; the others are applied.
   */
  app.post('/api/versions/history', async (request) => {
    const user = currentUser(request);
    const { changes } = BatchHistoryChange.parse(request.body);
    const { applied, conflicts } = await db.tx(async (tx) => {
      const applied: { id: string; historyEnd: number; revision: number }[] = [];
      const conflicts: string[] = [];
      // In a fixed order, so concurrent batches lock rows the same way.
      for (const change of changes.toSorted((a, b) => a.id.localeCompare(b.id))) {
        const result = await applyHistoryChange(tx, user.id, change.id, change, { skipConflicts: true });
        if (result) applied.push({ id: change.id, ...result });
        else conflicts.push(change.id);
      }
      return { applied, conflicts };
    });
    for (const { id } of applied) renderQueue.enqueue(id);
    return { applied, conflicts };
  });

  app.post('/api/versions/:id/rerender', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    await findVersion(user.id, id);
    await versions(db).update({ id }, { render_status: 'pending', render_error: null });
    renderQueue.enqueue(id);
    return { ok: true };
  });

  app.get('/api/versions/:id/render/:size', async (request, reply) => {
    const { id, size } = Id.extend({ size: z.enum(Object.keys(RENDER_SIZES) as [RenderSize]) }).parse(request.params);
    const version = await findVersion(currentUser(request).id, id);
    const file = await storage.get(renderKey(version.id, size));
    if (!file) throw notFound('Not rendered yet');
    const versioned = (request.query as Record<string, string>).v === String(version.render_version);
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache')
      .send(file);
  });

  // ── Zoomed-in views (culling loupe) ──────────────────────────────────────

  /**
   * A signal aborted when the client goes away before the reply (the loupe moved on),
   * so that its queued renders are dropped.
   */
  const clientGone = (reply: FastifyReply) => {
    const ac = new AbortController();
    reply.raw.on('close', () => !reply.raw.writableFinished && ac.abort());
    return ac.signal;
  };
  const zoomSource = async (ownerId: string, id: string) => {
    await findVersion(ownerId, id);
    const source = await renderSource(id);
    if (!source) throw notFound('Photo not found');
    return source;
  };
  const zoomFailed = (err: unknown) => {
    if (!(err instanceof ZoomError) || err.reason === 'failed') return err;
    // 499: the client closed the request (nginx's code), so nobody reads it and it isn't logged.
    return err.reason === 'notFound' ? notFound(err.message) : new HttpError(499, err.message);
  };

  /**
   * The zoom levels of a version's current recipe (level 0 is 100 %, each next one half
   * of it), and the key its tiles are cached under (the history revision).
   */
  app.get('/api/versions/:id/zoom', async (request, reply) => {
    const { id } = Id.parse(request.params);
    const source = await zoomSource(currentUser(request).id, id);
    const levels = await zoom.levels(source, clientGone(reply)).catch((err) => {
      throw zoomFailed(err);
    });
    return { key: String(source.revision), tileSize: ZOOM_TILE, levels };
  });

  /** One tile of a zoom level (`ZOOM_TILE` square, smaller at the right and bottom edges). */
  app.get('/api/versions/:id/zoom/:level/:col/:row', async (request, reply) => {
    const { id, level, col, row } = Id.extend({
      level: z.coerce.number().int().min(0).max(8),
      col: z.coerce.number().int().min(0).max(1000),
      row: z.coerce.number().int().min(0).max(1000),
    }).parse(request.params);
    const source = await zoomSource(currentUser(request).id, id);
    const jpeg = await zoom.tile(source, level, col, row, clientGone(reply)).catch((err) => {
      throw zoomFailed(err);
    });
    const versioned = (request.query as Record<string, string>).k === String(source.revision);
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache')
      .send(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength));
  });

  // ── Photos (original files) ───────────────────────────────────────────────

  /** Upload one or more RAW files (multipart/form-data, field name `files`). Each gets one version. */
  app.post('/api/photos', async (request, reply) => {
    const user = currentUser(request);
    const created: ReturnType<typeof versionDto>[] = [];
    const skipped: { filename: string; reason: string }[] = [];

    for await (const part of request.files()) {
      const filename = path.basename(part.filename || 'unnamed');
      const ext = path.extname(filename).toLowerCase();
      if (!RAW_EXTENSIONS.has(ext)) {
        part.file.resume();
        skipped.push({ filename, reason: 'Not a supported RAW file' });
        continue;
      }
      const upload = await receiveUpload(part.file);
      if (part.file.truncated) {
        await discardUpload(upload);
        skipped.push({ filename, reason: 'File too large' });
        continue;
      }
      const duplicate = await photos(db).findOne({ owner_id: user.id, sha256: upload.sha256 });
      if (duplicate) {
        await discardUpload(upload);
        skipped.push({ filename, reason: `Already in your library as ${duplicate.original_filename}` });
        continue;
      }
      const id = randomUUID();
      const storageKey = `${user.id}/${id}${ext}`;
      await commitUpload(upload, storageKey);
      const versionId = await db.tx(async (tx) => {
        await photos(tx).insert({
          id,
          owner_id: user.id,
          original_filename: filename,
          storage_key: storageKey,
          file_size: upload.size,
          sha256: upload.sha256,
        });
        const [version] = await versions(tx).insert({ photo_id: id });
        return version!.id;
      });
      created.push(versionDto(await findVersion(user.id, versionId)));
      renderQueue.enqueue(versionId);
    }
    return reply.code(created.length ? 201 : 200).send({ created, skipped });
  });

  app.get('/api/photos/:id/original', async (request, reply) => {
    const { id } = Id.parse(request.params);
    const photo = await photos(db).findOne({ id, owner_id: currentUser(request).id });
    if (!photo) throw notFound('Photo not found');
    const file = await storage.get(originalKey(photo.storage_key));
    if (!file) throw notFound('Original file not found');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', photo.file_size)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(photo.original_filename)}`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(file);
  });
}

type SQLColumn = 'camera_model' | 'lens';

/**
 * Apply history ops (see `HistoryOp`) to one version, inside `tx`, and mark it for
 * re-rendering. A missing version or a `baseRevision` mismatch throws, or with
 * `skipConflicts` returns null and changes nothing.
 */
async function applyHistoryChange(
  tx: Queryable,
  ownerId: string,
  id: string,
  { ops, baseRevision }: HistoryChange,
  { skipConflicts = false } = {},
): Promise<{ historyEnd: number; revision: number } | null> {
  const [current] = (await tx.query(sql`
    SELECT v.history_end, v.revision,
      (SELECT coalesce(max(seq), 0)::int FROM history_entries h WHERE h.version_id = v.id) AS count
    FROM ${VERSIONS_FROM}
    WHERE v.id = ${id} AND p.owner_id = ${ownerId} FOR UPDATE OF v`)) as (Pick<Versions, 'history_end' | 'revision'> & {
    count: number;
  })[];
  if (!current) {
    if (skipConflicts) return null;
    throw notFound('Photo not found');
  }
  if (baseRevision !== undefined && baseRevision !== current.revision) {
    if (skipConflicts) return null;
    throw conflict('This version changed elsewhere — reload');
  }
  let { count, history_end: end } = current;
  for (const op of ops) {
    if (op.type === 'splice') {
      if (op.from > count + 1) throw badRequest(`Cannot splice history at ${op.from}: it has ${count} entries`);
      await tx.query(sql`DELETE FROM history_entries WHERE version_id = ${id} AND seq >= ${op.from}`);
      if (op.entries.length) {
        await historyEntries(tx).insert(
          ...op.entries.map((e, i) => ({
            version_id: id,
            seq: op.from + i,
            label: e.label,
            recipe: normalizeEditParams(e.recipe),
            ...(e.createdAt && { created_at: e.createdAt }),
          })),
        );
      }
      count = op.from - 1 + op.entries.length;
    }
    if (op.end > count) throw badRequest(`History has no entry ${op.end}`);
    end = op.end;
  }
  const revision = current.revision + 1;
  // The entry a new upload starts with (`AUTO_RECIPE_LABEL`) isn't an edit.
  const [first] = end === 1 ? await historyEntries(tx).find({ version_id: id, seq: 1 }).select('label').all() : [];
  const edited = end > 1 || (end === 1 && first?.label !== AUTO_RECIPE_LABEL);
  await versions(tx).update(
    { id },
    { history_end: end, edited, revision, edited_at: new Date(), render_status: 'pending', updated_at: new Date() },
  );
  return { historyEnd: end, revision };
}

/** Number versions 0, 1, 2… in the given order. */
async function setPositions(tx: Queryable, ids: string[]) {
  await tx.query(sql`
    UPDATE versions v SET position = o.ordinality - 1
    FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS o(id, ordinality)
    WHERE v.id = o.id AND v.position <> o.ordinality - 1`);
}
