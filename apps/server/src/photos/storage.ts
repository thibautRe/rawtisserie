/**
 * Originals and rendered previews in the object store (`storage/`), and uploads on
 * their way there.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.ts';
import { storage } from '../storage/index.ts';

export type RenderSize = 'thumb' | 'preview';

/** Long edge, in pixels, of each rendered size. */
export const RENDER_SIZES: Record<RenderSize, number> = { thumb: 480, preview: 2048 };

export const originalKey = (storageKey: string) => `originals/${storageKey}`;

/** Renders are per version (a version's first id may equal its photo's, see migration 00003). */
export const renderKey = (versionId: string, size: RenderSize) =>
  `renders/${versionId.slice(0, 2)}/${versionId}-${size}.jpg`;

export interface StoredUpload {
  tempPath: string;
  size: number;
  sha256: string;
}

/**
 * Stream an upload to a temporary file on local disk, hashing it on the way, so that
 * duplicates are found before anything is stored.
 */
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
  try {
    await storage.putFile(originalKey(storageKey), upload.tempPath);
  } finally {
    await rm(upload.tempPath, { force: true });
  }
}

export async function discardUpload(upload: StoredUpload): Promise<void> {
  await rm(upload.tempPath, { force: true });
}

export async function deleteOriginal(storageKey: string): Promise<void> {
  await storage.delete(originalKey(storageKey));
}

export async function deleteRenders(versionId: string): Promise<void> {
  await Promise.all((Object.keys(RENDER_SIZES) as RenderSize[]).map((s) => storage.delete(renderKey(versionId, s))));
}

/** File extensions of RAW formats we accept (decoding support comes from rawler). */
export const RAW_EXTENSIONS = new Set([
  '.3fr',
  '.ari',
  '.arw',
  '.cr2',
  '.cr3',
  '.crw',
  '.dcr',
  '.dcs',
  '.dng',
  '.erf',
  '.fff',
  '.iiq',
  '.kdc',
  '.mef',
  '.mos',
  '.mrw',
  '.nef',
  '.nrw',
  '.orf',
  '.ori',
  '.pef',
  '.raf',
  '.raw',
  '.rw2',
  '.rwl',
  '.sr2',
  '.srf',
  '.srw',
  '.x3f',
]);
