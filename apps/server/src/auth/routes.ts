import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { db, users } from '../db.ts';
import { hashPassword, verifyPassword } from './password.ts';
import {
  SESSION_COOKIE,
  type SessionUser,
  createSession,
  deleteSession,
  findUserByEmail,
  getSessionUser,
  toSessionUser,
} from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

const Credentials = z.object({
  email: z.email().max(320),
  password: z.string().min(8).max(1024),
});
const Signup = Credentials.extend({ displayName: z.string().trim().min(1).max(100) });

// A real hash, so that unknown emails take as long as wrong passwords.
const dummyHash = await hashPassword('not-a-real-password');

export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.user = token ? await getSessionUser(token) : null;
  });
}
// Apply the hook to the whole app rather than just this plugin's scope (what fastify-plugin does).
Object.assign(authPlugin, { [Symbol.for('skip-override')]: true });

/** Route guard: 401 unless logged in. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'Authentication required' });
  }
}

export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error('requireUser guard missing');
  return request.user;
}

async function startSession(reply: FastifyReply, userId: string) {
  const { token, expiresAt } = await createSession(userId);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires: expiresAt,
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/config', async () => ({ allowSignup: config.allowSignup }));

  app.get('/api/auth/me', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not logged in' });
    return { user: request.user };
  });

  app.post('/api/auth/signup', async (request, reply) => {
    if (!config.allowSignup) return reply.code(403).send({ error: 'Sign-up is disabled' });
    const body = Signup.parse(request.body);
    if (await findUserByEmail(body.email)) {
      return reply.code(409).send({ error: 'An account with this email already exists' });
    }
    const [user] = await users(db).insert({
      email: body.email,
      display_name: body.displayName,
      password_hash: await hashPassword(body.password),
    });
    await startSession(reply, user!.id);
    return { user: toSessionUser(user!) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = Credentials.parse(request.body);
    const user = await findUserByEmail(body.email);
    const ok = await verifyPassword(body.password, user?.password_hash ?? dummyHash);
    if (!user || !ok) return reply.code(401).send({ error: 'Invalid email or password' });
    await startSession(reply, user.id);
    return { user: toSessionUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
