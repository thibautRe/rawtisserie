/**
 * Library export archives written to disk as they're made, in the browser's origin
 * private file system, so exported files don't pile up in memory until the end. The
 * download reads the finished file from there. Without OPFS (or a writable stream on
 * it), archives are kept in memory as before.
 */
import { type ZipSink, memorySink } from '../lib/zip.ts';

const DIRECTORY = 'exports';
/**
 * Archives written longer ago than this are removed when the next export starts: their
 * download has copied them by then (a part is at most `PART_SIZE`). Newer ones may still
 * be copying (Retry right after an export ends).
 */
const KEEP_MS = 2 * 60 * 1000;

async function directory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIRECTORY, { create: true });
}

/** Remove the archives earlier exports left (downloaded, or cancelled), when one starts. */
export async function cleanUpArchives(): Promise<void> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await directory();
  } catch {
    return;
  }
  const now = Date.now();
  // `entries()` isn't in every TypeScript DOM lib yet.
  const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind !== 'file') continue;
    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      if (now - file.lastModified > KEEP_MS) await dir.removeEntry(name);
    } catch {
      // In use, or gone already.
    }
  }
}

/** Where an export's archive is written: a file on disk if the browser allows it, else memory. */
export async function archiveSink(): Promise<ZipSink> {
  try {
    const dir = await directory();
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`;
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== 'function') throw new Error('No writable streams');
    const stream = await handle.createWritable();
    let closed = false;
    return {
      write: (part) => stream.write(part),
      truncate: (size) => stream.truncate(size),
      close: async () => {
        await stream.close();
        closed = true;
        // Read from disk when it's downloaded.
        return handle.getFile();
      },
      discard: async () => {
        if (!closed) await stream.abort().catch(() => {});
        await dir.removeEntry(name).catch(() => {});
      },
    };
  } catch {
    return memorySink();
  }
}
