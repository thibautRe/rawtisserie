/**
 * File storage for originals and rendered previews. Local disk for now; the
 * interface is deliberately small so it can be swapped for object storage.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.ts';

export type RenderSize = 'thumb' | 'preview';

/** Long edge, in pixels, of each rendered size. */
export const RENDER_SIZES: Record<RenderSize, number> = { thumb: 480, preview: 2048 };

export const originalPath = (storageKey: string) => path.join(config.storageDir, 'originals', storageKey);

export const renderPath = (photoId: string, size: RenderSize) =>
  path.join(config.storageDir, 'renders', photoId.slice(0, 2), `${photoId}-${size}.jpg`);

export interface StoredUpload {
  tempPath: string;
  size: number;
  sha256: string;
}

/** Stream an upload to a temporary file, hashing it on the way. */
export async function receiveUpload(stream: Readable): Promise<StoredUpload> {
  const dir = path.join(config.storageDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, randomUUID());
  const hash = createHash('sha256');
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    size += chunk.length;
  });
  try {
    await pipeline(stream, createWriteStream(tempPath));
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
  return { tempPath, size, sha256: hash.digest('hex') };
}

export async function commitUpload(upload: StoredUpload, storageKey: string): Promise<void> {
  const dest = originalPath(storageKey);
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(upload.tempPath, dest);
}

export async function discardUpload(upload: StoredUpload): Promise<void> {
  await rm(upload.tempPath, { force: true });
}

export async function deletePhotoFiles(photo: { id: string; storage_key: string }): Promise<void> {
  await Promise.all([
    rm(originalPath(photo.storage_key), { force: true }),
    ...(Object.keys(RENDER_SIZES) as RenderSize[]).map((s) => rm(renderPath(photo.id, s), { force: true })),
  ]);
}

export async function fileExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** File extensions of RAW formats we accept (decoding support comes from rawler). */
export const RAW_EXTENSIONS = new Set([
  '.3fr', '.ari', '.arw', '.cr2', '.cr3', '.crw', '.dcr', '.dcs', '.dng', '.erf', '.fff', '.iiq', '.kdc',
  '.mef', '.mos', '.mrw', '.nef', '.nrw', '.orf', '.ori', '.pef', '.raf', '.raw', '.rw2', '.rwl', '.sr2',
  '.srf', '.srw', '.x3f',
]);
