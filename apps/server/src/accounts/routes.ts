/**
 * A user's storage, and the admins' pages: users with their usage and quota, and
 * invitations. Quotas are in bytes here; the UI shows and takes GB.
 */
import type { AdminStats, AdminUser, Invitation } from '@rawtisserie/api';
import type { FastifyInstance } from 'fastify';
import type { RenderQueue } from '../render/queue.ts';
import { z } from 'zod';
import { currentUser, requireAdmin, requireUser } from '../auth/routes.ts';
import { config } from '../config.ts';
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

const adminUserDto = (r: AdminUserRow): AdminUser => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  createdAt: r.created_at.toISOString(),
  isAdmin: r.is_admin,
  storageQuota: r.storage_quota,
  storageUsed: r.used,
  photos: r.photos,
  invitation: r.invitation_label,
});

const invitationDto = (r: Invitations & { created_by_email: string | null }): Invitation => ({
  id: r.id,
  code: r.code,
  label: r.label,
  maxUses: r.max_uses,
  uses: r.uses,
  storageQuota: r.storage_quota,
  expiresAt: r.expires_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by_email,
  status: invitationStatus(r),
});

const INVITATIONS = sql`
  SELECT i.*, u.email AS created_by_email FROM invitations i LEFT JOIN users u ON u.id = i.created_by`;

export async function accountRoutes(app: FastifyInstance, { renderQueue }: { renderQueue: RenderQueue }) {
  /** The user's original files against their quota. */
  app.get('/api/account/storage', { preHandler: requireUser }, async (request) =>
    storageUsage(db, currentUser(request).id),
  );

  // ── Admin ─────────────────────────────────────────────────────────────────

  /**
   * The instance at a glance, for the admin overview. "Recent" is the last 30 days; the
   * render queue's history (`render_stats`, per hour) is summed over 24 hours and 7 days.
   */
  app.get('/api/admin/stats', { preHandler: requireAdmin }, async (): Promise<AdminStats> => {
    await renderQueue.flushStats();
    const [queue] = (await db.query(sql`
      SELECT
        coalesce(max(peak_pending) FILTER (WHERE hour > now() - interval '24 hours'), 0)::int AS peak_day,
        coalesce(max(peak_pending), 0)::int AS peak_week,
        (SELECT hour FROM render_stats WHERE hour > now() - interval '24 hours' AND peak_pending > 0
          ORDER BY peak_pending DESC, hour DESC LIMIT 1) AS peak_day_at,
        coalesce(max(max_wait_ms) FILTER (WHERE hour > now() - interval '24 hours'), 0)::int AS wait_day,
        coalesce(max(max_wait_ms), 0)::int AS wait_week,
        coalesce(sum(renders) FILTER (WHERE hour > now() - interval '24 hours'), 0)::int AS renders_day,
        coalesce(sum(failures) FILTER (WHERE hour > now() - interval '24 hours'), 0)::int AS failures_day,
        coalesce(sum(render_ms) FILTER (WHERE hour > now() - interval '24 hours'), 0)::bigint AS render_ms_day
      FROM render_stats WHERE hour > now() - interval '7 days'`)) as {
      peak_day: number;
      peak_week: number;
      peak_day_at: Date | null;
      wait_day: number;
      wait_week: number;
      renders_day: number;
      failures_day: number;
      render_ms_day: number;
    }[];
    const [row] = await db.query(sql`
      SELECT
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(*) FROM users WHERE is_admin)::int AS admins,
        (SELECT count(*) FROM users WHERE created_at > now() - interval '30 days')::int AS users_recent,
        (SELECT count(*) FROM users WHERE invitation_id IS NOT NULL)::int AS users_invited,
        (SELECT count(*) FROM users WHERE storage_quota IS NULL)::int AS users_unlimited,
        (SELECT coalesce(sum(storage_quota), 0) FROM users)::bigint AS quota_allocated,
        (SELECT count(*) FROM photos)::int AS photos,
        (SELECT count(*) FROM photos WHERE created_at > now() - interval '30 days')::int AS photos_recent,
        (SELECT coalesce(sum(file_size), 0) FROM photos)::bigint AS storage_used,
        (SELECT count(*) FROM versions WHERE trashed_at IS NULL)::int AS versions,
        (SELECT count(*) FROM versions WHERE trashed_at IS NOT NULL)::int AS versions_trashed,
        (SELECT coalesce(sum(file_size), 0) FROM photos p
          WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.photo_id = p.id AND v.trashed_at IS NULL))::bigint
          AS storage_trash,
        (SELECT count(*) FROM versions WHERE render_status = 'pending')::int AS renders_pending,
        (SELECT count(*) FROM versions WHERE render_status = 'failed')::int AS renders_failed,
        (SELECT count(*) FROM invitations WHERE revoked_at IS NULL AND uses < max_uses
          AND (expires_at IS NULL OR expires_at > now()))::int AS invitations_active`);
    return {
      users: { total: row.users, admins: row.admins, recent: row.users_recent, invited: row.users_invited },
      photos: { total: row.photos, recent: row.photos_recent, versions: row.versions, trashed: row.versions_trashed },
      storage: {
        used: row.storage_used,
        trash: row.storage_trash,
        allocated: row.quota_allocated,
        unlimitedUsers: row.users_unlimited,
      },
      renders: {
        pending: row.renders_pending,
        failed: row.renders_failed,
        oldestWaitMs: renderQueue.oldestWaitMs(),
        day: {
          peakPending: queue!.peak_day,
          peakAt: queue!.peak_day_at?.toISOString() ?? null,
          maxWaitMs: queue!.wait_day,
          renders: queue!.renders_day,
          failures: queue!.failures_day,
          averageMs: queue!.renders_day ? Math.round(queue!.render_ms_day / queue!.renders_day) : null,
        },
        week: { peakPending: queue!.peak_week, maxWaitMs: queue!.wait_week },
      },
      invitations: { active: row.invitations_active },
      instance: {
        storage: config.s3 ? `S3 bucket ${config.s3.bucket}` : 'Local disk',
        signup: config.allowSignup ? 'open' : 'invitation',
        defaultStorageQuota: config.defaultStorageQuota,
      },
    };
  });

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

  /** Undo a revocation: the link works again, while it has uses left and hasn't expired. */
  app.post('/api/admin/invitations/:id/reactivate', { preHandler: requireAdmin }, async (request) => {
    const { id } = Id.parse(request.params);
    const updated = await db.query(sql`UPDATE invitations SET revoked_at = NULL WHERE id = ${id} RETURNING id`);
    if (!updated.length) throw notFound('Invitation not found');
    const [row] = await db.query(sql`${INVITATIONS} WHERE i.id = ${id}`);
    return { invitation: invitationDto(row) };
  });

  /** Stop an invitation from creating more accounts (those it created stay); reversible. */
  app.post('/api/admin/invitations/:id/revoke', { preHandler: requireAdmin }, async (request) => {
    const { id } = Id.parse(request.params);
    const updated = await db.query(sql`
      UPDATE invitations SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${id} RETURNING id`);
    if (!updated.length) throw notFound('Invitation not found');
    const [row] = await db.query(sql`${INVITATIONS} WHERE i.id = ${id}`);
    return { invitation: invitationDto(row) };
  });
}
