/**
 * A library export's archive, in parts: when the next file would take the current ZIP
 * past `limit`, that ZIP is finished and saved (downloaded) and the next one starts.
 * Saving a part deletes the one before it from where it was written, so a large export
 * holds at most two parts there (the browser's storage quota is ~10 GiB in Firefox).
 */
import { type ZipSink, ZipWriter } from '../lib/zip.ts';

/** A part's size at most (unless one file is larger), so two fit in Firefox's quota with room. */
export const PART_SIZE = 2 * 2 ** 30;

/** A file's headers in a ZIP, beyond its name: local (with ZIP64) and central (with ZIP64). */
const ENTRY_OVERHEAD = 30 + 20 + 46 + 28;

export class PartedArchive {
  /** Files in the archive, all parts together. */
  count = 0;
  private current: ZipWriter | null = null;
  /** The part saved last, deleted when the next is saved. */
  private previous: ZipWriter | null = null;
  private saved = 0;
  /** Files are added one at a time, so a part is closed between two of them. */
  private lock: Promise<void> = Promise.resolve();
  private readonly newSink: () => Promise<ZipSink>;
  private readonly limit: number;
  private readonly save: (blob: Blob, part: number) => void;

  /**
   * `save` gets each finished part and its number (from 1), or 0 for the only one: an
   * archive that never needed a second part is saved as one.
   */
  constructor(newSink: () => Promise<ZipSink>, save: (blob: Blob, part: number) => void, limit = PART_SIZE) {
    this.newSink = newSink;
    this.save = save;
    this.limit = limit;
  }

  /** Why the current part takes no more files (a write failed: the disk is full). */
  get error(): Error | null {
    return this.current?.error ?? null;
  }

  /** Add a file to the current part, or to a new one if it would be too large. */
  add(name: string, data: Blob): Promise<void> {
    const added = this.lock.then(async () => {
      const bytes = new TextEncoder().encode(name).length;
      const zip = this.current;
      if (zip && zip.count && zip.size + data.size + 2 * (ENTRY_OVERHEAD + bytes) > this.limit) {
        await this.close(this.saved + 1);
      }
      this.current ??= new ZipWriter(await this.newSink());
      await this.current.add(name, data);
      this.count++;
    });
    this.lock = added.catch(() => {});
    return added;
  }

  /** Save the last part (named as a part if there were others). */
  async finish(): Promise<void> {
    await this.lock;
    if (this.current?.count) await this.close(this.saved ? this.saved + 1 : 0);
    else await this.discardCurrent();
  }

  /** Drop the part being written (on cancel). Saved parts are downloaded already. */
  async discard(): Promise<void> {
    await this.lock;
    await this.discardCurrent();
  }

  private async discardCurrent() {
    await this.current?.discard();
    this.current = null;
  }

  private async close(part: number) {
    const zip = this.current!;
    this.current = null;
    this.save(await zip.finish(), part);
    this.saved++;
    // The part before has been copied by now: writing a whole part takes much longer.
    await this.previous?.discard();
    this.previous = zip;
  }
}
