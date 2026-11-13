/**
 * Invitations: links that create up to `max_uses` accounts, each with the invitation's
 * storage quota. Admins create and revoke them (`routes.ts`); sign-up claims one.
 */
import { randomBytes } from 'node:crypto';
import { type Queryable, sql } from '@databases/pg';
import type Invitations from '../__generated__/invitations.ts';

export type InvitationStatus = 'active' | 'used' | 'expired' | 'revoked';

/** 144 random bits, URL-safe. */
export const newInvitationCode = () => randomBytes(18).toString('base64url');

export function invitationStatus(inv: Invitations, now = new Date()): InvitationStatus {
  if (inv.revoked_at) return 'revoked';
  if (inv.uses >= inv.max_uses) return 'used';
  if (inv.expires_at && inv.expires_at <= now) return 'expired';
  return 'active';
}

const REASONS: Record<Exclude<InvitationStatus, 'active'> | 'unknown', string> = {
  unknown: 'This invitation link isn’t valid',
  used: 'This invitation has already been used',
  expired: 'This invitation has expired',
  revoked: 'This invitation was withdrawn',
};

export async function findInvitation(q: Queryable, code: string): Promise<Invitations | null> {
  const [row] = await q.query(sql`SELECT * FROM invitations WHERE code = ${code}`);
  return (row as Invitations | undefined) ?? null;
}

/** Why `inv` can't be used (null if it can). */
export function invitationProblem(inv: Invitations | null): string | null {
  if (!inv) return REASONS.unknown;
  const status = invitationStatus(inv);
  return status === 'active' ? null : REASONS[status];
}

/**
 * Take one use of the invitation, inside the sign-up's transaction (it's given back if
 * the account isn't created). One statement, so concurrent sign-ups can't overrun it.
 */
export async function claimInvitation(
  tx: Queryable,
  code: string,
): Promise<{ invitation: Invitations } | { error: string }> {
  const [row] = await tx.query(sql`
    UPDATE invitations SET uses = uses + 1
    WHERE code = ${code} AND revoked_at IS NULL AND uses < max_uses
      AND (expires_at IS NULL OR expires_at > now())
    RETURNING *`);
  if (row) return { invitation: row as Invitations };
  return { error: invitationProblem(await findInvitation(tx, code)) ?? REASONS.unknown };
}
