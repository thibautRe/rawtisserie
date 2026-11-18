/**
 * Collections (roadmap 8.14): where a photo comes from, in a tree like folders. A photo
 * is in one collection or none (`photos.collection_id`), and its versions with it. Names
 * are unique among siblings, so a path of names finds one: imports (`collection` on an
 * upload) and transfers (`SentVersion.collection`) name the collection they go to, made
 * if it isn't there. The library filters by them, a collection with those under it
 * (`collectionSubtree`, in `whereClause`).
 */
import type { Transaction } from '@databases/pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, sql } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { MAX_COUNT, checkCount } from '../limits.ts';
import { VERSIONS_FROM } from './dto.ts';
import { Target, targetClause } from './query.ts';

type Queryable = Pick<Transaction, 'query'>;

/**
 * Kept out of names: `|` may separate a collection's levels one day, as it does tags'.
 * Names given in the app refuse it; those from files (a folder's) have it replaced.
 */
export const COLLECTION_SEPARATOR = '|';

/** A collection's name: one line, trimmed, without `|`. */
export const CollectionName = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'A collection needs a name')
      .max(200)
      .refine((s) => !s.includes(COLLECTION_SEPARATOR), 'A collection’s name can’t have “|”'),
  );

/** A collection's path (from an import's folders, another instance): `|` becomes `-`. */
export const CollectionPath = z
  .array(
    z
      .string()
      .transform((s) => s.replaceAll(COLLECTION_SEPARATOR, '-'))
      .pipe(CollectionName),
  )
  .min(1)
  .max(20);

/** The deepest a collection may be (the length of its path). */
const MAX_DEPTH = 20;

/** The ids of collections `ids` and of those under them, as a subquery (for `IN`). */
export const collectionSubtree = (ownerId: string, ids: readonly string[]) => sql`(
  WITH RECURSIVE sub AS (
    SELECT id FROM collections WHERE owner_id = ${ownerId} AND id = ANY(${ids}::uuid[])
    UNION SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id
  ) SELECT id FROM sub)`;

/**
 * The collection at `path` (names from the top), made with the ones leading to it if
 * they aren't there. Safe against another request making the same one meanwhile.
 */
export async function collectionAt(tx: Queryable, ownerId: string, path: readonly string[]): Promise<string> {
  let parent: string | null = null;
  let counted = false;
  for (const name of path) {
    const found = await childNamed(tx, ownerId, parent, name);
    if (found) {
      parent = found;
      continue;
    }
    if (!counted) {
      await checkCollectionCount(tx, ownerId, path.length);
      counted = true;
    }
    const [made] = (await tx.query(sql`
      INSERT INTO collections (owner_id, parent_id, name) VALUES (${ownerId}, ${parent}, ${name})
      ON CONFLICT ON CONSTRAINT collections_sibling_names DO NOTHING RETURNING id`)) as { id: string }[];
    parent = made?.id ?? (await childNamed(tx, ownerId, parent, name))!;
  }
  return parent!;
}

async function childNamed(tx: Queryable, ownerId: string, parent: string | null, name: string) {
  const [row] = (await tx.query(sql`
    SELECT id FROM collections
    WHERE owner_id = ${ownerId} AND parent_id IS NOT DISTINCT FROM ${parent}::uuid AND name = ${name}`)) as {
    id: string;
  }[];
  return row?.id ?? null;
}

async function checkCollectionCount(tx: Queryable, ownerId: string, adding = 1) {
  const [{ count }] = (await tx.query(sql`
    SELECT count(*)::int AS count FROM collections WHERE owner_id = ${ownerId}`)) as [{ count: number }];
  checkCount(count + adding - 1, MAX_COUNT.collections, 'collections');
}

/** The path of collection `id` (names from the top), or null if it isn't the owner's. */
export async function collectionPath(tx: Queryable, ownerId: string, id: string): Promise<string[] | null> {
  const rows = (await tx.query(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, name, 0 AS depth FROM collections WHERE owner_id = ${ownerId} AND id = ${id}
      UNION ALL SELECT c.id, c.parent_id, c.name, up.depth + 1 FROM collections c JOIN up ON c.id = up.parent_id
    ) SELECT name FROM up ORDER BY depth DESC`)) as { name: string }[];
  return rows.length ? rows.map((r) => r.name) : null;
}

/** How deep the tree under collection `id` goes (0: nothing under it). */
async function heightOf(tx: Queryable, id: string): Promise<number> {
  const [{ height }] = (await tx.query(sql`
    WITH RECURSIVE sub AS (
      SELECT id, 0 AS depth FROM collections WHERE id = ${id}
      UNION ALL SELECT c.id, sub.depth + 1 FROM collections c JOIN sub ON c.parent_id = sub.id
    ) SELECT max(depth)::int AS height FROM sub`)) as [{ height: number }];
  return height;
}

const nameTaken = (name: string) => conflict(`There’s a collection named “${name}” there already`);

/** Merge collection `from` into `into`: its photos, and those under it (merged too where names meet). */
async function merge(tx: Queryable, ownerId: string, from: string, into: string): Promise<void> {
  await tx.query(sql`UPDATE photos SET collection_id = ${into} WHERE collection_id = ${from}`);
  const children = (await tx.query(sql`
    SELECT id, name FROM collections WHERE parent_id = ${from}`)) as { id: string; name: string }[];
  for (const child of children) {
    const same = await childNamed(tx, ownerId, into, child.name);
    if (same) await merge(tx, ownerId, child.id, same);
    else await tx.query(sql`UPDATE collections SET parent_id = ${into}, updated_at = now() WHERE id = ${child.id}`);
  }
  await tx.query(sql`DELETE FROM collections WHERE id = ${from}`);
}

const Id = z.object({ id: z.uuid() });

export async function collectionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  const find = async (tx: Queryable, ownerId: string, id: string) => {
    const [row] = (await tx.query(sql`
      SELECT id, parent_id, name FROM collections WHERE owner_id = ${ownerId} AND id = ${id} FOR UPDATE`)) as {
      id: string;
      parent_id: string | null;
      name: string;
    }[];
    if (!row) throw notFound('Collection not found');
    return row;
  };
  /** Where `id` can go: an owner's collection, not under itself, the result not too deep. */
  const checkParent = async (tx: Queryable, ownerId: string, id: string | null, parent: string) => {
    const path = await collectionPath(tx, ownerId, parent);
    if (!path) throw notFound('Collection not found');
    if (id) {
      const [inside] = await tx.query(sql`SELECT 1 WHERE ${parent}::uuid IN ${collectionSubtree(ownerId, [id])}`);
      if (inside) throw badRequest('A collection can’t go inside itself');
    }
    const below = id ? await heightOf(tx, id) : 0;
    if (path.length + 1 + below > MAX_DEPTH) throw badRequest(`Collections go ${MAX_DEPTH} levels deep at most`);
  };

  /**
   * Every collection of the user's, with its photos in the library (not those under it)
   * and their latest capture time (else when it was made): the tree is built by the app.
   */
  app.get('/api/collections', async (request) => {
    const user = currentUser(request);
    return db.query(sql`
      SELECT c.id, c.parent_id AS "parentId", c.name, c.created_at AS "createdAt",
        coalesce(s.photos, 0)::int AS photos, coalesce(s.latest, c.created_at) AS latest
      FROM collections c LEFT JOIN (
        SELECT p.collection_id, count(DISTINCT p.id) AS photos, max(p.captured_at) AS latest
        FROM ${VERSIONS_FROM} WHERE p.owner_id = ${user.id} AND v.trashed_at IS NULL GROUP BY 1
      ) s ON s.collection_id = c.id
      WHERE c.owner_id = ${user.id}
      ORDER BY c.name`);
  });

  /** A new collection, at the top or under `parentId`. */
  app.post('/api/collections', async (request, reply) => {
    const user = currentUser(request);
    const { name, parentId } = z
      .object({ name: CollectionName, parentId: z.uuid().nullable().default(null) })
      .parse(request.body);
    const made = await db.tx(async (tx) => {
      if (parentId) await checkParent(tx, user.id, null, parentId);
      await checkCollectionCount(tx, user.id);
      if (await childNamed(tx, user.id, parentId, name)) throw nameTaken(name);
      const [row] = (await tx.query(sql`
        INSERT INTO collections (owner_id, parent_id, name) VALUES (${user.id}, ${parentId}, ${name})
        RETURNING id, parent_id AS "parentId", name, created_at AS "createdAt"`)) as Record<string, unknown>[];
      return row!;
    });
    return reply.code(201).send({ ...made, photos: 0, latest: made.createdAt });
  });

  /** Rename it, or move it under another one (`parentId`, null for the top). */
  app.patch('/api/collections/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const patch = z
      .object({ name: CollectionName.optional(), parentId: z.uuid().nullable().optional() })
      .parse(request.body);
    await db.tx(async (tx) => {
      const row = await find(tx, user.id, id);
      const name = patch.name ?? row.name;
      const parent = patch.parentId === undefined ? row.parent_id : patch.parentId;
      if (parent && parent !== row.parent_id) await checkParent(tx, user.id, id, parent);
      const other = await childNamed(tx, user.id, parent, name);
      if (other && other !== id) throw nameTaken(name);
      await tx.query(sql`
        UPDATE collections SET name = ${name}, parent_id = ${parent}, updated_at = now() WHERE id = ${id}`);
    });
    return { ok: true };
  });

  /** Merge it into another: its photos and the collections under it go there, and it's gone. */
  app.post('/api/collections/:id/merge', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { into } = z.object({ into: z.uuid() }).parse(request.body);
    if (into === id) throw badRequest('That’s the same collection');
    await db.tx(async (tx) => {
      await find(tx, user.id, id);
      const target = await find(tx, user.id, into);
      const [inside] = await tx.query(sql`SELECT 1 WHERE ${into}::uuid IN ${collectionSubtree(user.id, [id])}`);
      if (inside) throw badRequest('A collection can’t be merged into one inside it');
      const path = (await collectionPath(tx, user.id, target.id))!;
      if (path.length + (await heightOf(tx, id)) > MAX_DEPTH)
        throw badRequest(`Collections go ${MAX_DEPTH} levels deep at most`);
      await merge(tx, user.id, id, into);
    });
    return { ok: true };
  });

  /** Delete it and those under it: their photos stay in the library, in no collection. */
  app.delete('/api/collections/:id', async (request, reply) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const [gone] = await db.query(sql`DELETE FROM collections WHERE owner_id = ${user.id} AND id = ${id} RETURNING id`);
    if (!gone) throw notFound('Collection not found');
    return reply.code(204).send();
  });

  /**
   * Put the photos of some versions (a `Target`) in a collection (`collectionId`, null for
   * none). Answers how many photos changed.
   */
  app.post('/api/versions/collection', async (request) => {
    const user = currentUser(request);
    const { collectionId, ...target } = z.object({ collectionId: z.uuid().nullable() }).and(Target).parse(request.body);
    if (collectionId && !(await collectionPath(db, user.id, collectionId))) throw notFound('Collection not found');
    const moved = await db.query(sql`
      UPDATE photos SET collection_id = ${collectionId}, updated_at = now()
      WHERE id IN (SELECT v.photo_id FROM ${VERSIONS_FROM} WHERE ${targetClause(user.id, target)})
        AND collection_id IS DISTINCT FROM ${collectionId}::uuid
      RETURNING id`);
    return { count: moved.length };
  });
}
