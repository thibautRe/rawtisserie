/** Objects as files under a directory, by key. */
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ObjectStore } from './index.ts';

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

export class LocalStore implements ObjectStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(key: string): string {
    const file = path.join(this.dir, key);
    if (!file.startsWith(this.dir + path.sep)) throw new Error(`invalid storage key ${key}`);
    return file;
  }

  async putFile(key: string, file: string): Promise<void> {
    const dest = this.path(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(file, dest);
  }

  /** Written next to its place, then renamed: readers never see a partial file. */
  async put(key: string, body: Uint8Array): Promise<void> {
    const dest = this.path(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const temp = `${dest}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, body);
      await rename(temp, dest);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Readable | null> {
    try {
      const handle = await open(this.path(key));
      return handle.createReadStream();
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
