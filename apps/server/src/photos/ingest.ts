/**
 * Taking in an original file: from an upload (`POST /api/photos`) or from another
 * instance (`transfer/receive.ts`). Checks that it's a RAW file, not too large, not
 * already there, not deleted for good before (unless allowed) and within the quota; then
 * stores it, with a photo and its first version.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fits, quotaExceeded, storageUsage } from '../accounts/quota.ts';
import { db, photos, sql, versions } from '../db.ts';
import type Versions from '../__generated__/versions.ts';
import { RAW_EXTENSIONS, commitUpload, deleteOriginal, discardUpload, receiveUpload } from './storage.ts';

/** Why a file wasn't taken in (the web app groups them by this). */
export type SkipKind = 'unsupported' | 'tooLarge' | 'duplicate' | 'deleted' | 'quota';

export type Ingested =
  /** Stored, with a new photo and version. */
  | { status: 'created'; photoId: string; versionId: string }
  /** The user has this file already (`inLibrary`: not only in the trash): nothing stored. */
  | { status: 'existing'; photoId: string; filename: string; inLibrary: boolean }
  | { status: 'skipped'; kind: SkipKind; reason: string };

export interface IngestOptions {
  /** Take it even if it was deleted for good before (then it's no longer remembered). */
  allowDeleted: boolean;
  /** Columns of the version created with it (its import, where it came from…). */
  version?: Partial<Versions>;
}

/** Take in `file` (a multipart part's stream, `truncated` once over the size limit). */
export async function ingestFile(
  userId: string,
  filename: string,
  file: Readable & { truncated?: boolean },
  { allowDeleted, version = {} }: IngestOptions,
): Promise<Ingested> {
  const ext = path.extname(filename).toLowerCase();
  if (!RAW_EXTENSIONS.has(ext)) {
    file.resume();
    return { status: 'skipped', kind: 'unsupported', reason: 'Not a supported RAW file' };
  }
  const upload = await receiveUpload(file);
  if (file.truncated) {
    await discardUpload(upload);
    return { status: 'skipped', kind: 'tooLarge', reason: 'File too large' };
  }
  const existing = await photos(db).findOne({ owner_id: userId, sha256: upload.sha256 });
  if (existing) {
    await discardUpload(upload);
    const [inLibrary] = await db.query(sql`
      SELECT 1 FROM versions WHERE photo_id = ${existing.id} AND trashed_at IS NULL LIMIT 1`);
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
  const storageKey = `${userId}/${id}${ext}`;
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
