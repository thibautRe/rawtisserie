import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeEditParams } from '@rawtisserie/pipeline';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, historyEntries, photos, sql, versions } from '../db.ts';
import type { Queryable } from '@databases/pg';
import { badRequest, conflict, notFound } from '../errors.ts';
import type Photos from '../__generated__/photos.ts';
import type Versions from '../__generated__/versions.ts';
import type { RenderQueue } from '../render/queue.ts';
import { VERSIONS_FROM, VERSION_COLUMNS, type VersionRow, versionDetailDto, versionDto } from './dto.ts';
import { PhotoFilters, PhotoListQuery, SORTS, whereClause } from './query.ts';
import {
  RAW_EXTENSIONS,
  RENDER_SIZES,
  commitUpload,
  deleteOriginal,
  deleteRenders,
  discardUpload,
  fileExists,
  originalPath,
  receiveUpload,
  renderPath,
  type RenderSize,
} from './storage.ts';

const Id = z.object({ id: z.uuid() });
const nullableText = (max: number) => z.string().trim().max(max).nullable().transform((s) => s || null);
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

export async function photoRoutes(app: FastifyInstance, { renderQueue }: { renderQueue: RenderQueue }) {
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
      if (Object.keys(versionColumns).length) await versions(tx).update({ id }, { ...versionColumns, updated_at: new Date() });
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
    if (addTags?.length) sets.push(sql`tags = ARRAY(SELECT DISTINCT t FROM unnest(tags || ${addTags}::text[]) t ORDER BY 1)`);
    if (removeTags?.length) sets.push(sql`tags = ARRAY(SELECT unnest(tags) EXCEPT SELECT unnest(${removeTags}::text[]))`);
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
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(5000) }).parse(request.body);
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
    await Promise.all([...deleted.map((d) => deleteRenders(d.id)), ...orphans.map((p) => deleteOriginal(p.storage_key))]);
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
        edited_at: fromOriginal ? null : source.edited_at,
      });
      await setPositions(tx, siblings.toSpliced(index + 1, 0, copy!).map((v) => v.id));
      if (!fromOriginal) {
        await tx.query(sql`
          INSERT INTO history_entries (version_id, seq, created_at, label, recipe)
          SELECT ${copy!.id}, seq, created_at, label, recipe FROM history_entries WHERE version_id = ${id}`);
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
          SELECT id FROM versions WHERE photo_id = ${photo_id} ORDER BY position, id FOR UPDATE`)) as Pick<Versions, 'id'>[]
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
    const { ops, baseRevision } = HistoryChange.parse(request.body);
    await db.tx(async (tx) => {
      const [current] = (await tx.query(sql`
        SELECT v.history_end, v.revision,
          (SELECT coalesce(max(seq), 0)::int FROM history_entries h WHERE h.version_id = v.id) AS count
        FROM ${VERSIONS_FROM}
        WHERE v.id = ${id} AND p.owner_id = ${user.id} FOR UPDATE OF v`)) as (Pick<Versions, 'history_end' | 'revision'> & {
        count: number;
      })[];
      if (!current) throw notFound('Photo not found');
      if (baseRevision !== undefined && baseRevision !== current.revision) {
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
      await versions(tx).update(
        { id },
        {
          history_end: end,
          revision: current.revision + 1,
          edited_at: new Date(),
          render_status: 'pending',
          updated_at: new Date(),
        },
      );
    });
    renderQueue.enqueue(id);
    return versionDetail(user.id, id);
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
    const { id, size } = Id.extend({ size: z.enum(Object.keys(RENDER_SIZES) as [RenderSize]) }).parse(
      request.params,
    );
    const version = await findVersion(currentUser(request).id, id);
    const file = renderPath(version.id, size);
    if (!(await fileExists(file))) throw notFound('Not rendered yet');
    const versioned = (request.query as Record<string, string>).v === String(version.render_version);
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache')
      .send(createReadStream(file));
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
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', photo.file_size)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(photo.original_filename)}`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(originalPath(photo.storage_key)));
  });
}

type SQLColumn = 'camera_model' | 'lens';

/** Number versions 0, 1, 2… in the given order. */
async function setPositions(tx: Queryable, ids: string[]) {
  await tx.query(sql`
    UPDATE versions v SET position = o.ordinality - 1
    FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS o(id, ordinality)
    WHERE v.id = o.id AND v.position <> o.ordinality - 1`);
}
