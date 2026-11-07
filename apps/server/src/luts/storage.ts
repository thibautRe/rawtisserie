/**
 * LUT files: one per table, packed (`Clut::to_packed`), named by the table's id. Built-in
 * LUTs ship with the app (`builtinLutUrl`); uploaded ones live in the storage directory.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from '@databases/pg';
import { LUT_ID, isBuiltinLut } from '@rawtisserie/pipeline';
import { builtinLutUrl } from '@rawtisserie/pipeline/node';
import { config } from '../config.ts';
import { sql } from '../db.ts';

export const uploadedLutPath = (id: string) => path.join(config.storageDir, 'luts', id.slice(0, 2), `${id}.clut`);

/** Where a LUT's file is: built-in or uploaded. */
export function lutPath(id: string): string {
  if (!LUT_ID.test(id)) throw new Error(`invalid LUT id ${id}`);
  return isBuiltinLut(id) ? fileURLToPath(builtinLutUrl(id)) : uploadedLutPath(id);
}

/** Store a packed LUT under its id, atomically (a concurrent upload of the same LUT writes the same bytes). */
export async function storeLut(id: string, packed: Uint8Array): Promise<void> {
  const dest = uploadedLutPath(id);
  await mkdir(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${randomUUID()}.tmp`;
  await writeFile(temp, packed);
  await rename(temp, dest);
}

/**
 * The LUTs among `ids` that `ownerId` may render with: built-in ones, and those they
 * have a copy of (hidden or not), with their files.
 */
export async function usableLuts(db: Queryable, ownerId: string, ids: string[]): Promise<Map<string, string>> {
  const valid = ids.filter((id) => LUT_ID.test(id));
  const builtin = valid.filter(isBuiltinLut);
  const others = valid.filter((id) => !isBuiltinLut(id));
  const owned = others.length
    ? ((await db.query(sql`
        SELECT DISTINCT lut_id FROM user_luts WHERE owner_id = ${ownerId} AND lut_id = ANY(${others})`)) as {
        lut_id: string;
      }[])
    : [];
  return new Map([...builtin, ...owned.map((r) => r.lut_id)].map((id) => [id, lutPath(id)]));
}

/**
 * Remove the tables nobody has any more, and their files. Returns how many. Run at
 * start, before requests are served: an upload adds its table before the user's copy.
 */
export async function collectLuts(db: Queryable): Promise<number> {
  const rows = (await db.query(sql`
    DELETE FROM luts l WHERE NOT EXISTS (SELECT 1 FROM user_luts u WHERE u.lut_id = l.id)
    RETURNING id`)) as { id: string }[];
  await Promise.all(rows.map((r) => rm(uploadedLutPath(r.id), { force: true })));
  return rows.length;
}
