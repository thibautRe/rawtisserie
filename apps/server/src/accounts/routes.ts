/**
 * A user's storage, and the admins' pages: users with their usage and quota, and
 * invitations. Quotas are in bytes here; the UI shows and takes GB.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin, requireUser } from '../auth/routes.ts';
import { db, sql } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import type Invitations from '../__generated__/invitations.ts';
import { invitationStatus, newInvitationCode } from './invitations.ts';
import { storageUsage } from './quota.ts';

const Id = z.object({ id: z.uuid() });
/** Bytes, or null for unlimited. */
const Quota = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

const UserPatch = z
  .object({ storageQuota: Quota.optional(), isAdmin: z.boolean().optional() })
  .refine((p) => p.storageQuota !== undefined || p.isAdmin !== undefined, 'Nothing to change');

const NewInvitation = z.object({
  label: z.string().trim().max(200).optional(),
  maxUses: z.number().int().min(1).max(10_000),
  storageQuota: Quota,
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

interface AdminUserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
  is_admin: boolean;
  storage_quota: number | null;
  used: number;
  photos: number;
  invitation_label: string | null;
}

const ADMIN_USERS = sql`
  SELECT u.id, u.email, u.display_name, u.created_at, u.is_admin, u.storage_quota,
    coalesce(s.used, 0)::bigint AS used, coalesce(s.photos, 0)::int AS photos,
    i.label AS invitation_label
  FROM users u
  LEFT JOIN (SELECT owner_id, sum(file_size) AS used, count(*) AS photos FROM photos GROUP BY owner_id) s
    ON s.owner_id = u.id
  LEFT JOIN invitations i ON i.id = u.invitation_id`;

const adminUserDto = (r: AdminUserRow) => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  createdAt: r.created_at,
  isAdmin: r.is_admin,
  storageQuota: r.storage_quota,
  storageUsed: r.used,
  photos: r.photos,
  invitation: r.invitation_label,
});

const invitationDto = (r: Invitations & { created_by_email: string | null }) => ({
  id: r.id,
  code: r.code,
  label: r.label,
  maxUses: r.max_uses,
  uses: r.uses,
  storageQuota: r.storage_quota,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
  createdBy: r.created_by_email,
  status: invitationStatus(r),
});

const INVITATIONS = sql`
  SELECT i.*, u.email AS created_by_email FROM invitations i LEFT JOIN users u ON u.id = i.created_by`;

export async function accountRoutes(app: FastifyInstance) {
  /** The user's original files against their quota. */
  app.get('/api/account/storage', { preHandler: requireUser }, async (request) =>
    storageUsage(db, currentUser(request).id),
  );

  // ── Admin ─────────────────────────────────────────────────────────────────

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    const rows = (await db.query(sql`${ADMIN_USERS} ORDER BY u.created_at`)) as AdminUserRow[];
    return { users: rows.map(adminUserDto) };
  });

  /** Change a user's quota (lowering it below their usage deletes nothing) or admin rights. */
  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = Id.parse(request.params);
    const patch = UserPatch.parse(request.body);
    if (patch.isAdmin === false && id === currentUser(request).id) {
      throw badRequest('You can’t remove your own admin rights');
    }
    const updated = await db.query(sql`
      UPDATE users SET
        storage_quota = ${patch.storageQuota !== undefined ? sql`${patch.storageQuota}` : sql`storage_quota`},
        is_admin = ${patch.isAdmin !== undefined ? sql`${patch.isAdmin}` : sql`is_admin`}
      WHERE id = ${id} RETURNING id`);
    if (!updated.length) throw notFound('User not found');
    const [row] = (await db.query(sql`${ADMIN_USERS} WHERE u.id = ${id}`)) as AdminUserRow[];
    return { user: adminUserDto(row!) };
  });

  app.get('/api/admin/invitations', { preHandler: requireAdmin }, async () => {
    const rows = await db.query(sql`${INVITATIONS} ORDER BY i.created_at DESC`);
    return { invitations: rows.map(invitationDto) };
  });

  app.post('/api/admin/invitations', { preHandler: requireAdmin }, async (request, reply) => {
    const body = NewInvitation.parse(request.body);
    const [created] = await db.query(sql`
      INSERT INTO invitations (code, label, max_uses, storage_quota, expires_at, created_by)
      VALUES (${newInvitationCode()}, ${body.label || null}, ${body.maxUses}, ${body.storageQuota},
        ${body.expiresAt ? new Date(body.expiresAt) : null}, ${currentUser(request).id})
      RETURNING id`);
    const [row] = await db.query(sql`${INVITATIONS} WHERE i.id = ${created.id}`);
    return reply.code(201).send({ invitation: invitationDto(row) });
  });

  /** Stop an invitation from creating more accounts (those it created stay). */
  app.post('/api/admin/invitations/:id/revoke', { preHandler: requireAdmin }, async (request) => {
    const { id } = Id.parse(request.params);
    const updated = await db.query(sql`
      UPDATE invitations SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${id} RETURNING id`);
    if (!updated.length) throw notFound('Invitation not found');
    const [row] = await db.query(sql`${INVITATIONS} WHERE i.id = ${id}`);
    return { invitation: invitationDto(row) };
  });
}
