/** What renders a version: its original, its current recipe and the LUTs it may use. */
import { type EditParams, lutIds, normalizeEditParams } from '@rawtisserie/pipeline';
import { db, sql } from '../db.ts';
import { usableLuts, userLutNames } from '../luts/storage.ts';
import { originalKey } from '../photos/storage.ts';

export interface RenderSource {
  photoId: string;
  ownerId: string;
  /** The original's key in the object store. */
  sourceKey: string;
  /** The applied history entry's recipe; null for the original. */
  params: EditParams | null;
  /** The version has no history yet: render the recipe a new image starts with. */
  autoDefaults: boolean;
  /** With `autoDefaults`: edits from another application to import on top of it (`startingHistory`). */
  importedEdits: string | null;
  /** With `importedEdits`: the owner's LUTs by name, for those the edits refer to (`ImportContext.luts`). */
  userLuts: { id: string; name: string }[];
  /** The photo's metadata hasn't been read yet. */
  needsMetadata: boolean;
  /** Bumped on every history change. */
  revision: number;
  /** The LUTs the recipe uses that its owner may use. */
  luts: string[];
}

export async function renderSource(versionId: string): Promise<RenderSource | null> {
  const [row] = (await db.query(sql`
    SELECT v.photo_id, v.revision, v.imported_edits, p.owner_id, p.storage_key, p.exif IS NULL AS needs_metadata, h.recipe,
      NOT EXISTS (SELECT 1 FROM history_entries e WHERE e.version_id = v.id) AS no_history
    FROM versions v
    JOIN photos p ON p.id = v.photo_id
    LEFT JOIN history_entries h ON h.version_id = v.id AND h.seq = v.history_end
    WHERE v.id = ${versionId}`)) as {
    photo_id: string;
    revision: number;
    imported_edits: string | null;
    owner_id: string;
    storage_key: string;
    needs_metadata: boolean;
    recipe: EditParams | null;
    no_history: boolean;
  }[];
  if (!row) return null;
  return {
    photoId: row.photo_id,
    ownerId: row.owner_id,
    sourceKey: originalKey(row.storage_key),
    params: row.recipe,
    autoDefaults: row.no_history,
    importedEdits: row.no_history ? row.imported_edits : null,
    userLuts: row.no_history && row.imported_edits ? await userLutNames(db, row.owner_id) : [],
    needsMetadata: row.needs_metadata,
    revision: row.revision,
    luts: row.recipe ? await usableLuts(db, row.owner_id, lutIds(normalizeEditParams(row.recipe))) : [],
  };
}
