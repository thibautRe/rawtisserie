import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { db, sessions, sql } from '../db.ts';
import type Users from '../__generated__/users.ts';

export const SESSION_COOKIE = 'rawtisserie_session';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

export function toSessionUser(user: Users): SessionUser {
  return { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin };
}

/** Create a session and return the opaque token to put in the cookie. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 3600 * 1000);
  await sessions(db).insert({ id: hashToken(token), user_id: userId, expires_at: expiresAt });
  return { token, expiresAt };
}

export async function getSessionUser(token: string): Promise<SessionUser | null> {
  const [row] = await db.query(sql`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${hashToken(token)} AND s.expires_at > now()
  `);
  return row ? toSessionUser(row as Users) : null;
}

/** Sign the user out everywhere but the session `keepToken` (after a password change). */
export async function deleteOtherSessions(userId: string, keepToken: string): Promise<void> {
  await db.query(sql`DELETE FROM sessions WHERE user_id = ${userId} AND id <> ${hashToken(keepToken)}`);
}

export async function deleteSession(token: string): Promise<void> {
  await sessions(db).delete({ id: hashToken(token) });
}

export async function deleteExpiredSessions(): Promise<void> {
  await db.query(sql`DELETE FROM sessions WHERE expires_at <= now()`);
}

export async function findUserByEmail(email: string): Promise<Users | null> {
  const [row] = await db.query(sql`SELECT * FROM users WHERE lower(email) = lower(${email})`);
  return (row as Users | undefined) ?? null;
}
