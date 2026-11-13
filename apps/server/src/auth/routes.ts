import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { claimInvitation, findInvitation, invitationProblem } from '../accounts/invitations.ts';
import { config } from '../config.ts';
import { db, users } from '../db.ts';
import { hashPassword, verifyPassword } from './password.ts';
import {
  SESSION_COOKIE,
  type SessionUser,
  createSession,
  deleteOtherSessions,
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
const PasswordChange = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: Credentials.shape.password,
});
const Signup = Credentials.extend({
  displayName: z.string().trim().min(1).max(100),
  /** An invitation's code; required unless `ALLOW_SIGNUP`. */
  invitation: z.string().min(1).max(100).optional(),
});

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

/** Route guard: 401 unless logged in, 403 unless an admin. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
  if (!request.user.isAdmin) return reply.code(403).send({ error: 'Admins only' });
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

  /** Whether an invitation can be used, and the storage it gives (bytes, null: unlimited). */
  app.get('/api/auth/invitations/:code', async (request, reply) => {
    const { code } = z.object({ code: z.string().min(1).max(100) }).parse(request.params);
    const invitation = await findInvitation(db, code);
    const problem = invitationProblem(invitation);
    if (problem) return reply.code(404).send({ error: problem });
    return { storageQuota: invitation!.storage_quota };
  });

  app.post('/api/auth/signup', async (request, reply) => {
    const body = Signup.parse(request.body);
    if (!body.invitation && !config.allowSignup) {
      return reply.code(403).send({ error: 'Sign-up needs an invitation' });
    }
    if (await findUserByEmail(body.email)) {
      return reply.code(409).send({ error: 'An account with this email already exists' });
    }
    const passwordHash = await hashPassword(body.password);
    const result = await db.tx(async (tx) => {
      let quota = config.defaultStorageQuota;
      let invitationId: string | null = null;
      if (body.invitation) {
        const claimed = await claimInvitation(tx, body.invitation);
        if ('error' in claimed) return claimed;
        quota = claimed.invitation.storage_quota;
        invitationId = claimed.invitation.id;
      }
      const [user] = await users(tx).insert({
        email: body.email,
        display_name: body.displayName,
        password_hash: passwordHash,
        storage_quota: quota,
        invitation_id: invitationId,
      });
      return { user: user! };
    });
    if ('error' in result) return reply.code(403).send({ error: result.error });
    await startSession(reply, result.user.id);
    return { user: toSessionUser(result.user) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = Credentials.parse(request.body);
    const user = await findUserByEmail(body.email);
    const ok = await verifyPassword(body.password, user?.password_hash ?? dummyHash);
    if (!user || !ok) return reply.code(401).send({ error: 'Invalid email or password' });
    await startSession(reply, user.id);
    return { user: toSessionUser(user) };
  });

  /** Change the user's password; their other sessions are signed out. */
  app.post('/api/auth/password', { preHandler: requireUser }, async (request, reply) => {
    const { currentPassword, newPassword } = PasswordChange.parse(request.body);
    const user = (await users(db).findOne({ id: currentUser(request).id }))!;
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      return reply.code(400).send({ error: 'The current password is wrong' });
    }
    await users(db).update({ id: user.id }, { password_hash: await hashPassword(newPassword) });
    await deleteOtherSessions(user.id, request.cookies[SESSION_COOKIE]!);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
