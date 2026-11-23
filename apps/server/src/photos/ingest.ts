/**
 * Taking in an original file: from an upload (`POST /api/photos`) or from another
 * instance (`transfer/receive.ts`). Checks that it's a RAW file or an image, not too large, not
 * already there, not deleted for good before (unless allowed) and within the quota; then
 * stores it, with a photo and its first version.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fits, quotaExceeded, storageUsage } from '../accounts/quota.ts';
import { db, photos, sql, versions } from '../db.ts';
import type Versions from '../__generated__/versions.ts';
import {
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  type StoredUpload,
  commitUpload,
  deleteOriginal,
  discardUpload,
  receiveUpload,
} from './storage.ts';

/** Why a file wasn't taken in (the web app groups them by this). */
export type SkipKind = 'unsupported' | 'tooLarge' | 'duplicate' | 'deleted' | 'quota';

export type Ingested =
  /** Stored, with a new photo and version. */
  | { status: 'created'; photoId: string; versionId: string }
  /** The user has this file already (`inLibrary`: not only in the trash): nothing stored. */
  | { status: 'existing'; photoId: string; filename: string; inLibrary: boolean }
  | { status: 'skipped'; kind: SkipKind; reason: string };

export interface IngestOptions {
  /**
   * Take it even if it was deleted before: for good (then it's no longer remembered), or
   * only into the trash (then it comes back as a new version).
   */
  allowDeleted: boolean;
  /** Columns of the version created with it (its import, where it came from…). */
  version?: Partial<Versions>;
  /** When the file was last modified, as the browser saw it (`photos.file_modified_at`). */
  modifiedAt?: Date | null;
}

/** Take in `file` (a multipart part's stream, `truncated` once over the size limit). */
export async function ingestFile(
  userId: string,
  filename: string,
  file: Readable & { truncated?: boolean },
  options: IngestOptions,
): Promise<Ingested> {
  if (!isSupportedName(filename)) {
    file.resume();
    return { status: 'skipped', kind: 'unsupported', reason: UNSUPPORTED };
  }
  const upload = await receiveUpload(file);
  if (file.truncated) {
    await discardUpload(upload);
    return { status: 'skipped', kind: 'tooLarge', reason: 'File too large' };
  }
  return ingestReceived(userId, filename, upload, options);
}

/** Why a file whose versions are all in the trash wasn't taken in (`allowDeleted` takes it). */
export const IN_TRASH = 'In your trash';

/** Take in a file received already (`upload`, removed from local disk either way). */
export async function ingestReceived(
  userId: string,
  filename: string,
  upload: StoredUpload,
  { allowDeleted, version = {}, modifiedAt = null }: IngestOptions,
): Promise<Ingested> {
  const existing = await photos(db).findOne({ owner_id: userId, sha256: upload.sha256 });
  if (existing) {
    await discardUpload(upload);
    // Imported before without its date: known now, so the next import finds it by name.
    if (modifiedAt && !existing.file_modified_at && existing.original_filename === filename)
      await photos(db).update({ id: existing.id }, { file_modified_at: modifiedAt });
    const [inLibrary] = await db.query(sql`
      SELECT 1 FROM versions WHERE photo_id = ${existing.id} AND trashed_at IS NULL LIMIT 1`);
    if (!inLibrary && !allowDeleted) return { status: 'skipped', kind: 'deleted', reason: IN_TRASH };
    return { status: 'existing', photoId: existing.id, filename: existing.original_filename, inLibrary: !!inLibrary };
  }
  if (!allowDeleted) {
    const [deleted] = await db.query(sql`
      SELECT 1 FROM deleted_originals WHERE owner_id = ${userId} AND sha256 = ${upload.sha256}`);
    if (deleted) {
      await discardUpload(upload);
      return { status: 'skipped', kind: 'deleted', reason: 'You deleted this file before' };
    }
  }
  // Checked before storing the file, so an upload over quota costs nothing more…
  const before = await storageUsage(db, userId);
  if (!fits(before, upload.size)) {
    await discardUpload(upload);
    return { status: 'skipped', kind: 'quota', reason: quotaExceeded(before) };
  }
  const id = randomUUID();
  const storageKey = `${userId}/${id}${path.extname(filename).toLowerCase()}`;
  await commitUpload(upload, storageKey);
  const inserted = await db.tx(async (tx) => {
    // …and again under the user's row lock, so concurrent uploads can't all take the
    // last free bytes.
    const usage = await storageUsage(tx, userId, { lock: true });
    if (!fits(usage, upload.size)) return { versionId: null, usage };
    await photos(tx).insert({
      id,
      owner_id: userId,
      original_filename: filename,
      storage_key: storageKey,
      file_size: upload.size,
      file_modified_at: modifiedAt,
      sha256: upload.sha256,
    });
    const [row] = await versions(tx).insert({ ...version, photo_id: id });
    // Taken in again on purpose: no longer one to ask about.
    await tx.query(sql`DELETE FROM deleted_originals WHERE owner_id = ${userId} AND sha256 = ${upload.sha256}`);
    return { versionId: row!.id, usage };
  });
  if (!inserted.versionId) {
    await deleteOriginal(storageKey);
    return { status: 'skipped', kind: 'quota', reason: quotaExceeded(inserted.usage) };
  }
  return { status: 'created', photoId: id, versionId: inserted.versionId };
}

/** A RAW file, or an image (JPEG, PNG, TIFF, WebP), by its name. */
export function isSupportedName(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return RAW_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

export const UNSUPPORTED = 'Not a RAW file or an image we read (JPEG, PNG, TIFF, WebP)';

/**
 * What an upload brought: the version created (a new one on the photo, for a file only
 * in the trash), or why there's none. `version`: the columns it starts with (its
 * import, what the file says about itself).
 */
export async function versionFor(
  result: Ingested,
  filename: string,
  version: Partial<Versions> = {},
): Promise<{ versionId: string } | { skipped: { filename: string; kind: SkipKind; reason: string } }> {
  if (result.status === 'skipped') return { skipped: { filename, kind: result.kind, reason: result.reason } };
  if (result.status === 'created') return { versionId: result.versionId };
  if (result.inLibrary)
    return { skipped: { filename, kind: 'duplicate', reason: `Already in your library as ${result.filename}` } };
  // Only in the trash, taken anyway (`allowDeleted`): the file is stored already, so it
  // comes back as a new version (the trashed ones stay there, to restore or not).
  const [created] = await versions(db).insert({ ...version, photo_id: result.photoId });
  return { versionId: created!.id };
}
