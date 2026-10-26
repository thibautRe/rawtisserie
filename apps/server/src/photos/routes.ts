import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeEditParams } from '@rawtisserie/pipeline';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, photos, sql } from '../db.ts';
import { notFound } from '../errors.ts';
import type Photos from '../__generated__/photos.ts';
import type { RenderQueue } from '../render/queue.ts';
import { photoDetailDto, photoDto } from './dto.ts';
import { PhotoFilters, PhotoListQuery, SORTS, whereClause } from './query.ts';
import {
  RAW_EXTENSIONS,
  RENDER_SIZES,
  commitUpload,
  deletePhotoFiles,
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

/** Fields a user may edit. Metadata corrections live in the database; originals are never modified. */
const PhotoPatch = z
  .object({
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

const COLUMNS: Record<keyof z.infer<typeof PhotoPatch>, keyof Photos> = {
  title: 'title',
  description: 'description',
  rating: 'rating',
  flag: 'flag',
  colorLabel: 'color_label',
  tags: 'tags',
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

function toColumns(patch: z.infer<typeof PhotoPatch>): Partial<Photos> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[COLUMNS[key as keyof typeof COLUMNS]] = value;
  }
  return out as Partial<Photos>;
}

const Bulk = z.object({
  ids: z.array(z.uuid()).min(1).max(5000),
  patch: PhotoPatch.pick({ rating: true, flag: true, colorLabel: true }).extend({
    addTags: z.array(z.string().trim().min(1).max(100)).optional(),
    removeTags: z.array(z.string().trim().min(1).max(100)).optional(),
  }),
});

export async function photoRoutes(app: FastifyInstance, { renderQueue }: { renderQueue: RenderQueue }) {
  app.addHook('preHandler', requireUser);

  const findOwned = async (ownerId: string, id: string) => {
    const photo = await photos(db).findOne({ id, owner_id: ownerId });
    if (!photo) throw notFound('Photo not found');
    return photo;
  };

  app.get('/api/photos', async (request) => {
    const user = currentUser(request);
    const q = PhotoListQuery.parse(request.query);
    const where = whereClause(user.id, q);
    const [rows, [{ count }]] = await Promise.all([
      db.query(sql`SELECT * FROM photos WHERE ${where} ORDER BY ${SORTS[q.sort]} LIMIT ${q.limit} OFFSET ${q.offset}`),
      db.query(sql`SELECT count(*)::int AS count FROM photos WHERE ${where}`),
    ]);
    return { photos: (rows as Photos[]).map(photoDto), total: count as number };
  });

  /** Distinct values (with counts) to populate the filter sidebar. */
  app.get('/api/photos/facets', async (request) => {
    const user = currentUser(request);
    const filters = PhotoFilters.parse(request.query);
    const where = whereClause(user.id, filters);
    const facet = (column: SQLColumn) =>
      db.query(sql`
        SELECT ${sql.ident(column)} AS value, count(*)::int AS count FROM photos
        WHERE ${where} AND ${sql.ident(column)} IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`);
    const [cameras, lenses, tags, ratings, ranges] = await Promise.all([
      facet('camera_model'),
      facet('lens'),
      db.query(sql`
        SELECT t AS value, count(*)::int AS count FROM photos, unnest(tags) t
        WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 200`),
      db.query(sql`SELECT rating AS value, count(*)::int AS count FROM photos WHERE ${where} GROUP BY 1 ORDER BY 1`),
      db.query(sql`
        SELECT count(*)::int AS total, min(captured_at) AS "capturedFrom", max(captured_at) AS "capturedTo",
          min(iso) AS "isoMin", max(iso) AS "isoMax", min(focal_length) AS "focalMin", max(focal_length) AS "focalMax",
          min(f_number) AS "apertureMin", max(f_number) AS "apertureMax"
        FROM photos WHERE ${where}`),
    ]);
    return { cameras, lenses, tags, ratings, ranges: ranges[0] };
  });

  app.get('/api/photos/:id', async (request) => {
    const { id } = Id.parse(request.params);
    return photoDetailDto(await findOwned(currentUser(request).id, id));
  });

  app.patch('/api/photos/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const patch = PhotoPatch.parse(request.body);
    await findOwned(user.id, id);
    const [updated] = await photos(db).update(
      { id, owner_id: user.id },
      { ...toColumns(patch), updated_at: new Date() },
    );
    return photoDetailDto(updated!);
  });

  app.post('/api/photos/bulk', async (request) => {
    const user = currentUser(request);
    const { ids, patch } = Bulk.parse(request.body);
    const { addTags, removeTags, ...simple } = patch;
    const sets = [sql`updated_at = now()`];
    for (const [key, value] of Object.entries(toColumns(simple))) sets.push(sql`${sql.ident(key)} = ${value}`);
    if (addTags?.length) sets.push(sql`tags = ARRAY(SELECT DISTINCT t FROM unnest(tags || ${addTags}::text[]) t ORDER BY 1)`);
    if (removeTags?.length) sets.push(sql`tags = ARRAY(SELECT unnest(tags) EXCEPT SELECT unnest(${removeTags}::text[]))`);
    const rows = await db.query(sql`
      UPDATE photos SET ${sql.join(sets, sql`, `)}
      WHERE owner_id = ${user.id} AND id = ANY(${ids}) RETURNING *`);
    return { photos: (rows as Photos[]).map(photoDto) };
  });

  app.post('/api/photos/delete', async (request) => {
    const user = currentUser(request);
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(5000) }).parse(request.body);
    const rows = (await db.query(sql`
      DELETE FROM photos WHERE owner_id = ${user.id} AND id = ANY(${ids}) RETURNING id, storage_key`)) as Photos[];
    await Promise.all(rows.map(deletePhotoFiles));
    return { deleted: rows.map((r) => r.id) };
  });

  app.delete('/api/photos/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const photo = await findOwned(user.id, id);
    await photos(db).delete({ id, owner_id: user.id });
    await deletePhotoFiles(photo);
    return { deleted: [id] };
  });

  /** Upload one or more RAW files (multipart/form-data, field name `files`). */
  app.post('/api/photos', async (request, reply) => {
    const user = currentUser(request);
    const created: ReturnType<typeof photoDto>[] = [];
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
      const [photo] = await photos(db).insert({
        id,
        owner_id: user.id,
        original_filename: filename,
        storage_key: storageKey,
        file_size: upload.size,
        sha256: upload.sha256,
      });
      created.push(photoDto(photo!));
      renderQueue.enqueue(id);
    }
    return reply.code(created.length ? 201 : 200).send({ created, skipped });
  });

  /** Save the development recipe; previews are re-rendered in the background. */
  app.put('/api/photos/:id/edit', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { params } = z.object({ params: z.unknown() }).parse(request.body);
    await findOwned(user.id, id);
    const [updated] = await photos(db).update(
      { id, owner_id: user.id },
      {
        edit_params: params === null ? null : normalizeEditParams(params),
        edited_at: params === null ? null : new Date(),
        render_status: 'pending',
        updated_at: new Date(),
      },
    );
    renderQueue.enqueue(id);
    return photoDetailDto(updated!);
  });

  app.post('/api/photos/:id/rerender', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    await findOwned(user.id, id);
    await photos(db).update({ id, owner_id: user.id }, { render_status: 'pending', render_error: null });
    renderQueue.enqueue(id);
    return { ok: true };
  });

  app.get('/api/photos/:id/original', async (request, reply) => {
    const { id } = Id.parse(request.params);
    const photo = await findOwned(currentUser(request).id, id);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', photo.file_size)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(photo.original_filename)}`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(originalPath(photo.storage_key)));
  });

  app.get('/api/photos/:id/render/:size', async (request, reply) => {
    const { id, size } = Id.extend({ size: z.enum(Object.keys(RENDER_SIZES) as [RenderSize]) }).parse(
      request.params,
    );
    const photo = await findOwned(currentUser(request).id, id);
    const file = renderPath(photo.id, size);
    if (!(await fileExists(file))) throw notFound('Not rendered yet');
    const versioned = (request.query as Record<string, string>).v === String(photo.render_version);
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache')
      .send(createReadStream(file));
  });
}

type SQLColumn = 'camera_model' | 'lens';
