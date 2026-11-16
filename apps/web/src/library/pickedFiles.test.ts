import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Entry, type PickedFile, sortPicked, walk, withPairs } from './pickedFiles.ts';

const file = (name: string): Entry => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (ok) => ok(new File(['x'], name)),
});
/** A folder whose reader gives its entries `batch` at a time, as Chrome does (100). */
const folder = (name: string, children: Entry[], batch = 100): Entry => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let at = 0;
    return {
      readEntries: (ok) => {
        ok(children.slice(at, at + batch));
        at += batch;
      },
    };
  },
});

test('folders are walked through, in batches, hidden ones left out', async () => {
  const many = Array.from({ length: 250 }, (_, i) => file(`DSC${String(i).padStart(5, '0')}.ARW`));
  const picked = await walk([
    folder('DCIM', [folder('100MSDCF', many, 100), folder('.Trashes', [file('old.ARW')])]),
    file('loose.NEF'),
  ]);
  assert.equal(picked.length, 251);
  assert.equal(picked[0]!.path, 'DCIM/100MSDCF/DSC00000.ARW');
  assert.equal(picked.at(-1)!.path, 'loose.NEF');
});

const p = (path: string): PickedFile => ({ path, file: new File([], path.split('/').at(-1)!) });

test('what was picked is sorted out', () => {
  const card = sortPicked([
    p('DCIM/100MSDCF/DSC10.ARW'),
    p('DCIM/100MSDCF/DSC9.ARW'),
    p('DCIM/100MSDCF/DSC9.JPG'),
    p('DCIM/100MSDCF/._DSC9.ARW'),
    p('DCIM/100MSDCF/C0001.MP4'),
  ]);
  // Numbers in order, other files left out quietly, named after the folder.
  assert.deepEqual(
    card.files.map((f) => f.path),
    ['DCIM/100MSDCF/DSC9.ARW', 'DCIM/100MSDCF/DSC10.ARW'],
  );
  // The JPEG next to its RAW is set apart, to import only if asked for.
  assert.deepEqual(
    card.pairs.map((f) => f.path),
    ['DCIM/100MSDCF/DSC9.JPG'],
  );
  assert.deepEqual(
    withPairs(card, true).files.map((f) => f.path),
    ['DCIM/100MSDCF/DSC9.ARW', 'DCIM/100MSDCF/DSC9.JPG', 'DCIM/100MSDCF/DSC10.ARW'],
  );
  assert.equal(withPairs(card, false), card);
  assert.equal(card.ignored, 2);
  assert.equal(card.label, 'DCIM');

  // Files picked one by one that aren't RAW files or images are refused (the user chose them).
  const loose = sortPicked([p('a.CR3'), p('notes.txt')]);
  assert.deepEqual([loose.files.length, loose.refused.length, loose.ignored, loose.label], [1, 1, 0, null]);

  // Images on their own, or next to a RAW with another name or in another folder, are photos.
  const library = sortPicked([
    p('Photos/2019/IMG_1.jpeg'),
    p('Photos/2019/scan.tif'),
    p('Photos/2020/IMG_1.CR2'),
    p('Photos/2020/IMG_2.HEIC'),
  ]);
  assert.deepEqual(
    library.files.map((f) => f.path),
    ['Photos/2019/IMG_1.jpeg', 'Photos/2019/scan.tif', 'Photos/2020/IMG_1.CR2'],
  );
  assert.deepEqual([library.pairs.length, library.ignored], [0, 1]);
});
