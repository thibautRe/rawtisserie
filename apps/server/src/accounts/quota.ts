/**
 * Storage quotas (roadmap 7.5): a user's original files (`photos.file_size`) against
 * their `storage_quota`, NULL being unlimited. Renders and LUTs don't count, and a
 * duplicated version shares its photo's file, so it adds nothing.
 */
import { type Queryable, sql } from '@databases/pg';

/** Sizes are shown and entered in GB of 1024³ bytes, like every size in the app. */
export const GB = 1024 ** 3;

export interface StorageUsage {
  used: number;
  /** Bytes, or null for unlimited. */
  quota: number | null;
}

/**
 * What `userId` stores and may store. With `lock`, inside a transaction: the user's row
 * stays locked until it ends, so that concurrent uploads are checked one at a time.
 */
export async function storageUsage(q: Queryable, userId: string, { lock = false } = {}): Promise<StorageUsage> {
  const [row] = (await q.query(sql`
    SELECT u.storage_quota AS quota,
      (SELECT coalesce(sum(p.file_size), 0) FROM photos p WHERE p.owner_id = u.id)::bigint AS used
    FROM users u WHERE u.id = ${userId}
    ${lock ? sql`FOR UPDATE OF u` : sql``}`)) as { quota: number | null; used: number }[];
  if (!row) throw new Error(`no user ${userId}`);
  return { used: row.used, quota: row.quota };
}

export const fits = ({ used, quota }: StorageUsage, size: number) => quota === null || used + size <= quota;

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** Why an upload was refused. */
export const quotaExceeded = ({ used, quota }: StorageUsage) =>
  `Not enough storage: ${formatBytes(used)} of ${formatBytes(quota ?? 0)} used`;
