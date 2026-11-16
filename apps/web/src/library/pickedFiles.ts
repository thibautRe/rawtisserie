/**
 * Files picked for an import (roadmap 8.2): from a file or folder picker, or dropped
 * (files, folders, a card's `DCIM`), with their path inside what was picked. Folders are
 * walked through, and what isn't a RAW file or an image is left out (cards hold videos
 * and macOS's `._` files next to the RAWs). A JPEG next to a RAW file of the same name
 * (a camera shooting both) is set apart: imported only if asked for.
 */
import { IMAGE_ACCEPT, PHOTO_ACCEPT, RAW_ACCEPT } from '../lib/format.ts';

export interface PickedFile {
  file: File;
  /** Inside what was picked: `DCIM/100MSDCF/DSC01234.ARW`, or the name of a file picked alone. */
  path: string;
}

/** What was picked, sorted out. */
export interface Picked {
  /** The RAW files and images to import, by path. */
  files: PickedFile[];
  /**
   * Images next to a RAW file of the same name, in the same folder (RAW + JPEG): left
   * out unless asked for (`withPairs`).
   */
  pairs: PickedFile[];
  /** Files picked one by one that aren't RAW files or images (reported, as the user chose them). */
  refused: PickedFile[];
  /** Files in the folders that aren't RAW files or images, or are hidden: left out quietly. */
  ignored: number;
  /** A name for it: the folder, if one was picked alone. */
  label: string | null;
}

const extension = (name: string) => name.slice(name.lastIndexOf('.')).toLowerCase();
const RAW_EXTENSIONS = new Set(RAW_ACCEPT.split(','));
const IMAGE_EXTENSIONS = new Set(IMAGE_ACCEPT.split(','));
export const isRaw = (name: string) => RAW_EXTENSIONS.has(extension(name));
/** An image that isn't a RAW file (JPEG, PNG, TIFF, WebP). */
export const isImage = (name: string) => IMAGE_EXTENSIONS.has(extension(name));
/** What can be imported: a RAW file or an image. */
export const isPhoto = (name: string) => isRaw(name) || isImage(name);
/** A file's path without its extension, for matching a JPEG with its RAW. */
const stem = (path: string) => path.slice(0, path.lastIndexOf('.')).toLowerCase();
/** Hidden files and folders (`.Trashes`, macOS's `._DSC01234.ARW`). */
const isHidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

/** Sort out `list`: files in folders have a `/` in their path. */
export function sortPicked(list: readonly PickedFile[]): Picked {
  const photos: PickedFile[] = [];
  const refused: PickedFile[] = [];
  let ignored = 0;
  for (const f of list) {
    const inFolder = f.path.includes('/');
    if (isPhoto(f.path) && !isHidden(f.path)) photos.push(f);
    else if (inFolder) ignored++;
    else refused.push(f);
  }
  const raws = new Set(photos.filter((f) => isRaw(f.path)).map((f) => stem(f.path)));
  const paired = (f: PickedFile) => isImage(f.path) && raws.has(stem(f.path));
  const tops = new Set(list.map((f) => f.path.split('/')[0]!));
  const top = tops.size === 1 ? [...tops][0]! : null;
  return {
    files: byPath(photos.filter((f) => !paired(f))),
    pairs: byPath(photos.filter(paired)),
    refused,
    ignored,
    label: top && list.every((f) => f.path.includes('/')) ? top : null,
  };
}

const byPath = (files: PickedFile[]) => files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

/** `picked` with the images next to their RAW files imported too, if `include`. */
export function withPairs(picked: Picked, include: boolean): Picked {
  if (!include || !picked.pairs.length) return picked;
  return { ...picked, files: byPath([...picked.files, ...picked.pairs]), pairs: [] };
}

/** From an `<input type="file">`, with `webkitdirectory` or not. */
export function fromInput(list: FileList | readonly File[]): PickedFile[] {
  return [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/**
 * From a drop. The entries must be taken during the drop event (the list is emptied
 * after it), so call this synchronously in the handler; the walk goes on after.
 */
export function fromDrop(data: DataTransfer): Promise<PickedFile[]> {
  const entries = [...data.items].flatMap((item) => {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    return entry ? [entry] : [];
  });
  // Without entries (an old browser), only files: a folder would be an empty one.
  if (!entries.length) return Promise.resolve(fromInput(data.files));
  return walk(entries);
}

/** The minimal part of `FileSystemEntry` used (tests fake it). */
export interface Entry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(success: (file: File) => void, error?: (err: unknown) => void): void;
  createReader?(): { readEntries(success: (entries: Entry[]) => void, error?: (err: unknown) => void): void };
}

/** The files in `entries`, folders walked through. */
export async function walk(entries: readonly Entry[], prefix = ''): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const entry of entries) {
    const path = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      out.push({ file, path });
    } else if (entry.isDirectory) {
      // Hidden folders (`.Trashes`, `.Spotlight-V100`) aren't walked at all.
      if (entry.name.startsWith('.')) continue;
      const reader = entry.createReader!();
      // At most 100 entries at a time (Chrome): read until an empty batch.
      for (;;) {
        const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        out.push(...(await walk(batch, `${path}/`)));
      }
    }
  }
  return out;
}

// ── Handles (File System Access: Chrome, Edge) ──────────────────────────────
// A picker or a drop can give handles instead of files: kept with an import, they open
// the same files again after a reload (`importQueue.ts`), with the user's permission.

/** The part of `FileSystemHandle` used (the DOM typings lack iteration; tests fake it). */
export interface Handle {
  kind: 'file' | 'directory';
  name: string;
  getFile?(): Promise<File>;
  entries?(): AsyncIterable<[string, Handle]>;
  queryPermission?(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' }): Promise<PermissionState>;
}

/** Where an import's files came from: to pick or open them again after a reload. */
export interface PickedFrom {
  kind: 'files' | 'folder';
  /** Kept to open them again (none: this browser can't). */
  handles: Handle[] | null;
}

/** The files in `handles`, folders walked through (hidden ones left out), with their paths. */
export async function walkHandles(handles: readonly Handle[], prefix = ''): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const h of handles) {
    const path = prefix + h.name;
    if (h.kind === 'file') out.push({ file: await h.getFile!(), path });
    else if (!h.name.startsWith('.')) {
      const children: Handle[] = [];
      for await (const [, child] of h.entries!()) children.push(child);
      out.push(...(await walkHandles(children, `${path}/`)));
    }
  }
  return out;
}

interface Pickers {
  showDirectoryPicker?(o?: { id?: string; mode?: 'read' }): Promise<Handle>;
  showOpenFilePicker?(o?: {
    id?: string;
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<Handle[]>;
}
const pickers = globalThis as unknown as Pickers;
/** Whether this browser keeps what was picked across a reload. */
export const keepsHandles = () => typeof pickers.showDirectoryPicker === 'function';

const cancelled = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

/** A folder, through the browser's picker: null if cancelled. */
export async function pickFolder(): Promise<{ files: Promise<PickedFile[]>; from: PickedFrom } | null> {
  try {
    const dir = await pickers.showDirectoryPicker!({ id: 'import', mode: 'read' });
    return { files: walkHandles([dir]), from: { kind: 'folder', handles: [dir] } };
  } catch (err) {
    if (cancelled(err)) return null;
    throw err;
  }
}

/** RAW files and images, through the browser's picker: null if cancelled. */
export async function pickFiles(): Promise<{ files: Promise<PickedFile[]>; from: PickedFrom } | null> {
  try {
    const handles = await pickers.showOpenFilePicker!({
      id: 'import',
      multiple: true,
      types: [{ description: 'RAW files and images', accept: { 'application/octet-stream': PHOTO_ACCEPT.split(',') } }],
    });
    return { files: walkHandles(handles), from: { kind: 'files', handles } };
  } catch (err) {
    if (cancelled(err)) return null;
    throw err;
  }
}

/**
 * A drop's handles, where the browser gives them: like `fromDrop`, taken during the
 * event. Null where it doesn't (then `fromDrop`).
 */
export function fromDropHandles(data: DataTransfer): { files: Promise<PickedFile[]>; from: PickedFrom } | null {
  const items = [...data.items].filter((i) => i.kind === 'file') as (DataTransferItem & {
    getAsFileSystemHandle?(): Promise<Handle | null>;
  })[];
  if (!items.length || !items.every((i) => typeof i.getAsFileSystemHandle === 'function')) return null;
  const handles = Promise.all(items.map((i) => i.getAsFileSystemHandle!())).then((hs) =>
    hs.filter((h): h is Handle => !!h),
  );
  const from: PickedFrom = { kind: 'files', handles: [] };
  return {
    files: handles.then((hs) => {
      from.handles = hs;
      if (hs.some((h) => h.kind === 'directory')) from.kind = 'folder';
      return walkHandles(hs);
    }),
    from,
  };
}

/** Permission to read `handles` again (asked, in a click, if needed). */
export async function reopen(handles: readonly Handle[]): Promise<boolean> {
  for (const h of handles) {
    const state = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (state !== 'granted' && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') return false;
  }
  return true;
}

/** Same file: name, size and modification time (as the server finds known files). */
export const sameFile = (a: { name: string; size: number; modified: number }, f: File) =>
  a.name === f.name && a.size === f.size && a.modified === f.lastModified;
