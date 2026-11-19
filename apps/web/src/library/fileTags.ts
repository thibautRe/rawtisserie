/**
 * What files say about themselves, read on import: tags, rating and colour label, from
 * XMP (embedded in an image, or a sidecar `.xmp` file next to a photo) and IPTC keywords
 * (JPEG). An imported photo gets those of its own file and sidecars, and a RAW file also
 * those of the JPEG next to it (a camera shooting both, tagged in another application),
 * whether that JPEG is imported or not. Only for photos new to the library.
 */
import { type ImportApp, detectImportedEdits } from '@rawtisserie/pipeline';
import type { ColorLabel } from '../api/types.ts';
import { type Picked, type PickedFile, duplicatesOf, isImage, isRaw, sidecarsOf, stem } from './pickedFiles.ts';

/** What a file carries: absent fields say nothing. */
export interface FileTags {
  /** Paths, levels separated by `|` (as the library has them). */
  tags?: string[];
  /** 1 … 5. */
  rating?: number;
  label?: ColorLabel;
  /** XMP's rating −1 (Lightroom's "rejected"). */
  rejected?: boolean;
  /**
   * Edits made in another application: a darktable or Ansel sidecar's text, imported
   * with the photo (`importedEdits.ts` in the pipeline package).
   */
  edits?: { app: ImportApp; text: string };
  /** The version's name there (darktable's `version_name`). */
  versionName?: string;
  /**
   * darktable's duplicates of the photo (`DSC01234_01.ARW.xmp`…, `duplicatesOf`): more
   * versions of it, each with what its own sidecar says.
   */
  duplicates?: FileTags[];
}

const LABELS: readonly ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The `rdf:li` items of property `name` (`dc:subject`), in an XMP packet. */
function items(xmp: string, name: string): string[] {
  const block = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xmp)?.[1];
  if (!block) return [];
  return [...block.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)]
    .map((m) => decodeEntities(m[1]!).trim())
    .filter(Boolean);
}

/** A simple property (`xmp:Rating`): an attribute or an element. */
function value(xmp: string, name: string): string | null {
  const attribute = new RegExp(`\\s${name}="([^"]*)"`).exec(xmp)?.[1];
  const element = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xmp)?.[1];
  const v = attribute ?? element;
  return v === undefined ? null : decodeEntities(v).trim();
}

const normalize = (tag: string) =>
  tag
    .split('|')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('|');

/**
 * Tags from flat keywords and hierarchical ones: the paths, and the keywords that aren't
 * a level of one (Lightroom writes every level as a keyword too).
 */
function combine(paths: string[], keywords: string[]): string[] {
  const levels = new Set(paths.flatMap((p) => p.split('|')).map((l) => l.toLowerCase()));
  const all = [...paths, ...keywords.filter((k) => !levels.has(k.toLowerCase()))].map(normalize).filter(Boolean);
  return [...new Set(all)];
}

/** Tags, rating and label from an XMP packet (or a sidecar file's text). */
export function parseXmp(xmp: string): FileTags {
  const out: FileTags = {};
  const paths = [
    // Lightroom, darktable, Capture One…
    ...items(xmp, 'lr:hierarchicalSubject'),
    // digiKam.
    ...items(xmp, 'digiKam:TagsList').map((t) => t.replaceAll('/', '|')),
  ];
  const tags = combine(paths, items(xmp, 'dc:subject'));
  if (tags.length) out.tags = tags;
  const rating = Number(value(xmp, 'xmp:Rating'));
  if (rating === -1) out.rejected = true;
  else if (Number.isInteger(rating) && rating >= 1 && rating <= 5) out.rating = rating;
  const name = value(xmp, 'xmp:Label')?.toLowerCase();
  const darktable = items(xmp, 'darktable:colorlabels').map(Number);
  const label =
    LABELS.find((l) => l === name) ??
    (name === 'violet' || name === 'magenta' ? 'purple' : undefined) ??
    LABELS[darktable.find((i) => i >= 0 && i < LABELS.length) ?? -1];
  if (label) out.label = label;
  return out;
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

/** The XMP packet in `bytes`, if there's one. */
export function findXmp(bytes: Uint8Array): string | null {
  // One character per byte, so offsets are byte offsets.
  const text = latin1.decode(bytes);
  const start = text.indexOf('<x:xmpmeta');
  if (start < 0) return null;
  const end = text.indexOf('</x:xmpmeta>', start);
  if (end < 0) return null;
  return utf8.decode(bytes.subarray(start, end + '</x:xmpmeta>'.length));
}

/** IPTC keywords (dataset 2:25) in a JPEG's Photoshop segment (APP13). */
export function iptcKeywords(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return [];
  const out: string[] = [];
  let at = 2;
  while (at + 4 <= view.byteLength && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    // Start of scan: no more metadata segments.
    if (marker === 0xda) break;
    const length = view.getUint16(at + 2);
    const data = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xed && latin1.decode(data.subarray(0, 14)) === 'Photoshop 3.0\0')
      out.push(...irb(data.subarray(14)));
    at += 2 + length;
  }
  return out;
}

/** Keywords in Photoshop image resource blocks (resource 0x0404: IPTC records). */
function irb(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: string[] = [];
  let at = 0;
  while (at + 12 <= data.length && latin1.decode(data.subarray(at, at + 4)) === '8BIM') {
    const id = view.getUint16(at + 4);
    const nameLength = data[at + 6]!;
    // A Pascal string, padded to an even length.
    at += 6 + ((nameLength + 2) & ~1);
    if (at + 4 > data.length) break;
    const size = view.getUint32(at);
    at += 4;
    const block = data.subarray(at, at + size);
    if (id === 0x0404) {
      for (let i = 0; i + 5 <= block.length && block[i] === 0x1c;) {
        const [record, dataset] = [block[i + 1], block[i + 2]];
        const len = (block[i + 3]! << 8) | block[i + 4]!;
        const raw = block.subarray(i + 5, i + 5 + len);
        if (record === 2 && dataset === 25) out.push(text(raw).trim());
        i += 5 + len;
      }
    }
    at += (size + 1) & ~1;
  }
  return out.filter(Boolean);
}

/** UTF-8 if it is, else Latin-1 (older IPTC). */
function text(raw: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return latin1.decode(raw);
  }
}

/**
 * Where a JPEG's metadata ends in `bytes`: the start of scan, all of it before. Past
 * `bytes.length` when it goes on further: how many bytes are needed to know more.
 */
export function jpegMetadataEnd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    // Not a marker: nothing more to read as metadata.
    if (bytes[at] !== 0xff || bytes[at + 1] === 0xda) return at;
    at += 2 + view.getUint16(at + 2);
  }
  return Math.max(at + 4, bytes.length + 1);
}

/** A JPEG's metadata is all before its image: this much is read first, more if it goes on. */
const JPEG_HEAD = 128 * 1024;

/** The start of a JPEG up to its image (its metadata), or null if it isn't one. */
async function jpegHead(file: Blob): Promise<Uint8Array | null> {
  for (let size = JPEG_HEAD; ;) {
    const bytes = new Uint8Array(await file.slice(0, size).arrayBuffer());
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const end = jpegMetadataEnd(bytes);
    // All there, or the file ends (cut short: what there is).
    if (end <= bytes.length || bytes.length < size) return bytes.subarray(0, Math.min(end, bytes.length));
    // The segment going on, and some for the next ones.
    size = Math.max(end + 64 * 1024, size * 2);
  }
}

/** Other images: metadata near the start, XMP sometimes at the end (TIFF, WebP). */
const HEAD = 1024 * 1024;
const TAIL = 256 * 1024;

/** What an image file carries in its XMP, or else its IPTC keywords. */
export async function readEmbedded(file: Blob): Promise<FileTags> {
  // A JPEG: only its metadata, never its image (a few hundred KB less from each file).
  const jpeg = await jpegHead(file);
  const head = jpeg ?? new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
  let xmp = findXmp(head);
  if (!xmp && !jpeg && file.size > HEAD) xmp = findXmp(new Uint8Array(await file.slice(-TAIL).arrayBuffer()));
  const found = xmp ? parseXmp(xmp) : {};
  if (!found.tags) {
    const keywords = combine([], iptcKeywords(head));
    if (keywords.length) found.tags = keywords;
  }
  return found;
}

/** Several files' worth, the first ones first: tags together, the first rating and label. */
export function mergeTags(all: readonly FileTags[]): FileTags {
  const out: FileTags = {};
  const tags = [...new Set(all.flatMap((t) => t.tags ?? []))];
  if (tags.length) out.tags = tags;
  const rating = all.find((t) => t.rating)?.rating;
  if (rating) out.rating = rating;
  const label = all.find((t) => t.label)?.label;
  if (label) out.label = label;
  if (!rating && all.some((t) => t.rejected)) out.rejected = true;
  const edits = all.find((t) => t.edits)?.edits;
  if (edits) out.edits = edits;
  const versionName = all.find((t) => t.versionName)?.versionName;
  if (versionName) out.versionName = versionName;
  return out;
}

export const isEmpty = (t: FileTags) =>
  !t.tags && !t.rating && !t.label && !t.rejected && !t.edits && !t.versionName && !t.duplicates?.length;

/** A sidecar's tags, rating and label, its version name, and the edits it holds if we import them. */
export function readSidecar(text: string): FileTags {
  const out = parseXmp(text);
  const app = detectImportedEdits(text);
  if (app) out.edits = { app, text };
  const versionName = value(text, 'darktable:version_name');
  if (versionName) out.versionName = versionName;
  return out;
}

/** Files read at a time: a disk's seeks overlap (a USB hard disk: 3.5 times faster than one by one). */
const READS = 8;

/**
 * What each photo picked (files and pairs) gets from its files: its sidecars first, then
 * what it carries itself (images), then, for a RAW file, the JPEGs next to it. Only
 * photos that get something are in the map. Photos in `skip` (the library has them)
 * aren't read; `progress.done` counts the photos read, out of `photosToRead`. Stops
 * reading when `signal` aborts (what it has then is all it gives).
 */
export async function readFileTags(
  picked: Picked,
  {
    skip,
    progress,
    signal,
  }: { skip?: ReadonlySet<PickedFile>; progress?: { done: number }; signal?: AbortSignal } = {},
): Promise<Map<PickedFile, FileTags>> {
  const embedded = new Map<PickedFile, Promise<FileTags>>();
  const own = (f: PickedFile) => {
    if (!embedded.has(f))
      embedded.set(
        f,
        readEmbedded(f.file).catch(() => ({})),
      );
    return embedded.get(f)!;
  };
  const sidecar = async (f: PickedFile) => readSidecar(await f.file.text());
  const all = [...picked.files, ...picked.pairs];
  const images = new Map<string, PickedFile[]>();
  for (const f of all.filter((f) => isImage(f.path)))
    images.set(stem(f.path), [...(images.get(stem(f.path)) ?? []), f]);
  const photos = photosToRead(picked, skip);
  const out = new Map<PickedFile, FileTags>();
  let next = 0;
  const reader = async () => {
    while (next < photos.length && !signal?.aborted) {
      const f = photos[next++]!;
      const sources = await Promise.all([
        ...sidecarsOf(picked, f.path).map((s) => sidecar(s).catch(() => ({}))),
        ...(isImage(f.path) ? [own(f)] : []),
        ...(isRaw(f.path) ? (images.get(stem(f.path)) ?? []).map(own) : []),
      ]);
      const merged = mergeTags(sources);
      // Each duplicate is a version of its own: only its sidecar.
      const duplicates = await Promise.all(duplicatesOf(picked, f.path).map((s) => sidecar(s).catch(() => ({}))));
      if (duplicates.length) merged.duplicates = duplicates;
      if (!isEmpty(merged)) out.set(f, merged);
      if (progress) progress.done++;
    }
  };
  await Promise.all(Array.from({ length: READS }, reader));
  return out;
}

/** The photos `readFileTags` reads (files and pairs, but those in `skip`). */
export const photosToRead = (picked: Picked, skip?: ReadonlySet<PickedFile>) =>
  [...picked.files, ...picked.pairs].filter((f) => !skip?.has(f));
