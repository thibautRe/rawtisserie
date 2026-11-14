import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LUT_ID, LUT_MAX_BYTES, LUT_NAME_MAX, type UserLut, isBuiltinLut } from '@rawtisserie/pipeline';
import { initPipeline, parseLut } from '@rawtisserie/pipeline/node';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, sql } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { storeLut, streamLut } from './files.ts';

const Id = z.object({ id: z.uuid() });
const LutId = z.object({ lutId: z.string().regex(LUT_ID) });
const Name = z.string().trim().min(1).max(LUT_NAME_MAX);
const UNIQUE_VIOLATION = '23505';
/** How a packed LUT starts (`Clut::to_packed`). */
const PACKED_MAGIC = new TextEncoder().encode('RTCLUZ');

interface Row {
  id: string;
  lut_id: string;
  name: string;
  size: number;
  bit_depth: number;
  created_at: Date;
}

const lutDto = (row: Row): UserLut => ({
  id: row.id,
  lutId: row.lut_id,
  name: row.name,
  size: row.size,
  bitDepth: row.bit_depth,
  createdAt: row.created_at.toISOString(),
});

/**
 * Give the user the LUT packed in `body` (`parseLut(file).takePacked()` in the app, or
 * from another instance) under `name`. One they already have (even removed) comes back
 * under the new name.
 */
export async function addLut(userId: string, name: string, body: unknown): Promise<Row> {
  if (!(body instanceof Uint8Array) || !PACKED_MAGIC.every((b, i) => body[i] === b)) {
    throw badRequest('Expected a packed LUT (application/octet-stream)');
  }
  let parsed;
  try {
    parsed = parseLut(body);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : String(err));
  }
  const { id, size, bitDepth } = parsed;
  // Stored as the pipeline packs it, whatever the client sent.
  const packed = parsed.takePacked();
  parsed.free();
  // The table first, then its file, then the user's copy of it: a table is only used
  // through a copy, so it never is before its file is there. If the copy can't be made
  // (its name is taken), a new table is left without one: `collectLuts` removes it at
  // the next start. Built-in tables ship with the app; the user still gets a copy.
  await db.query(sql`
    INSERT INTO luts (id, size, bit_depth, file_size) VALUES (${id}, ${size}, ${bitDepth}, ${packed.length})
    ON CONFLICT (id) DO NOTHING`);
  if (!isBuiltinLut(id)) await storeLut(id, packed);
  const [row] = (await db
    .query(
      sql`
        INSERT INTO user_luts (owner_id, lut_id, name) VALUES (${userId}, ${id}, ${name})
        ON CONFLICT (owner_id, lut_id)
        DO UPDATE SET name = excluded.name, hidden_at = NULL, updated_at = now()
        RETURNING id, lut_id, name, ${size}::smallint AS size, ${bitDepth}::smallint AS bit_depth, created_at`,
    )
    .catch(nameTaken(name))) as Row[];
  return row!;
}

const nameTaken = (name: string) => (err: { code?: string }) => {
  throw err.code === UNIQUE_VIOLATION ? conflict(`There is already a LUT named “${name}”`) : err;
};

/**
 * The user's LUTs, and every LUT's table. Built-in LUTs are listed in the app
 * (`BUILTIN_LUTS`); their tables are public, for the developer without an account.
 */
export async function lutRoutes(app: FastifyInstance) {
  initPipeline();
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: LUT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/api/luts', { preHandler: requireUser }, async (request) => {
    const rows = (await db.query(sql`
      SELECT u.id, u.lut_id, u.name, l.size, l.bit_depth, u.created_at
      FROM user_luts u JOIN luts l ON l.id = u.lut_id
      WHERE u.owner_id = ${currentUser(request).id} AND u.hidden_at IS NULL
      ORDER BY lower(u.name)`)) as Row[];
    return { luts: rows.map(lutDto) };
  });

  /**
   * Add a LUT: the body is its packed form (`parseLut(file).takePacked()` in the app,
   * which decodes the file anyway), `?name=` its name. Adding one the user already has
   * (even removed) brings it back under the new name.
   */
  app.post('/api/luts', { preHandler: requireUser }, async (request, reply) => {
    const { name } = z.object({ name: Name }).parse(request.query);
    return reply.code(201).send(lutDto(await addLut(currentUser(request).id, name, request.body)));
  });

  app.patch('/api/luts/:id', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { name } = z.object({ name: Name }).parse(request.body);
    const [row] = (await db
      .query(
        sql`
          UPDATE user_luts u SET name = ${name}, updated_at = now()
          FROM luts l
          WHERE u.id = ${id} AND u.owner_id = ${user.id} AND u.hidden_at IS NULL AND l.id = u.lut_id
          RETURNING u.id, u.lut_id, u.name, l.size, l.bit_depth, u.created_at`,
      )
      .catch(nameTaken(name))) as Row[];
    if (!row) throw notFound('LUT not found');
    return lutDto(row);
  });

  /** Remove a LUT from the user's list. Recipes that use it keep rendering. */
  app.delete('/api/luts/:id', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const hidden = await db.query(sql`
      UPDATE user_luts SET hidden_at = now(), updated_at = now()
      WHERE id = ${id} AND owner_id = ${user.id} AND hidden_at IS NULL
      RETURNING id`);
    if (!hidden.length) throw notFound('LUT not found');
    return { ok: true };
  });

  /** A LUT's table, packed: built-in ones for anyone, others for users who have them. */
  app.get('/api/luts/:lutId/data', async (request, reply) => {
    const { lutId } = LutId.parse(request.params);
    const builtin = isBuiltinLut(lutId);
    if (!builtin) {
      if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
      const owned = await db.query(sql`
        SELECT 1 FROM user_luts WHERE owner_id = ${request.user.id} AND lut_id = ${lutId} LIMIT 1`);
      if (!owned.length) throw notFound('LUT not found');
    }
    const file = await streamLut(lutId);
    if (!file) throw notFound('LUT not found');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('cache-control', `${builtin ? 'public' : 'private'}, max-age=31536000, immutable`)
      .send(file);
  });
}
