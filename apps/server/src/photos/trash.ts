/**
 * The trash (roadmap 7.3). Deleting from the library moves versions here (`trashed_at`):
 * they can be restored for `TRASH_DAYS`, then they're deleted for good, as they are when
 * deleted from the trash. Deleting a version for good removes its history and renders;
 * a photo left without versions goes too, with its original file (its hash is kept in
 * `deleted_originals`, so importing it again asks first). A photo's original
 * counts towards the quota while any of its versions exists, trashed or not.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { SQLQuery } from '@databases/pg';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, sql } from '../db.ts';
import type Photos from '../__generated__/photos.ts';
import type Versions from '../__generated__/versions.ts';
import { VERSIONS_FROM, VERSION_COLUMNS, type VersionRow, versionDto } from './dto.ts';
import { deleteOriginal, deleteRenders } from './storage.ts';

export const TRASH_DAYS = 30;
const DAY = 86_400_000;
/** How often trash older than `TRASH_DAYS` is looked for. */
const PURGE_EVERY = 3600_000;

// Many: undoing a selection by filter moved to the trash (roadmap 8.13) restores all of it.
const Ids = z.object({ ids: z.array(z.uuid()).min(1).max(100_000) });
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Trashed versions `v` (joined with their photo `p`) matching `where`. */
const trashed = (where: SQLQuery) => sql`v.trashed_at IS NOT NULL AND ${where}`;

/**
 * Delete trashed versions matching `where` for good, then the photos left without
 * versions, then their files. Files that can't be deleted are logged and left behind:
 * nothing refers to them any more.
 */
export async function deleteForever(where: SQLQuery, log?: FastifyBaseLogger): Promise<string[]> {
  const { deleted, orphans } = await db.tx(async (tx) => {
    const deleted = (await tx.query(sql`
      DELETE FROM versions v USING photos p
      WHERE p.id = v.photo_id AND ${trashed(where)}
      RETURNING v.id, v.photo_id`)) as Pick<Versions, 'id' | 'photo_id'>[];
    const orphans = (await tx.query(sql`
      DELETE FROM photos p WHERE p.id = ANY(${[...new Set(deleted.map((d) => d.photo_id))]})
        AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.photo_id = p.id)
      RETURNING storage_key, owner_id, sha256`)) as Pick<Photos, 'storage_key' | 'owner_id' | 'sha256'>[];
    // Only their hash is remembered: imports skip them unless asked (`photos/routes.ts`).
    if (orphans.length)
      await tx.query(sql`
        INSERT INTO deleted_originals (owner_id, sha256)
        SELECT * FROM unnest(${orphans.map((o) => o.owner_id)}::uuid[], ${orphans.map((o) => o.sha256)}::text[])
        ON CONFLICT DO NOTHING`);
    return { deleted, orphans };
  });
  const results = await Promise.allSettled([
    ...deleted.map((d) => deleteRenders(d.id)),
    ...orphans.map((p) => deleteOriginal(p.storage_key)),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') log?.warn({ err: r.reason }, 'could not delete a file of a deleted photo');
  }
  return deleted.map((d) => d.id);
}

/** Delete what has been in the trash longer than `TRASH_DAYS`. */
export const purgeTrash = (log?: FastifyBaseLogger) =>
  deleteForever(sql`v.trashed_at < now() - ${TRASH_DAYS} * interval '1 day'`, log);

/** Purge the trash now, then every hour. */
export function startTrashPurge(log: FastifyBaseLogger): () => void {
  const run = () =>
    purgeTrash(log)
      .then((ids) => ids.length && log.info({ versions: ids.length }, 'deleted old trash'))
      .catch((err) => log.error({ err }, 'could not purge the trash'));
  void run();
  const timer = setInterval(run, PURGE_EVERY);
  timer.unref();
  return () => clearInterval(timer);
}

export async function trashRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /**
   * The user's trash, most recently trashed first. `photoInTrash`: none of the photo's
   * versions is left in the library, so deleting all of its trashed ones deletes the
   * original. `bytes`: the originals emptying the trash would free.
   */
  app.get('/api/trash', async (request) => {
    const owner = sql`p.owner_id = ${currentUser(request).id}`;
    const { limit, offset } = Page.parse(request.query);
    const [rows, [summary]] = await Promise.all([
      db.query(sql`
        SELECT ${VERSION_COLUMNS},
          NOT EXISTS (SELECT 1 FROM versions s WHERE s.photo_id = v.photo_id AND s.trashed_at IS NULL) AS photo_in_trash,
          (SELECT count(*)::int FROM versions s WHERE s.photo_id = v.photo_id) AS all_count,
          (SELECT count(*)::int + 1 FROM versions s
            WHERE s.photo_id = v.photo_id AND (s.position, s.id) < (v.position, v.id)) AS all_index
        FROM ${VERSIONS_FROM} WHERE ${trashed(owner)}
        ORDER BY v.trashed_at DESC, p.captured_at DESC NULLS LAST, p.original_filename DESC, v.position, v.id
        LIMIT ${limit} OFFSET ${offset}`) as Promise<
        (VersionRow & { photo_in_trash: boolean; all_count: number; all_index: number })[]
      >,
      db.query(sql`
        SELECT
          (SELECT count(*)::int FROM ${VERSIONS_FROM} WHERE ${trashed(owner)}) AS total,
          (SELECT coalesce(sum(p.file_size), 0)::bigint FROM photos p
            WHERE ${owner} AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.photo_id = p.id AND v.trashed_at IS NULL))
            AS bytes`),
    ]);
    return {
      versions: rows.map((r) => ({
        ...versionDto(r),
        // Numbered among all of the photo's versions, so trashed ones are told apart.
        versionIndex: r.all_index,
        versionCount: r.all_count,
        trashedAt: r.trashed_at!.toISOString(),
        deleteAt: new Date(r.trashed_at!.getTime() + TRASH_DAYS * DAY).toISOString(),
        photoInTrash: r.photo_in_trash,
      })),
      total: summary.total as number,
      bytes: summary.bytes as number,
      days: TRASH_DAYS,
    };
  });

  /** Put versions back in the library, as they were. */
  app.post('/api/trash/restore', async (request) => {
    const { ids } = Ids.parse(request.body);
    const restored = await db.query(sql`
      UPDATE versions v SET trashed_at = NULL, updated_at = now()
      FROM photos p
      WHERE p.id = v.photo_id AND ${trashed(sql`p.owner_id = ${currentUser(request).id} AND v.id = ANY(${ids})`)}
      RETURNING v.id`);
    return { restored: restored.map((r) => r.id as string) };
  });

  app.post('/api/trash/delete', async (request) => {
    const { ids } = Ids.parse(request.body);
    const where = sql`p.owner_id = ${currentUser(request).id} AND v.id = ANY(${ids})`;
    return { deleted: await deleteForever(where, request.log) };
  });

  app.post('/api/trash/empty', async (request) => ({
    deleted: await deleteForever(sql`p.owner_id = ${currentUser(request).id}`, request.log),
  }));
}
