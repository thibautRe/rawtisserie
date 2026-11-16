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

/**
 * What a version's renders are stored as (`versions.render_format`): new renders are
 * AVIF (roadmap 7.11), those made before stay JPEG until the version renders again.
 */
export type RenderFormat = 'jpeg' | 'avif';
export const RENDER_FORMATS: Record<RenderFormat, { extension: string; mimeType: string }> = {
  jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
  avif: { extension: 'avif', mimeType: 'image/avif' },
};

/** Renders are per version (a version's first id may equal its photo's, see migration 00003). */
export const renderKey = (versionId: string, size: RenderSize, format: RenderFormat) =>
  `renders/${versionId.slice(0, 2)}/${versionId}-${size}.${RENDER_FORMATS[format].extension}`;

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

/** Delete a version's renders, in these formats (all by default). */
export async function deleteRenders(
  versionId: string,
  formats = Object.keys(RENDER_FORMATS) as RenderFormat[],
): Promise<void> {
  const sizes = Object.keys(RENDER_SIZES) as RenderSize[];
  await Promise.all(formats.flatMap((f) => sizes.map((s) => storage.delete(renderKey(versionId, s, f)))));
}

/**
 * File extensions of images that aren't RAW files, developed already (roadmap 8.11;
 * decoded by the pipeline's `bitmap`). Mirrors `IMAGE_ACCEPT` in the web app.
 */
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);

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
