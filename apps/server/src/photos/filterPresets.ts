/**
 * Saved library filters (filter presets): a name for a set of filters, the library's
 * query string without its sort. Applied in the browser like a module preset; tag
 * renames and deletions follow into them (`followTagRename`).
 */
import type { Queryable } from '@databases/pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, sql } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type FilterPresets from '../__generated__/filter_presets.ts';
import { PhotoFilters } from './query.ts';
import { SEPARATOR } from './tags.ts';

const Id = z.object({ id: z.uuid() });
const Name = z.string().trim().min(1).max(200);
const UNIQUE_VIOLATION = '23505';

export interface FilterPreset {
  id: string;
  name: string;
  /** The filters, as the library's query string (no sort). */
  query: string;
}

const dto = (row: FilterPresets): FilterPreset => ({ id: row.id, name: row.name, query: row.query });

/** The filters of a library query string, checked: only the filters' keys, in a stable order. */
export function normalizeFilterQuery(query: string): string {
  const params = new URLSearchParams(query);
  const kept = new URLSearchParams();
  for (const key of Object.keys(PhotoFilters.shape)) for (const v of params.getAll(key)) if (v) kept.append(key, v);
  const fields: Record<string, string[]> = {};
  for (const key of new Set(kept.keys())) fields[key] = kept.getAll(key);
  const parsed = PhotoFilters.safeParse(
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.length > 1 ? v : v[0]])),
  );
  if (!parsed.success) throw badRequest('These filters can’t be read');
  return kept.toString();
}

/**
 * The tag manager renamed (or moved, or merged) `from` to `to`, or deleted it (`to`
 * null): the presets' tag filters follow, the tags under it too. A deleted tag's filter
 * is dropped.
 */
export async function followTagRename(tx: Queryable, ownerId: string, from: string, to: string | null) {
  const rows = (await tx.query(sql`SELECT * FROM filter_presets WHERE owner_id = ${ownerId}`)) as FilterPresets[];
  for (const row of rows) {
    const params = new URLSearchParams(row.query);
    const tags = params.getAll('tag');
    const moved = tags.flatMap((t) => {
      if (t !== from && !t.startsWith(`${from}${SEPARATOR}`)) return [t];
      return to === null ? [] : [to + t.slice(from.length)];
    });
    if (moved.every((t, i) => t === tags[i]) && moved.length === tags.length) continue;
    params.delete('tag');
    for (const t of new Set(moved)) params.append('tag', t);
    await tx.query(
      sql`UPDATE filter_presets SET query = ${params.toString()}, updated_at = now() WHERE id = ${row.id}`,
    );
  }
}

export async function filterPresetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/filter-presets', async (request) => {
    const rows = (await db.query(
      sql`SELECT * FROM filter_presets WHERE owner_id = ${currentUser(request).id} ORDER BY lower(name), name`,
    )) as FilterPresets[];
    return { presets: rows.map(dto) };
  });

  /** Saving under a name the user already has replaces that preset. */
  app.post('/api/filter-presets', async (request, reply) => {
    const user = currentUser(request);
    const input = z.object({ name: Name, query: z.string().max(20_000) }).parse(request.body);
    const query = normalizeFilterQuery(input.query);
    if (!query) throw badRequest('A filter preset needs a filter');
    const [row] = (await db.query(sql`
      INSERT INTO filter_presets (owner_id, name, query) VALUES (${user.id}, ${input.name}, ${query})
      ON CONFLICT (owner_id, name) DO UPDATE SET query = excluded.query, updated_at = now()
      RETURNING *`)) as FilterPresets[];
    return reply.code(201).send(dto(row!));
  });

  app.patch('/api/filter-presets/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { name } = z.object({ name: Name }).parse(request.body);
    const rows = await db
      .query(
        sql`UPDATE filter_presets SET name = ${name}, updated_at = now()
          WHERE id = ${id} AND owner_id = ${user.id} RETURNING *`,
      )
      .catch((err: { code?: string }) => {
        throw err.code === UNIQUE_VIOLATION ? conflict(`There is already a filter preset named “${name}”`) : err;
      });
    const [row] = rows as FilterPresets[];
    if (!row) throw notFound('Filter preset not found');
    return dto(row);
  });

  app.delete('/api/filter-presets/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const deleted = await db.query(
      sql`DELETE FROM filter_presets WHERE id = ${id} AND owner_id = ${user.id} RETURNING id`,
    );
    if (!deleted.length) throw notFound('Filter preset not found');
    return { ok: true };
  });
}
