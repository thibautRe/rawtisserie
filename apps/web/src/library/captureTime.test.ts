import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { exifDate, localTime, readCaptureTime, readExifTime } from './captureTime.ts';

/** A little-endian TIFF: IFD0 with DateTime and an EXIF IFD with DateTimeOriginal. */
function tiff(original: string, modified: string): Uint8Array {
  const b = new Uint8Array(200);
  const v = new DataView(b.buffer);
  b.set([0x49, 0x49, 42, 0], 0);
  v.setUint32(4, 8, true);
  // IFD0 at 8: two entries.
  v.setUint16(8, 2, true);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    v.setUint16(at, tag, true);
    v.setUint16(at + 2, type, true);
    v.setUint32(at + 4, count, true);
    v.setUint32(at + 8, value, true);
  };
  entry(10, 0x0132, 2, 20, 100);
  entry(22, 0x8769, 4, 1, 60);
  // EXIF IFD at 60: one entry.
  v.setUint16(60, 1, true);
  entry(62, 0x9003, 2, 20, 140);
  b.set(new TextEncoder().encode(`${modified}\0`), 100);
  b.set(new TextEncoder().encode(`${original}\0`), 140);
  return b;
}

test('EXIF dates as the camera wrote them: local, no zone', () => {
  assert.equal(exifDate('2026:11:09 18:42:07'), '2026-11-09T18:42:07');
  assert.equal(exifDate('0000:00:00 00:00:00'), null);
  assert.equal(localTime(new Date(2026, 10, 9, 8, 5, 3).getTime()), '2026-11-09T08:05:03');
});

test('DateTimeOriginal from a TIFF structure, or from a JPEG’s EXIF', async () => {
  const t = tiff('2026:11:09 23:59:58', '2026:11:12 10:00:00');
  assert.equal(await readExifTime(new Blob([t as BlobPart])), '2026-11-09T23:59:58');
  const app1 = new Uint8Array([0xff, 0xe1, 0, 0, ...new TextEncoder().encode('Exif'), 0, 0, ...t]);
  new DataView(app1.buffer).setUint16(2, app1.length - 2);
  const jpeg = new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xda, 0, 2]);
  assert.equal(await readExifTime(new Blob([jpeg as BlobPart])), '2026-11-09T23:59:58');
  // No EXIF: the file's date.
  const plain = new File([new Uint8Array(10)], 'x.png', { lastModified: new Date(2026, 0, 2, 3, 4, 5).getTime() });
  assert.equal(await readCaptureTime(plain), '2026-01-02T03:04:05');
});

const RAWS = new URL('../../../../crates/pipeline/tests/golden/raws/', import.meta.url);
test('every golden RAW has its capture time read from its first bytes', { skip: !existsSync(RAWS) }, async () => {
  const files = readdirSync(RAWS).filter((f) => !f.startsWith('.'));
  assert.ok(files.length >= 6);
  for (const name of files) {
    const time = await readExifTime(new Blob([readFileSync(new URL(name, RAWS))]));
    assert.match(time ?? '', /^(19|20)\d\d-\d\d-\d\dT\d\d:\d\d:\d\d$/, name);
    console.log(name, time);
  }
});
