/** LUTs in the database: which a user may render with, and collecting unused tables. */
import type { Queryable } from '@databases/pg';
import { type EditParams, LUT_ID, isBuiltinLut, resolveLutRefs } from '@rawtisserie/pipeline';
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

/**
 * Give the LUT the user now has under `lut.name` to the references edits imported from
 * another application left waiting for it (`LutRef.id` empty, `resolveLutRefs`), in
 * every history entry of their versions (trashed ones too). Like resolved auto-tunes,
 * entries change in place and revisions aren't bumped. Versions whose current entry
 * changed are marked for rendering again: their ids, for the render queue.
 */
export async function resolveImportedLuts(
  db: Queryable,
  ownerId: string,
  lut: { id: string; name: string },
): Promise<string[]> {
  return db.tx(async (tx) => {
    const rows = (await tx.query(sql`
      SELECT h.version_id, h.seq, h.recipe, h.seq = v.history_end AS current
      FROM history_entries h
      JOIN versions v ON v.id = h.version_id
      JOIN photos p ON p.id = v.photo_id
      WHERE p.owner_id = ${ownerId}
        AND h.recipe @? '$.modules[*] ? (@.kind == "lut" && @.params.lut.id == "")'
      FOR UPDATE OF h`)) as { version_id: string; seq: number; recipe: EditParams; current: boolean }[];
    const rerender = new Set<string>();
    for (const row of rows) {
      const resolved = resolveLutRefs(row.recipe, [lut]);
      if (resolved === row.recipe) continue;
      await tx.query(sql`
        UPDATE history_entries SET recipe = ${JSON.stringify(resolved)}::jsonb
        WHERE version_id = ${row.version_id} AND seq = ${row.seq}`);
      if (row.current) rerender.add(row.version_id);
    }
    if (rerender.size)
      await tx.query(sql`
        UPDATE versions SET render_status = 'pending', render_error = NULL, render_attempts = 0, render_retry_at = NULL
        WHERE id = ANY(${[...rerender]})`);
    return [...rerender];
  });
}

/** The user's LUTs by name (not removed ones), for the edits imported with a new version (`ImportContext.luts`). */
export async function userLutNames(db: Queryable, ownerId: string): Promise<{ id: string; name: string }[]> {
  return (await db.query(sql`
    SELECT lut_id AS id, name FROM user_luts WHERE owner_id = ${ownerId} AND hidden_at IS NULL
    ORDER BY created_at DESC`)) as { id: string; name: string }[];
}
