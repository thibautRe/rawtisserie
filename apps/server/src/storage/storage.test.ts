/**
 * Both object stores behave the same. The S3 one runs against a real server when
 * `TEST_S3_ENDPOINT` is set (with `TEST_S3_BUCKET`, `TEST_S3_ACCESS_KEY_ID` and
 * `TEST_S3_SECRET_ACCESS_KEY`; path-style), e.g. `rclone serve s3` or MinIO; CI does.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { after, describe, test } from 'node:test';
import type { ObjectStore } from './index.ts';
import { LocalStore } from './local.ts';
import { S3Store } from './s3.ts';

const dir = await mkdtemp(path.join(tmpdir(), 'rawtisserie-storage-'));
after(() => rm(dir, { recursive: true, force: true }));

const stores: [string, () => ObjectStore][] = [['local', () => new LocalStore(path.join(dir, 'store'))]];
const { TEST_S3_ENDPOINT, TEST_S3_BUCKET, TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY } = process.env;
if (TEST_S3_ENDPOINT) {
  stores.push([
    's3',
    () =>
      new S3Store({
        endpoint: TEST_S3_ENDPOINT,
        bucket: TEST_S3_BUCKET ?? 'test',
        region: 'us-east-1',
        accessKeyId: TEST_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: TEST_S3_SECRET_ACCESS_KEY ?? '',
        pathStyle: true,
      }),
  ]);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

for (const [name, create] of stores) {
  describe(`${name} object store`, () => {
    const store = create();
    // Each run under its own prefix, so a shared bucket doesn't carry state between runs.
    const prefix = `test-${randomUUID()}`;

    test('put, read, get and delete', async () => {
      const key = `${prefix}/renders/ab/abc-thumb.jpg`;
      const bytes = Buffer.from('jpeg bytes');
      await store.put(key, bytes);
      assert.deepEqual(await store.read(key), bytes);
      assert.deepEqual(await collect((await store.get(key))!), bytes);
      await store.put(key, Buffer.from('replaced'));
      assert.equal((await store.read(key))!.toString(), 'replaced');
      await store.delete(key);
      assert.equal(await store.read(key), null);
      assert.equal(await store.get(key), null);
    });

    test('a missing object is null, and deleting it does nothing', async () => {
      assert.equal(await store.read(`${prefix}/nothing`), null);
      assert.equal(await store.get(`${prefix}/nothing`), null);
      await store.delete(`${prefix}/nothing`);
    });

    test('putFile moves a file into the store', async () => {
      const file = path.join(dir, randomUUID());
      const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
      await writeFile(file, bytes);
      const key = `${prefix}/originals/user/photo.arw`;
      await store.putFile(key, file);
      assert.equal(existsSync(file), false);
      assert.deepEqual(await store.read(key), bytes);
      await store.delete(key);
    });
  });
}

test('local keys stay inside the directory', async () => {
  const store = new LocalStore(path.join(dir, 'store'));
  await assert.rejects(store.read('../outside'), /invalid storage key/);
});
