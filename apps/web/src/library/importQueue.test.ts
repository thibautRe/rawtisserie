import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchFiles } from './importQueue.ts';
import { sampleRun } from './imports.ts';
import { type Handle, walkHandles } from './pickedFiles.ts';

const file = (name: string, size: number, modified: number) =>
  new File([new Uint8Array(size)], name, { lastModified: modified });

test('an interrupted run finds its files again by name, size and date', () => {
  const run = sampleRun(
    [
      { status: 'imported', name: 'a.ARW', size: 3, modified: 1 },
      { status: 'uploading', name: 'b.ARW', size: 3, modified: 2 },
      { name: 'c.ARW', size: 3, modified: 3 },
      { name: 'd.ARW', size: 3, modified: 4 },
    ],
    false,
  );
  const found = matchFiles(
    run,
    [file('a.ARW', 3, 1), file('b.ARW', 3, 2), file('c.ARW', 3, 99), file('d.ARW', 4, 4)].map((f) => ({
      file: f,
      path: `DCIM/${f.name}`,
    })),
  );
  // Done ones aren't looked for; another date or size isn't the same file.
  assert.deepEqual([...found.keys()], ['k1']);
});

const fileHandle = (name: string): Handle => ({ kind: 'file', name, getFile: async () => file(name, 1, 0) });
const dirHandle = (name: string, children: Handle[]): Handle => ({
  kind: 'directory',
  name,
  entries: async function* () {
    for (const c of children) yield [c.name, c] as [string, Handle];
  },
});

test('handles are walked through like a drop, hidden folders left out', async () => {
  const picked = await walkHandles([
    dirHandle('DCIM', [dirHandle('100MSDCF', [fileHandle('DSC1.ARW')]), dirHandle('.Trashes', [fileHandle('x.ARW')])]),
  ]);
  assert.deepEqual(
    picked.map((p) => p.path),
    ['DCIM/100MSDCF/DSC1.ARW'],
  );
});
