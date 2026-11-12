/**
 * Re-reads the orientation of every photo from its original and fixes the stored
 * `exif.orientation`, `width` and `height` where they differ, then queues the photo's
 * versions for re-rendering. Other metadata (and the user's corrections) is left alone.
 *
 * Photos imported before orientation was read from the EXIF tag (rawler reports
 * "normal" for ARW, CR2, NEF…) were developed unrotated, and their recipes were edited
 * that way. Geometry is relative to the camera orientation, so each history entry of
 * their versions is adjusted when the camera orientation is a plain rotation:
 * - a manual rotation was the user choosing their view: the camera's turns are taken
 *   off it, so the version looks as before;
 * - without one, the version was left sideways by the bug: it now comes out upright,
 *   and its crop is turned with the image so it frames the same part of the photo.
 * Mirrored camera orientations (rare) are only reported.
 *
 *   node --env-file-if-exists=../../.env src/scripts/refresh-orientation.ts [--dry-run]
 *
 * Needs a fresh `npm run build:wasm`.
 */
import { initPipeline, readMetadata } from '@rawtisserie/pipeline/node';
import { normalizeEditParams, type EditParams, type PhotoMetadata } from '@rawtisserie/pipeline';
import type { Queryable } from '@databases/pg';
import { db, sql } from '../db.ts';
import { originalKey } from '../photos/storage.ts';
import { storage } from '../storage/index.ts';

const dryRun = process.argv.includes('--dry-run');
initPipeline();

/** Clockwise quarter turns of the EXIF orientations that don't mirror. */
const TURNS: Record<number, number> = { 1: 0, 6: 1, 3: 2, 8: 3 };

interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A normalised rectangle after turning its frame `turns` quarter turns clockwise. */
function turnCrop(c: Crop, turns: number): Crop {
  let r = c;
  for (let i = 0; i < turns; i++) r = { x: 1 - r.y - r.height, y: r.x, width: r.height, height: r.width };
  return r;
}

/** The recipe adjusted for a camera orientation of `turns`, where it used to be none. */
function adjust(recipe: EditParams, turns: number): EditParams | null {
  if (!recipe.modules.some((m) => m.kind === 'geometry')) return null;
  const modules = recipe.modules.map((m) => {
    if (m.kind !== 'geometry') return m;
    const g = m.params;
    if (g.rotation) return { ...m, params: { ...g, rotation: (g.rotation - turns + 4) % 4 } };
    // Mirrored after the turn, the crop turns the other way.
    return { ...m, params: { ...g, crop: turnCrop(g.crop, g.flipHorizontal ? 4 - turns : turns) } };
  });
  return { ...recipe, modules };
}

async function adjustHistory(tx: Queryable, photoId: string, turns: number) {
  const entries = (await tx.query(sql`
    SELECT h.version_id, h.seq, h.recipe FROM history_entries h
    JOIN versions v ON v.id = h.version_id WHERE v.photo_id = ${photoId}`)) as {
    version_id: string;
    seq: number;
    recipe: EditParams;
  }[];
  for (const e of entries) {
    const recipe = adjust(normalizeEditParams(e.recipe), turns);
    if (!recipe) continue;
    await tx.query(sql`
      UPDATE history_entries SET recipe = ${JSON.stringify(recipe)}::jsonb
      WHERE version_id = ${e.version_id} AND seq = ${e.seq}`);
  }
  return entries.length;
}

const rows = (await db.query(sql`
  SELECT id, storage_key, original_filename, exif, width, height FROM photos WHERE exif IS NOT NULL`)) as {
  id: string;
  storage_key: string;
  original_filename: string;
  exif: PhotoMetadata;
  width: number | null;
  height: number | null;
}[];

let fixed = 0;
for (const row of rows) {
  let read: PhotoMetadata;
  try {
    const bytes = await storage.read(originalKey(row.storage_key));
    if (!bytes) throw new Error(`original not found: ${row.storage_key}`);
    read = JSON.parse(readMetadata(bytes));
  } catch (err) {
    console.warn(`${row.id} ${row.original_filename}: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  const before = row.exif.orientation ?? 1;
  const after = read.orientation ?? 1;
  if (after === before && read.width === row.width && read.height === row.height) continue;
  fixed++;
  console.log(
    `${row.id} ${row.original_filename}: orientation ${before} → ${after}, ` +
      `${row.width}×${row.height} → ${read.width}×${read.height}`,
  );
  const turns = before === 1 ? TURNS[after] : undefined;
  if (after !== before && turns === undefined)
    console.log('  mirrored or unexpected: recipes left as they are, check them');
  if (dryRun) continue;
  await db.tx(async (tx) => {
    await tx.query(sql`
      UPDATE photos
      SET exif = jsonb_set(exif, '{orientation}', ${JSON.stringify(read.orientation ?? null)}::jsonb),
        width = ${read.width ?? null}, height = ${read.height ?? null}, updated_at = now()
      WHERE id = ${row.id}`);
    if (turns) console.log(`  ${await adjustHistory(tx, row.id, turns)} history entries checked`);
    await tx.query(sql`
      UPDATE versions SET render_status = 'pending', render_error = NULL WHERE photo_id = ${row.id}`);
  });
}
console.log(`${fixed} of ${rows.length} photos ${dryRun ? 'need fixing' : 'fixed'}.`);
await db.dispose();
