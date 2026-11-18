/**
 * Access tokens (receiving side): a user makes one here and pastes it into another
 * instance, which can then add to their library through `/api/transfer/…` (and nothing
 * else). Shown once, stored hashed, revocable.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/routes.ts';
import { type SessionUser, toSessionUser } from '../auth/sessions.ts';
import { db, sql } from '../db.ts';
import type Users from '../__generated__/users.ts';
import { notFound } from '../errors.ts';
import { MAX_COUNT, checkCount } from '../limits.ts';

/** What tokens start with, so they're recognisable (in a password manager, a leak scan). */
const PREFIX = 'rtt_';
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');

/** The user an `Authorization: Bearer …` token is for, or null. */
export async function tokenUser(request: FastifyRequest): Promise<SessionUser | null> {
  const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token?.startsWith(PREFIX)) return null;
  const [row] = (await db.query(sql`
    UPDATE access_tokens t SET last_used_at = now()
    FROM users u
    WHERE t.token_hash = ${hash(token)} AND u.id = t.owner_id
    RETURNING u.*`)) as Users[];
  return row ? toSessionUser(row) : null;
}

const Id = z.object({ id: z.uuid() });

export async function tokenRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/access-tokens', async (request) => {
    const rows = (await db.query(sql`
      SELECT id, name, created_at, last_used_at FROM access_tokens
      WHERE owner_id = ${currentUser(request).id} ORDER BY created_at DESC`)) as {
      id: string;
      name: string;
      created_at: Date;
      last_used_at: Date | null;
    }[];
    return {
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at.toISOString(),
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
      })),
    };
  });

  /** A new token: the only time it's shown. */
  app.post('/api/access-tokens', async (request, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    const [mine] = (await db.query(sql`
      SELECT count(*)::int AS n FROM access_tokens WHERE owner_id = ${currentUser(request).id}`)) as { n: number }[];
    checkCount(mine!.n, MAX_COUNT.accessTokens, 'access tokens');
    const token = PREFIX + randomBytes(32).toString('base64url');
    const [row] = (await db.query(sql`
      INSERT INTO access_tokens (owner_id, name, token_hash)
      VALUES (${currentUser(request).id}, ${name}, ${hash(token)})
      RETURNING id, created_at`)) as { id: string; created_at: Date }[];
    return reply
      .code(201)
      .send({ id: row!.id, name, token, createdAt: row!.created_at.toISOString(), lastUsedAt: null });
  });

  app.delete('/api/access-tokens/:id', async (request) => {
    const { id } = Id.parse(request.params);
    const gone = await db.query(sql`
      DELETE FROM access_tokens WHERE id = ${id} AND owner_id = ${currentUser(request).id} RETURNING id`);
    if (!gone.length) throw notFound('Token not found');
    return { ok: true };
  });
}
