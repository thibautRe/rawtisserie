/**
 * Uploads in chunks (roadmap 8.2), so that an interrupted one resumes where it stopped
 * instead of sending a 60 MB file again. An upload is created with what the file is
 * (`POST /api/uploads`: checked for its type, size and the quota before any byte is
 * sent), filled in order (`PUT /api/uploads/:id`, each chunk at the offset the server
 * has, which `GET` tells), then taken in like `POST /api/photos` (`…/complete`). The
 * bytes stay on local disk (`STORAGE_DIR/tmp/uploads`) until then; uploads left
 * untouched for `ABANDONED_AFTER` are deleted.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { fits, quotaExceeded, storageUsage } from '../accounts/quota.ts';
import { currentUser, requireUser } from '../auth/routes.ts';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { db, sql, uploads } from '../db.ts';
import type Uploads from '../__generated__/uploads.ts';
import type Versions from '../__generated__/versions.ts';
import type { RenderQueue } from '../render/queue.ts';
import { VERSIONS_FROM, VERSION_COLUMNS, type VersionRow, versionDto } from './dto.ts';
import { type SkipKind, UNSUPPORTED, ingestReceived, isSupportedName, versionFor } from './ingest.ts';
import { Tag } from './tags.ts';
import { MAX_COUNT, checkCount } from '../limits.ts';

/** The most a chunk may hold (the app sends 8 MiB). */
export const MAX_CHUNK = 16 * 1024 * 1024;
const ABANDONED_AFTER = 24 * 3600_000;
const SWEEP_EVERY = 3600_000;

const uploadsDir = () => path.join(config.storageDir, 'tmp', 'uploads');
const fileOf = (id: string) => path.join(uploadsDir(), id);
/** Bytes received so far. */
const received = async (id: string) => (await stat(fileOf(id)).catch(() => null))?.size ?? null;

/** An error answered with more than its message (`offset`, for the app to resume from). */
class UploadError extends HttpError {
  body: Record<string, unknown>;
  constructor(statusCode: number, message: string, body: Record<string, unknown> = {}) {
    super(statusCode, message);
    this.body = body;
  }
}

/** Uploads with a chunk being written: one at a time each. */
const writing = new Set<string>();

export async function uploadRoutes(app: FastifyInstance, { renderQueue }: { renderQueue: RenderQueue }) {
  app.addHook('preHandler', requireUser);
  // Chunks are read as a stream, counted as they come (`MAX_CHUNK`).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  const find = async (ownerId: string, id: string): Promise<Uploads> => {
    const row = z.uuid().safeParse(id).success ? await uploads(db).findOne({ id, owner_id: ownerId }) : null;
    if (!row) throw new UploadError(404, 'Upload not found');
    return row;
  };
  const fail = (err: unknown, reply: FastifyReply) => {
    if (err instanceof HttpError)
      return reply.code(err.statusCode).send({ error: err.message, ...(err instanceof UploadError && err.body) });
    throw err;
  };

  /**
   * Start an upload: `{ id }`, or `{ skipped }` (as `POST /api/photos` reports it) when
   * the file can't be taken: not a RAW file, too large, or over the quota.
   */
  app.post('/api/uploads', async (request, reply) => {
    const user = currentUser(request);
    const body = z
      .object({
        name: z.string().trim().min(1).max(500),
        size: z.number().int().min(1),
        /** The file's modification time (ms since the epoch), as the browser saw it. */
        modified: z.number().int().optional(),
        import: z.uuid().optional(),
        allowDeleted: z.boolean().optional(),
        /** What the file says about itself (its XMP, sidecars, its JPEG): for the version. */
        tags: z.array(Tag).max(500).optional(),
        rating: z.number().int().min(0).max(5).optional(),
        label: z.enum(['red', 'yellow', 'green', 'blue', 'purple']).optional(),
        flag: z.enum(['picked', 'rejected']).optional(),
      })
      .parse(request.body);
    const filename = path.basename(body.name);
    const skip = (kind: SkipKind, reason: string) => reply.send({ skipped: { filename, kind, reason } });
    if (!isSupportedName(filename)) return skip('unsupported', UNSUPPORTED);
    if (body.size > config.maxUploadBytes) return skip('tooLarge', 'File too large');
    // Uploads not completed yet count too: they're on this server's disk already, or will be.
    const [open] = (await db.query(sql`
      SELECT count(*)::int AS count, coalesce(sum(size), 0)::bigint AS bytes
      FROM uploads WHERE owner_id = ${user.id}`)) as { count: number; bytes: number }[];
    checkCount(open!.count, MAX_COUNT.openUploads, 'uploads in progress');
    const usage = await storageUsage(db, user.id);
    // Files only in the trash are counted already, but that's only known once hashed:
    // `complete` checks again, and such an upload over the quota is taken in then.
    if (!fits(usage, Number(open!.bytes) + body.size)) return skip('quota', quotaExceeded(usage));
    if (body.import)
      await db.query(
        sql`INSERT INTO imports (owner_id, id) VALUES (${user.id}, ${body.import}) ON CONFLICT DO NOTHING`,
      );
    const [row] = await uploads(db).insert({
      owner_id: user.id,
      filename,
      size: body.size,
      file_modified_at: body.modified === undefined ? null : new Date(body.modified),
      import_id: body.import ?? null,
      allow_deleted: body.allowDeleted ?? false,
      tags: [...new Set(body.tags ?? [])],
      rating: body.rating ?? 0,
      color_label: body.label ?? null,
      flag: body.flag ?? null,
    });
    await mkdir(uploadsDir(), { recursive: true });
    await writeFile(fileOf(row!.id), '');
    return reply.code(201).send({ id: row!.id, offset: 0 });
  });

  /** How much of it the server has. */
  app.get('/api/uploads/:id', async (request, reply) => {
    try {
      const row = await find(currentUser(request).id, (request.params as { id: string }).id);
      return { offset: (await received(row.id)) ?? 0, size: row.size };
    } catch (err) {
      return fail(err, reply);
    }
  });

  /**
   * The next chunk, at `Upload-Offset` (what the server has: otherwise 409 with the
   * right `offset`). Answers the new offset. A chunk cut short keeps what arrived.
   */
  app.put('/api/uploads/:id', async (request, reply) => {
    const stream = request.body as Readable;
    try {
      const row = await find(currentUser(request).id, (request.params as { id: string }).id);
      if (writing.has(row.id))
        throw new UploadError(409, 'A chunk is being written', { offset: await received(row.id) });
      writing.add(row.id);
      try {
        const offset = Number(request.headers['upload-offset']);
        const have = await received(row.id);
        if (have === null) throw new UploadError(404, 'Upload not found');
        if (offset !== have) throw new UploadError(409, 'Not at the end of what was received', { offset: have });
        // Refused before reading it, when it says how long it is (browsers do).
        const declared = Number(request.headers['content-length'] ?? 0);
        if (declared > MAX_CHUNK || have + declared > row.size) throw new UploadError(413, 'Too much data');
        let length = 0;
        stream.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_CHUNK || have + length > row.size) stream.destroy(new UploadError(413, 'Too much data'));
        });
        await pipeline(stream, createWriteStream(fileOf(row.id), { flags: 'a' }));
        await uploads(db).update({ id: row.id }, { updated_at: new Date() });
        return { offset: have + length };
      } finally {
        writing.delete(row.id);
      }
    } catch (err) {
      stream.resume();
      if (err instanceof HttpError) return fail(err, reply);
      throw err;
    }
  });

  /** Take it in, once it's all there: answers like `POST /api/photos`, for this file. */
  app.post('/api/uploads/:id/complete', async (request, reply) => {
    const user = currentUser(request);
    try {
      const row = await find(user.id, (request.params as { id: string }).id);
      if (writing.has(row.id))
        throw new UploadError(409, 'A chunk is being written', { offset: await received(row.id) });
      const have = await received(row.id);
      if (have !== row.size) throw new UploadError(409, 'Not all of it was received', { offset: have ?? 0 });
      writing.add(row.id);
      try {
        const hash = createHash('sha256');
        await pipeline(createReadStream(fileOf(row.id)), hash);
        // Gone from the table first: the file is moved (or removed) by taking it in.
        await uploads(db).delete({ id: row.id });
        // Checked like the versions' columns when stored.
        const columns: Partial<Versions> = {
          import_id: row.import_id,
          tags: row.tags,
          rating: row.rating,
          color_label: row.color_label as Versions['color_label'],
          flag: row.flag as Versions['flag'],
        };
        const result = await ingestReceived(
          user.id,
          row.filename,
          { tempPath: fileOf(row.id), size: row.size, sha256: hash.digest('hex') },
          { allowDeleted: row.allow_deleted, version: columns, modifiedAt: row.file_modified_at },
        );
        const taken = await versionFor(result, row.filename, columns);
        if ('skipped' in taken) return { created: [], skipped: [taken.skipped] };
        const [version] = (await db.query(sql`
          SELECT ${VERSION_COLUMNS} FROM ${VERSIONS_FROM} WHERE v.id = ${taken.versionId}`)) as VersionRow[];
        renderQueue.enqueue(taken.versionId);
        return reply.code(201).send({ created: [versionDto(version!)], skipped: [] });
      } finally {
        writing.delete(row.id);
      }
    } catch (err) {
      return fail(err, reply);
    }
  });

  /** Give up on it. */
  app.delete('/api/uploads/:id', async (request, reply) => {
    try {
      const row = await find(currentUser(request).id, (request.params as { id: string }).id);
      if (writing.has(row.id)) throw new UploadError(409, 'A chunk is being written');
      await uploads(db).delete({ id: row.id });
      await rm(fileOf(row.id), { force: true });
      return reply.code(204).send();
    } catch (err) {
      return fail(err, reply);
    }
  });
}

/**
 * Delete uploads untouched for `ABANDONED_AFTER`, and files in the uploads folder that
 * no upload refers to (their user deleted, or the server stopped while taking one in).
 */
export async function sweepUploads(log?: FastifyBaseLogger): Promise<number> {
  const old = (await db.query(sql`
    DELETE FROM uploads WHERE updated_at < now() - ${ABANDONED_AFTER} * interval '1 millisecond'
    RETURNING id`)) as { id: string }[];
  const live = new Set(((await db.query(sql`SELECT id FROM uploads`)) as { id: string }[]).map((r) => r.id));
  let removed = 0;
  for (const name of await readdir(uploadsDir()).catch(() => [] as string[])) {
    if (live.has(name)) continue;
    const info = await stat(path.join(uploadsDir(), name)).catch(() => null);
    // A file just created, whose row isn't visible yet, is left alone.
    if (!info || Date.now() - info.mtimeMs < ABANDONED_AFTER) continue;
    await rm(path.join(uploadsDir(), name), { force: true }).catch((err) =>
      log?.warn({ err }, 'could not delete an abandoned upload'),
    );
    removed++;
  }
  for (const { id } of old) await rm(fileOf(id), { force: true }).catch(() => {});
  return removed + old.length;
}

/** Sweep abandoned uploads now, then every hour. */
export function startUploadSweep(log: FastifyBaseLogger): () => void {
  const run = () =>
    sweepUploads(log)
      .then((n) => n && log.info({ uploads: n }, 'deleted abandoned uploads'))
      .catch((err) => log.error({ err }, 'could not sweep uploads'));
  void run();
  const timer = setInterval(run, SWEEP_EVERY);
  timer.unref();
  return () => clearInterval(timer);
}
