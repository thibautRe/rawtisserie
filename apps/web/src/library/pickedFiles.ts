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
  /**
   * XMP sidecars (`DSC01234.xmp`, `DSC01234.ARW.xmp`, darktable's duplicates
   * `DSC01234_01.ARW.xmp`), read for their photos' tags, rating, label and edits
   * (`fileTags.ts`), not imported.
   */
  sidecars: PickedFile[];
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
/** A file's path without its extension, lower case, for matching a JPEG with its RAW. */
export const stem = (path: string) => path.slice(0, path.lastIndexOf('.')).toLowerCase();
const isSidecar = (name: string) => extension(name) === '.xmp';

/** The sidecars of the photo at `path`: `DSC01234.xmp` (Lightroom) or `DSC01234.ARW.xmp` (darktable). */
export function sidecarsOf(picked: Pick<Picked, 'sidecars'>, path: string): PickedFile[] {
  const names = new Set([`${stem(path)}.xmp`, `${path.toLowerCase()}.xmp`]);
  return picked.sidecars.filter((s) => names.has(s.path.toLowerCase()));
}
/**
 * darktable's duplicates of the photo at `path`: `DSC01234_01.ARW.xmp`, `_02`… (each an
 * edit of its own, a version here), in their order. A sidecar that's a picked photo's own
 * (`DSC01234_01.ARW` picked too) isn't one.
 */
export function duplicatesOf(picked: Pick<Picked, 'sidecars' | 'files' | 'pairs'>, path: string): PickedFile[] {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return [];
  const [base, ext] = [lower.slice(0, dot), lower.slice(dot)];
  const own = new Set([...picked.files, ...picked.pairs].map((f) => `${f.path.toLowerCase()}.xmp`));
  const number = (s: PickedFile) => {
    const p = s.path.toLowerCase();
    if (!p.startsWith(`${base}_`) || !p.endsWith(`${ext}.xmp`) || own.has(p)) return null;
    const n = p.slice(base.length + 1, p.length - ext.length - 4);
    return /^\d+$/.test(n) ? Number(n) : null;
  };
  return picked.sidecars
    .map((s) => [s, number(s)] as const)
    .filter((e): e is readonly [PickedFile, number] => e[1] !== null)
    .sort((a, b) => a[1] - b[1])
    .map(([s]) => s);
}
/** Hidden files and folders (`.Trashes`, macOS's `._DSC01234.ARW`). */
const isHidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

/** Sort out `list`: files in folders have a `/` in their path. */
export function sortPicked(list: readonly PickedFile[]): Picked {
  const photos: PickedFile[] = [];
  const sidecars: PickedFile[] = [];
  const refused: PickedFile[] = [];
  let ignored = 0;
  for (const f of list) {
    const inFolder = f.path.includes('/');
    if (isPhoto(f.path) && !isHidden(f.path)) photos.push(f);
    else if (isSidecar(f.path) && !isHidden(f.path)) sidecars.push(f);
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
    sidecars,
    refused,
    ignored,
    label: top && list.every((f) => f.path.includes('/')) ? top : null,
  };
}

const byPath = (files: PickedFile[]) =>
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

/** `picked` with the images next to their RAW files imported too, if `include`. */
export function withPairs(picked: Picked, include: boolean): Picked {
  if (!include || !picked.pairs.length) return picked;
  return { ...picked, files: byPath([...picked.files, ...picked.pairs]), pairs: [] };
}

/** How a walk through folders goes: files found so far (read while it goes on, for the review). */
export interface Listing {
  found: number;
}

/** From an `<input type="file">`, with `webkitdirectory` or not. */
export function fromInput(list: FileList | readonly File[]): PickedFile[] {
  return [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/**
 * From a drop. The entries must be taken during the drop event (the list is emptied
 * after it), so call this synchronously in the handler; the walk goes on after.
 */
export function fromDrop(data: DataTransfer, listing?: Listing): Promise<PickedFile[]> {
  const entries = [...data.items].flatMap((item) => {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    return entry ? [entry] : [];
  });
  // Without entries (an old browser), only files: a folder would be an empty one.
  if (!entries.length) return Promise.resolve(fromInput(data.files));
  return walk(entries, '', listing);
}

/** The minimal part of `FileSystemEntry` used (tests fake it). */
export interface Entry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(success: (file: File) => void, error?: (err: unknown) => void): void;
  createReader?(): { readEntries(success: (entries: Entry[]) => void, error?: (err: unknown) => void): void };
}

/**
 * The files in `entries`, folders walked through, counted in `listing` as they're found.
 * A folder's files are asked for together (one by one, a large folder took minutes).
 */
export async function walk(entries: readonly Entry[], prefix = '', listing?: Listing): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  // Asked for at once, taken in order.
  const files = entries.map((entry) =>
    entry.isFile
      ? new Promise<File>((resolve, reject) => entry.file!(resolve, reject)).then((file) => {
          if (listing) listing.found++;
          return file;
        })
      : null,
  );
  // A rejection is the walk's, when it gets to it (not an unhandled one before).
  for (const f of files) f?.catch(() => {});
  for (const [i, entry] of entries.entries()) {
    const path = prefix + entry.name;
    if (files[i]) out.push({ file: await files[i], path });
    else if (entry.isDirectory) {
      // Hidden folders (`.Trashes`, `.Spotlight-V100`) aren't walked at all.
      if (entry.name.startsWith('.')) continue;
      const reader = entry.createReader!();
      // At most 100 entries at a time (Chrome): read until an empty batch.
      for (;;) {
        const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        out.push(...(await walk(batch, `${path}/`, listing)));
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

/**
 * The files in `handles`, folders walked through (hidden ones left out), with their
 * paths, counted in `listing` as they're found. A folder's files are opened together.
 */
export async function walkHandles(handles: readonly Handle[], prefix = '', listing?: Listing): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  // Opened at once, taken in order.
  const files = handles.map((h) =>
    h.kind === 'file'
      ? h.getFile!().then((file) => {
          if (listing) listing.found++;
          return file;
        })
      : null,
  );
  for (const f of files) f?.catch(() => {});
  for (const [i, h] of handles.entries()) {
    const path = prefix + h.name;
    if (files[i]) out.push({ file: await files[i], path });
    else if (!h.name.startsWith('.')) {
      const children: Handle[] = [];
      for await (const [, child] of h.entries!()) children.push(child);
      out.push(...(await walkHandles(children, `${path}/`, listing)));
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

/** Files being picked: walked through (`files`), counted as they're found (`listing`). */
export interface Picking {
  files: Promise<PickedFile[]>;
  from: PickedFrom;
  listing: Listing;
}

/** A folder, through the browser's picker: null if cancelled. */
export async function pickFolder(): Promise<Picking | null> {
  try {
    const dir = await pickers.showDirectoryPicker!({ id: 'import', mode: 'read' });
    const listing = { found: 0 };
    return { files: walkHandles([dir], '', listing), from: { kind: 'folder', handles: [dir] }, listing };
  } catch (err) {
    if (cancelled(err)) return null;
    throw err;
  }
}

/** RAW files and images, through the browser's picker: null if cancelled. */
export async function pickFiles(): Promise<Picking | null> {
  try {
    const handles = await pickers.showOpenFilePicker!({
      id: 'import',
      multiple: true,
      types: [{ description: 'RAW files and images', accept: { 'application/octet-stream': PHOTO_ACCEPT.split(',') } }],
    });
    const listing = { found: 0 };
    return { files: walkHandles(handles, '', listing), from: { kind: 'files', handles }, listing };
  } catch (err) {
    if (cancelled(err)) return null;
    throw err;
  }
}

/**
 * A drop's handles, where the browser gives them: like `fromDrop`, taken during the
 * event. Null where it doesn't (then `fromDrop`).
 */
export function fromDropHandles(data: DataTransfer): Picking | null {
  const items = [...data.items].filter((i) => i.kind === 'file') as (DataTransferItem & {
    getAsFileSystemHandle?(): Promise<Handle | null>;
  })[];
  if (!items.length || !items.every((i) => typeof i.getAsFileSystemHandle === 'function')) return null;
  const handles = Promise.all(items.map((i) => i.getAsFileSystemHandle!())).then((hs) =>
    hs.filter((h): h is Handle => !!h),
  );
  const from: PickedFrom = { kind: 'files', handles: [] };
  const listing = { found: 0 };
  return {
    files: handles.then((hs) => {
      from.handles = hs;
      if (hs.some((h) => h.kind === 'directory')) from.kind = 'folder';
      return walkHandles(hs, '', listing);
    }),
    from,
    listing,
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
