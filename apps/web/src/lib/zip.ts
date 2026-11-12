/**
 * A ZIP archive written as files arrive, without compression (exported JPEG, PNG and
 * TIFF files don't get smaller), to a `ZipSink`: a file on disk (`export/spool.ts`), or
 * memory. ZIP64 records are added for whatever passes 4 GB (or 65,535 files).
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
/** Names are UTF-8 (general purpose flag bit 11). */
const UTF8 = 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 (ISO-HDLC, as ZIP uses), continuing from `crc` for data in several pieces. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = crcTable();
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** MS-DOS date and time, as ZIP stores them (local time, two-second steps, 1980 on). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** Where an archive is written, in order. */
export interface ZipSink {
  write(part: Blob | ArrayBuffer): Promise<void>;
  /** Cut what's been written back to `size` bytes (after a failed write). */
  truncate(size: number): Promise<void>;
  /** The archive, once everything is written. */
  close(): Promise<Blob>;
  /** Drop what's been written. */
  discard(): Promise<void>;
}

/** An archive in memory: a `Blob` of the parts (the browser may keep large ones on disk, or not). */
export function memorySink(): ZipSink {
  let parts: (Blob | ArrayBuffer)[] = [];
  const size = (p: Blob | ArrayBuffer) => (p instanceof Blob ? p.size : p.byteLength);
  return {
    write: async (part) => void parts.push(part),
    truncate: async (to) => {
      let total = parts.reduce((n, p) => n + size(p), 0);
      while (total > to && parts.length) total -= size(parts.pop()!);
    },
    close: async () => new Blob(parts, { type: 'application/zip' }),
    discard: async () => void (parts = []),
  };
}

export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;
  private names = new Set<string>();
  /** Files are written one after the other, whatever order their CRCs are ready in. */
  private queue: Promise<void> = Promise.resolve();
  /** Set when a write failed: the archive keeps what was written before, and takes nothing more. */
  private broken: Error | null = null;
  private readonly sink: ZipSink;
  /** Entries past this size or offset get ZIP64 fields (lowered by tests). */
  private readonly limit32: number;

  constructor(sink: ZipSink = memorySink(), limit32 = MAX32) {
    this.sink = sink;
    this.limit32 = limit32;
  }

  /** Why the archive takes no more files, once a write failed. */
  get error(): Error | null {
    return this.broken;
  }

  /** Bytes written so far, before the directory. */
  get size(): number {
    return this.offset;
  }

  get count(): number {
    return this.entries.length;
  }

  /** Whether a file is already called `name`. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  /**
   * Add a file. Its data is read once for its CRC, then written. Several may be added
   * at once: they're written in turn. A file that fails to be written isn't listed.
   */
  async add(name: string, data: Blob, modified = new Date()): Promise<void> {
    if (this.names.has(name)) throw new Error(`Duplicate file name in the archive: ${name}`);
    this.names.add(name);
    try {
      const crc = await blobCrc(data);
      const write = this.queue.then(() => this.write(name, data, crc, modified));
      // The next file waits for this one, written or not.
      this.queue = write.catch(() => {});
      await write;
    } catch (err) {
      this.names.delete(name);
      throw err;
    }
  }

  private async write(name: string, data: Blob, crc: number, modified: Date) {
    const encoded = new TextEncoder().encode(name);
    const { time, date } = dosDateTime(modified);
    const entry: Entry = { name: encoded, crc, size: data.size, offset: this.offset, time, date };
    const zip64 = entry.size >= this.limit32;
    const header = new DataView(new ArrayBuffer(30 + encoded.length + (zip64 ? 20 : 0)));
    header.setUint32(0, LOCAL, true);
    header.setUint16(4, zip64 ? 45 : 20, true);
    header.setUint16(6, UTF8, true);
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, zip64 ? MAX32 : entry.size, true);
    header.setUint32(22, zip64 ? MAX32 : entry.size, true);
    header.setUint16(26, encoded.length, true);
    header.setUint16(28, zip64 ? 20 : 0, true);
    new Uint8Array(header.buffer).set(encoded, 30);
    if (zip64) {
      const at = 30 + encoded.length;
      header.setUint16(at, 0x0001, true);
      header.setUint16(at + 2, 16, true);
      header.setBigUint64(at + 4, BigInt(entry.size), true);
      header.setBigUint64(at + 12, BigInt(entry.size), true);
    }
    if (this.broken) throw this.broken;
    try {
      await this.sink.write(header.buffer);
      await this.sink.write(data);
    } catch (err) {
      // Whatever part of it was written goes; the directory can still list the others.
      await this.sink.truncate(this.offset).catch(() => {});
      this.broken = new Error(`The archive could not be written (${err instanceof Error ? err.message : err})`);
      throw this.broken;
    }
    this.offset += header.byteLength + data.size;
    this.entries.push(entry);
  }

  /** Drop the archive. */
  async discard(): Promise<void> {
    await this.queue;
    await this.sink.discard();
  }

  /** The archive: the files added, then the central directory. */
  async finish(): Promise<Blob> {
    await this.queue;
    const directory: ArrayBuffer[] = [];
    let size = 0;
    for (const e of this.entries) {
      const bigSize = e.size >= this.limit32;
      const bigOffset = e.offset >= this.limit32;
      const extra = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
      const record = new DataView(new ArrayBuffer(46 + e.name.length + (extra ? 4 + extra : 0)));
      const version = extra ? 45 : 20;
      record.setUint32(0, CENTRAL, true);
      record.setUint16(4, version, true);
      record.setUint16(6, version, true);
      record.setUint16(8, UTF8, true);
      record.setUint16(10, 0, true);
      record.setUint16(12, e.time, true);
      record.setUint16(14, e.date, true);
      record.setUint32(16, e.crc, true);
      record.setUint32(20, bigSize ? MAX32 : e.size, true);
      record.setUint32(24, bigSize ? MAX32 : e.size, true);
      record.setUint16(28, e.name.length, true);
      record.setUint16(30, extra ? 4 + extra : 0, true);
      // Comment length, disk, internal and external attributes: 0.
      record.setUint32(42, bigOffset ? MAX32 : e.offset, true);
      new Uint8Array(record.buffer).set(e.name, 46);
      if (extra) {
        let at = 46 + e.name.length;
        record.setUint16(at, 0x0001, true);
        record.setUint16(at + 2, extra, true);
        at += 4;
        // In this order, and only the fields that overflowed.
        if (bigSize) {
          record.setBigUint64(at, BigInt(e.size), true);
          record.setBigUint64(at + 8, BigInt(e.size), true);
          at += 16;
        }
        if (bigOffset) record.setBigUint64(at, BigInt(e.offset), true);
      }
      directory.push(record.buffer);
      size += record.byteLength;
    }
    const start = this.offset;
    const count = this.entries.length;
    const zip64 = count >= MAX16 || start >= this.limit32 || size >= this.limit32;
    const tail: ArrayBuffer[] = [];
    if (zip64) {
      const end64 = new DataView(new ArrayBuffer(56 + 20));
      end64.setUint32(0, END64, true);
      end64.setBigUint64(4, 44n, true);
      end64.setUint16(12, 45, true);
      end64.setUint16(14, 45, true);
      // This disk and the directory's: 0.
      end64.setBigUint64(24, BigInt(count), true);
      end64.setBigUint64(32, BigInt(count), true);
      end64.setBigUint64(40, BigInt(size), true);
      end64.setBigUint64(48, BigInt(start), true);
      end64.setUint32(56, LOCATOR64, true);
      end64.setBigUint64(64, BigInt(start + size), true);
      end64.setUint32(72, 1, true);
      tail.push(end64.buffer);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END, true);
    end.setUint16(8, zip64 ? MAX16 : count, true);
    end.setUint16(10, zip64 ? MAX16 : count, true);
    end.setUint32(12, zip64 ? MAX32 : size, true);
    end.setUint32(16, zip64 ? MAX32 : start, true);
    tail.push(end.buffer);
    for (const part of [...directory, ...tail]) await this.sink.write(part);
    return this.sink.close();
  }
}

/** A blob's CRC-32, read in slices so a large file isn't copied whole. */
async function blobCrc(data: Blob): Promise<number> {
  const SLICE = 16 << 20;
  let crc = 0;
  for (let at = 0; at < data.size; at += SLICE) {
    crc = crc32(new Uint8Array(await data.slice(at, at + SLICE).arrayBuffer()), crc);
  }
  return crc;
}
