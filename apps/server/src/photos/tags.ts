/**
 * Tags are paths: levels separated by `|`, as XMP's `lr:hierarchicalSubject` has them
 * (`People|Gwen`, shown as People › Gwen). A version's tags are its `tags` array; a tag
 * counts under each of its ancestors (filters, counts), without them being stored.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, sql } from '../db.ts';
import { badRequest } from '../errors.ts';
import { VERSIONS_FROM } from './dto.ts';
import { PhotoFilters, whereClause } from './query.ts';

export const SEPARATOR = '|';

/** A tag as typed: its levels trimmed, empty ones dropped. */
export const normalizeTag = (tag: string) =>
  tag
    .split(SEPARATOR)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(SEPARATOR);

export const Tag = z
  .string()
  .transform(normalizeTag)
  .pipe(
    z
      .string()
      .min(1)
      .max(300)
      .refine((t) => t.split(SEPARATOR).every((l) => l.length <= 100), 'A tag level is at most 100 characters'),
  );

/**
 * Each level of tag `t` (in scope, from `unnest(… ) t`) as `n`: `People`, `People|Gwen`.
 * Use as a lateral join.
 */
export const TAG_LEVELS = sql`LATERAL (
  SELECT array_to_string((string_to_array(t, '|'))[1:i], '|') AS n
  FROM generate_series(1, cardinality(string_to_array(t, '|'))) i
) levels`;

/**
 * A keyboard shortcut, as the app records it: a sequence of key presses (two for
 * Ctrl+Alt+O, Ctrl+Alt+A), each by its physical key (`code`, as the layout doesn't
 * matter) and what it showed (`key`, for display).
 */
export const Shortcut = z
  .array(
    z.object({
      code: z.string().min(1).max(40),
      key: z.string().max(40),
      ctrl: z.boolean(),
      alt: z.boolean(),
      shift: z.boolean(),
      meta: z.boolean(),
    }),
  )
  .min(1)
  .max(4);

/** Tag `from` or one under it, for a tag `t` in scope (SQL). */
const under = (from: string) => sql`(t = ${from} OR starts_with(t, ${`${from}${SEPARATOR}`}))`;
/** `t` (under `from`) moved under `to`. */
// Characters counted by Postgres (JavaScript counts UTF-16 units: an emoji is two).
const moved = (from: string, to: string) => sql`${to} || substr(t, length(${from}) + 1)`;

/**
 * The tag manager's routes. Renaming a tag renames those under it too (`People` to
 * `Family` makes `People|Gwen` `Family|Gwen`); renaming onto an existing tag merges
 * them; moving is renaming its path. Deleting removes the tags under it too. Both apply
 * to every version, trashed ones included, so nothing comes back with a restore.
 */
export async function tagRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** Every tag in the user's library, most used first (then those of the tag manager no photo has): for completing tags as they're typed. */
  app.get('/api/tags', async (request) => {
    const user = currentUser(request);
    const where = whereClause(user.id, PhotoFilters.parse({}));
    return db.query(sql`
      SELECT value, max(count)::int AS count FROM (
        SELECT t AS value, count(*) AS count FROM ${VERSIONS_FROM}, unnest(v.tags) t WHERE ${where} GROUP BY 1
        UNION ALL SELECT tag, 0 FROM user_tags WHERE owner_id = ${user.id}
      ) x GROUP BY 1 ORDER BY 2 DESC, 1`);
  });

  /**
   * For the tag manager: every level of every tag with the photos under it (in the
   * library, and only in the trash), and the user's own tags with their shortcuts.
   */
  app.get('/api/tags/manage', async (request) => {
    const user = currentUser(request);
    const [levels, own] = await Promise.all([
      db.query(sql`
        SELECT n AS value,
          count(DISTINCT v.id) FILTER (WHERE v.trashed_at IS NULL)::int AS photos,
          count(DISTINCT v.id) FILTER (WHERE v.trashed_at IS NOT NULL)::int AS trashed
        FROM ${VERSIONS_FROM}, unnest(v.tags) t, ${TAG_LEVELS}
        WHERE p.owner_id = ${user.id} GROUP BY 1`),
      db.query(sql`SELECT tag, shortcut FROM user_tags WHERE owner_id = ${user.id} ORDER BY tag`),
    ]);
    return { levels, own };
  });

  /** A tag no photo has yet (to give it a shortcut, or to have it completed). */
  app.post('/api/tags', async (request) => {
    const { tag } = z.object({ tag: Tag }).parse(request.body);
    await db.query(sql`
      INSERT INTO user_tags (owner_id, tag) VALUES (${currentUser(request).id}, ${tag}) ON CONFLICT DO NOTHING`);
    return { tag };
  });

  /** Rename (or move, or merge) `from` and the tags under it to `to`. Answers how many versions changed. */
  app.post('/api/tags/rename', async (request) => {
    const { from, to } = z.object({ from: Tag, to: Tag }).parse(request.body);
    if (from === to) throw badRequest('That’s its name already');
    if (to.startsWith(`${from}${SEPARATOR}`)) throw badRequest('A tag can’t go under itself');
    const user = currentUser(request);
    const changed = await db.tx(async (tx) => {
      const rows = await tx.query(sql`
        UPDATE versions v SET updated_at = now(), tags = ARRAY(
          SELECT DISTINCT CASE WHEN ${under(from)} THEN ${moved(from, to)} ELSE t END FROM unnest(v.tags) t ORDER BY 1)
        FROM photos p
        WHERE p.id = v.photo_id AND p.owner_id = ${user.id}
          AND EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE ${under(from)})
        RETURNING v.id`);
      // Merged onto a tag of the manager: it keeps its shortcut, else gets this one's.
      await tx.query(sql`
        WITH gone AS (
          DELETE FROM user_tags u WHERE u.owner_id = ${user.id}
            AND (u.tag = ${from} OR starts_with(u.tag, ${`${from}${SEPARATOR}`}))
          RETURNING u.tag AS t, u.shortcut, u.created_at
        )
        INSERT INTO user_tags (owner_id, tag, shortcut, created_at)
        SELECT ${user.id}, ${moved(from, to)}, shortcut, created_at FROM gone
        ON CONFLICT (owner_id, tag) DO UPDATE SET shortcut = COALESCE(user_tags.shortcut, EXCLUDED.shortcut)`);
      return rows.length;
    });
    return { versions: changed };
  });

  /** Delete `tag` and the tags under it, from every version. Answers how many versions changed. */
  app.post('/api/tags/delete', async (request) => {
    const { tag } = z.object({ tag: Tag }).parse(request.body);
    const user = currentUser(request);
    const changed = await db.tx(async (tx) => {
      const rows = await tx.query(sql`
        UPDATE versions v SET updated_at = now(),
          tags = ARRAY(SELECT t FROM unnest(v.tags) t WHERE NOT ${under(tag)} ORDER BY 1)
        FROM photos p
        WHERE p.id = v.photo_id AND p.owner_id = ${user.id}
          AND EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE ${under(tag)})
        RETURNING v.id`);
      await tx.query(sql`
        DELETE FROM user_tags WHERE owner_id = ${user.id}
          AND (tag = ${tag} OR starts_with(tag, ${`${tag}${SEPARATOR}`}))`);
      return rows.length;
    });
    return { versions: changed };
  });

  /** Set (or, with null, remove) the shortcut toggling `tag`. */
  app.put('/api/tags/shortcut', async (request) => {
    const { tag, shortcut } = z.object({ tag: Tag, shortcut: Shortcut.nullable() }).parse(request.body);
    const user = currentUser(request);
    await db.query(sql`
      INSERT INTO user_tags (owner_id, tag, shortcut) VALUES (${user.id}, ${tag}, ${shortcut && JSON.stringify(shortcut)}::jsonb)
      ON CONFLICT (owner_id, tag) DO UPDATE SET shortcut = EXCLUDED.shortcut`);
    return { tag, shortcut };
  });
}
