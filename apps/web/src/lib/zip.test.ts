import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZipWriter, crc32, memorySink } from './zip.ts';

const text = (s: string) => new TextEncoder().encode(s);

test('crc32 matches the standard check value, in one piece or several', () => {
  assert.equal(crc32(text('123456789')), 0xcbf43926);
  assert.equal(crc32(text('6789'), crc32(text('12345'))), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

/** The files of an archive, read from its central directory (ZIP64 aware). */
async function read(zip: Blob): Promise<{ name: string; data: string; crc: number }[]> {
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  let count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (at === 0xffffffff) {
    const locator = end - 20;
    assert.equal(view.getUint32(locator, true), 0x07064b50);
    const end64 = Number(view.getBigUint64(locator + 8, true));
    assert.equal(view.getUint32(end64, true), 0x06064b50);
    count = Number(view.getBigUint64(end64 + 32, true));
    at = Number(view.getBigUint64(end64 + 48, true));
  }
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    let offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    let x = at + 46 + nameLength + 4;
    if (size === 0xffffffff) {
      size = Number(view.getBigUint64(x, true));
      x += 16;
    }
    if (offset === 0xffffffff) offset = Number(view.getBigUint64(x, true));
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc);
    files.push({ name, data: new TextDecoder().decode(data), crc });
    at += 46 + nameLength + extraLength;
  }
  return files;
}

test('an archive lists its files with their data', async () => {
  const zip = new ZipWriter();
  await zip.add('a.jpg', new Blob(['first']));
  await zip.add('été/b.png', new Blob(['second file']));
  await zip.add('empty.tif', new Blob([]));
  assert.ok(zip.has('a.jpg'));
  await assert.rejects(zip.add('a.jpg', new Blob(['again'])));
  const files = await read(await zip.finish());
  assert.deepEqual(
    files.map((f) => [f.name, f.data]),
    [
      ['a.jpg', 'first'],
      ['été/b.png', 'second file'],
      ['empty.tif', ''],
    ],
  );
});

test('sizes and offsets past the limit get ZIP64 records', async () => {
  // A limit of 8 bytes: the second file starts past it, the third is larger.
  const zip = new ZipWriter(memorySink(), 8);
  await zip.add('one', new Blob(['1']));
  await zip.add('two', new Blob(['2']));
  await zip.add('three', new Blob(['three is long']));
  const files = await read(await zip.finish());
  assert.deepEqual(
    files.map((f) => [f.name, f.data]),
    [
      ['one', '1'],
      ['two', '2'],
      ['three', 'three is long'],
    ],
  );
});

test('an empty archive is just its end record', async () => {
  const zip = await new ZipWriter().finish();
  assert.equal(zip.size, 22);
  assert.deepEqual(await read(zip), []);
});

test('files added at once are written in turn, each whole', async () => {
  const zip = new ZipWriter();
  // The larger one's CRC takes longer: the smaller one is written first.
  await Promise.all([zip.add('big', new Blob(['x'.repeat(1 << 20)])), zip.add('small', new Blob(['y']))]);
  const files = await read(await zip.finish());
  assert.deepEqual(files.map((f) => [f.name, f.data.length]).sort(), [
    ['big', 1 << 20],
    ['small', 1],
  ]);
});

test('after a failed write, the archive lists what was written before and takes nothing more', async () => {
  const parts: ArrayBuffer[] = [];
  let fail = false;
  const zip = new ZipWriter({
    // Like a full disk: the header goes in, then the data fails.
    write: async (part) => {
      const bytes = part instanceof Blob ? await part.arrayBuffer() : part;
      if (fail && part instanceof Blob) throw new Error('disk full');
      parts.push(bytes);
    },
    truncate: async (to) => {
      let total = parts.reduce((n, p) => n + p.byteLength, 0);
      while (total > to) total -= parts.pop()!.byteLength;
    },
    close: async () => new Blob(parts),
    discard: async () => {},
  });
  await zip.add('one', new Blob(['1']));
  fail = true;
  await assert.rejects(zip.add('two', new Blob(['2'])), /could not be written \(disk full\)/);
  fail = false;
  await assert.rejects(zip.add('three', new Blob(['3'])), /could not be written/);
  assert.ok(!zip.has('two'));
  assert.deepEqual(
    (await read(await zip.finish())).map((f) => f.name),
    ['one'],
  );
});
