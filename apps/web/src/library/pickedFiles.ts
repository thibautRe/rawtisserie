/**
 * Files picked for an import (roadmap 8.2): from a file or folder picker, or dropped
 * (files, folders, a card's `DCIM`), with their path inside what was picked. Folders are
 * walked through, and what isn't a RAW file is left out (cards hold JPEGs, videos and
 * macOS's `._` files next to the RAWs).
 */
import { RAW_ACCEPT } from '../lib/format.ts';

export interface PickedFile {
  file: File;
  /** Inside what was picked: `DCIM/100MSDCF/DSC01234.ARW`, or the name of a file picked alone. */
  path: string;
}

/** What was picked, sorted out. */
export interface Picked {
  /** The RAW files to import, by path. */
  files: PickedFile[];
  /** Files picked one by one that aren't RAW files (reported, as the user chose them). */
  refused: PickedFile[];
  /** Files in the folders that aren't RAW files, or are hidden: left out quietly. */
  ignored: number;
  /** A name for it: the folder, if one was picked alone. */
  label: string | null;
}

const RAW_EXTENSIONS = new Set(RAW_ACCEPT.split(','));
export const isRaw = (name: string) => RAW_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase());
/** Hidden files and folders (`.Trashes`, macOS's `._DSC01234.ARW`). */
const isHidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

/** Sort out `list`: files in folders have a `/` in their path. */
export function sortPicked(list: readonly PickedFile[]): Picked {
  const files: PickedFile[] = [];
  const refused: PickedFile[] = [];
  let ignored = 0;
  for (const f of list) {
    const inFolder = f.path.includes('/');
    if (isRaw(f.path) && !isHidden(f.path)) files.push(f);
    else if (inFolder) ignored++;
    else refused.push(f);
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const tops = new Set(list.map((f) => f.path.split('/')[0]!));
  const top = tops.size === 1 ? [...tops][0]! : null;
  return { files, refused, ignored, label: top && list.every((f) => f.path.includes('/')) ? top : null };
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
