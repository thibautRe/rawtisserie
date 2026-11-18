/**
 * When a photo was taken, read on import from the start of its file (roadmap 8.14: a
 * collection per day or per shoot is made before anything is sent). EXIF's
 * `DateTimeOriginal`, as the camera wrote it: local time, no zone, so the day is the
 * one on the camera's clock. From TIFF-based RAW files (ARW, NEF, CR2, DNG, ORF, RW2,
 * PEF…), JPEGs, Fujifilm's RAF (its JPEG's) and Canon's CR3 (its `CMT2` box). Else, the
 * file's modification time (a card's files keep the camera's).
 */

/** A capture time: `2026-11-09T18:42:07`, local to the camera, no zone. */
export type CaptureTime = string;

/** Read first: a file's metadata is near its start. */
const HEAD = 128 * 1024;

const EXIF_DATE = /(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const TAG = { dateTime: 0x0132, exif: 0x8769, original: 0x9003, digitized: 0x9004 } as const;

/** `2026:11:09 18:42:07` → `2026-11-09T18:42:07`; null for zeros and the like. */
export function exifDate(text: string): CaptureTime | null {
  const m = EXIF_DATE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (y === '0000' || mo === '00' || d === '00') return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/** The local time of `ms` (a file's modification time), as a capture time. */
export function localTime(ms: number): CaptureTime {
  const t = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

/** Bytes of a file by offset, read as needed (the head once). */
type Read = (offset: number, length: number) => Promise<Uint8Array>;

function reader(file: Blob): Read {
  let head: Promise<Uint8Array> | null = null;
  return async (offset, length) => {
    if (offset + length <= HEAD) {
      head ??= file
        .slice(0, HEAD)
        .arrayBuffer()
        .then((b) => new Uint8Array(b));
      return (await head).subarray(offset, offset + length);
    }
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  };
}

/**
 * The date in a TIFF structure starting at `start`: `DateTimeOriginal` in IFD0 (CR3's
 * `CMT2` is an EXIF IFD on its own) or in its EXIF IFD, else IFD0's `DateTime`.
 */
async function tiffDate(read: Read, start: number): Promise<CaptureTime | null> {
  const header = await read(start, 8);
  if (header.length < 8) return null;
  const order = (header[0]! << 8) | header[1]!;
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at, little);
  const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, little);

  /** An IFD's entries we look for: tag → value (or offset) and count. */
  const ifd = async (offset: number) => {
    const out = new Map<number, { value: number; count: number; inline: Uint8Array }>();
    const countBytes = await read(start + offset, 2);
    if (countBytes.length < 2) return out;
    const n = u16(countBytes, 0);
    if (!n || n > 1000) return out;
    const entries = await read(start + offset + 2, n * 12);
    for (let i = 0; i + 12 <= entries.length; i += 12) {
      const tag = u16(entries, i);
      if (Object.values(TAG).includes(tag as never))
        out.set(tag, {
          value: u32(entries, i + 8),
          count: u32(entries, i + 4),
          inline: entries.subarray(i + 8, i + 12),
        });
    }
    return out;
  };
  const ascii = async (e: { value: number; count: number; inline: Uint8Array } | undefined) => {
    if (!e || e.count < 19 || e.count > 64) return null;
    const bytes = await read(start + e.value, e.count);
    return exifDate(new TextDecoder('latin1').decode(bytes));
  };

  const ifd0 = await ifd(u32(header, 4));
  const own = (await ascii(ifd0.get(TAG.original))) ?? (await ascii(ifd0.get(TAG.digitized)));
  if (own) return own;
  const exifAt = ifd0.get(TAG.exif)?.value;
  if (exifAt) {
    const exif = await ifd(exifAt);
    const found = (await ascii(exif.get(TAG.original))) ?? (await ascii(exif.get(TAG.digitized)));
    if (found) return found;
  }
  return ascii(ifd0.get(TAG.dateTime));
}

/** A JPEG's EXIF (its APP1 segment), at `start` in the file. */
async function jpegDate(read: Read, start: number): Promise<CaptureTime | null> {
  const bytes = await read(start, 64 * 1024);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker === 0xda) return null;
    // "Exif\0\0", then the TIFF structure.
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'Exif')
      return tiffDate(read, start + at + 10);
    at += 2 + length;
  }
  return null;
}

const indexOf = (bytes: Uint8Array, text: string) => {
  const codes = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + codes.length <= bytes.length; i++) {
    for (let j = 0; j < codes.length; j++) if (bytes[i + j] !== codes[j]) continue outer;
    return i;
  }
  return -1;
};

/** The EXIF capture time of `file`, or null if it has none we read. */
export async function readExifTime(file: Blob): Promise<CaptureTime | null> {
  const read = reader(file);
  const head = await read(0, Math.min(HEAD, file.size));
  const magic = new TextDecoder('latin1').decode(head.subarray(0, 16));
  let found: CaptureTime | null = null;
  if (head[0] === 0xff && head[1] === 0xd8) found = await jpegDate(read, 0);
  else if (magic.startsWith('FUJIFILMCCD-RAW')) {
    // The JPEG inside holds the EXIF: its offset, big-endian, at byte 84.
    const at = new DataView(head.buffer, head.byteOffset).getUint32(84, false);
    found = await jpegDate(read, at);
  } else if (magic.startsWith('II') || magic.startsWith('MM')) found = await tiffDate(read, 0);
  else if (magic.slice(4, 8) === 'ftyp') {
    // CR3 (ISO base media): the EXIF IFD is box CMT2, a TIFF structure after its header.
    const cmt2 = indexOf(head, 'CMT2');
    if (cmt2 >= 0) found = await tiffDate(read, cmt2 + 4);
  }
  // Something else, or a layout we don't know: a date as EXIF writes them, if there's one.
  return found ?? exifDate(new TextDecoder('latin1').decode(head));
}

/** When `file` was taken: its EXIF, else its modification time. */
export async function readCaptureTime(file: File): Promise<CaptureTime> {
  return (await readExifTime(file).catch(() => null)) ?? localTime(file.lastModified);
}

/** Files read at a time (as `readFileTags`: a disk's seeks overlap). */
const READS = 8;

/** The capture times of `files`; `progress.done` counts those read. Stops reading when `signal` aborts. */
export async function readCaptureTimes<F extends { file: File }>(
  files: readonly F[],
  { progress, signal }: { progress?: { done: number }; signal?: AbortSignal } = {},
): Promise<Map<F, CaptureTime>> {
  const out = new Map<F, CaptureTime>();
  let next = 0;
  const reader = async () => {
    while (next < files.length && !signal?.aborted) {
      const f = files[next++]!;
      out.set(f, await readCaptureTime(f.file));
      if (progress) progress.done++;
    }
  };
  await Promise.all(Array.from({ length: READS }, reader));
  return out;
}
