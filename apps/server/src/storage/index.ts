/**
 * Where originals, renders and uploaded LUTs are kept: a store of objects by key, on
 * local disk (`STORAGE_DIR`) or in an S3-compatible bucket (`S3_BUCKET`). Keys are
 * paths (`originals/…`, `renders/…`, `luts/…`), the same in both, so moving from one
 * to the other is a plain copy (`rclone copy data/ remote:bucket`).
 *
 * Usable from worker threads too: each thread gets its own instance.
 */
import type { Readable } from 'node:stream';
import { config } from '../config.ts';
import { LocalStore } from './local.ts';
import { S3Store } from './s3.ts';

export interface ObjectStore {
  /** Store a local file under `key`. The file is moved: it's gone afterwards. */
  putFile(key: string, file: string): Promise<void>;
  /** Store bytes under `key`, replacing what was there. */
  put(key: string, body: Uint8Array): Promise<void>;
  /** The object's bytes as a stream, or null when there's none. */
  get(key: string): Promise<Readable | null>;
  /** The whole object, or null when there's none. */
  read(key: string): Promise<Buffer | null>;
  /** Remove the object; nothing happens when there's none. */
  delete(key: string): Promise<void>;
}

export const storage: ObjectStore = config.s3 ? new S3Store(config.s3) : new LocalStore(config.storageDir);
