/** LUTs in the database: which a user may render with, and collecting unused tables. */
import type { Queryable } from '@databases/pg';
import { LUT_ID, isBuiltinLut } from '@rawtisserie/pipeline';
import { sql } from '../db.ts';
import { deleteLut } from './files.ts';

/**
 * The LUTs among `ids` that `ownerId` may render with: built-in ones, and those they
 * have a copy of (hidden or not).
 */
export async function usableLuts(db: Queryable, ownerId: string, ids: string[]): Promise<string[]> {
  const valid = ids.filter((id) => LUT_ID.test(id));
  const builtin = valid.filter(isBuiltinLut);
  const others = valid.filter((id) => !isBuiltinLut(id));
  const owned = others.length
    ? ((await db.query(sql`
        SELECT DISTINCT lut_id FROM user_luts WHERE owner_id = ${ownerId} AND lut_id = ANY(${others})`)) as {
        lut_id: string;
      }[])
    : [];
  return [...builtin, ...owned.map((r) => r.lut_id)];
}

/**
 * Remove the tables nobody has any more, and their files. Returns how many. Run at
 * start, before requests are served: an upload adds its table before the user's copy.
 */
export async function collectLuts(db: Queryable): Promise<number> {
  const rows = (await db.query(sql`
    DELETE FROM luts l WHERE NOT EXISTS (SELECT 1 FROM user_luts u WHERE u.lut_id = l.id)
    RETURNING id`)) as { id: string }[];
  await Promise.all(rows.map((r) => deleteLut(r.id)));
  return rows.length;
}
