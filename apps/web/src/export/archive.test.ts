import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ZipSink, memorySink } from '../lib/zip.ts';
import { PartedArchive } from './archive.ts';

/** The names in a ZIP, from its central directory. */
async function names(zip: Blob): Promise<string[]> {
  const view = new DataView(await zip.arrayBuffer());
  const end = view.byteLength - 22;
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const n = view.getUint16(at + 28, true);
    out.push(new TextDecoder().decode(new Uint8Array(view.buffer, at + 46, n)));
    at += 46 + n + view.getUint16(at + 30, true);
  }
  return out;
}

/** Sinks in memory that record when they're discarded. */
function sinks() {
  const discarded: number[] = [];
  let made = 0;
  const make = async (): Promise<ZipSink> => {
    const sink = memorySink();
    const id = ++made;
    return { ...sink, discard: async () => void discarded.push(id) };
  };
  return { make, discarded };
}

test('an archive that stays small is saved as one, unnumbered', async () => {
  const saved: [string[], number][] = [];
  const { make } = sinks();
  const archive = new PartedArchive(make, async (blob, part) => void saved.push([await names(blob), part]), 1000);
  await archive.add('a.jpg', new Blob(['a'.repeat(100)]));
  await archive.add('b.jpg', new Blob(['b'.repeat(100)]));
  await archive.finish();
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(saved, [[['a.jpg', 'b.jpg'], 0]]);
  assert.equal(archive.count, 2);
});

test('parts are saved as they fill up, and each deletes the one before', async () => {
  const saved: { names: Promise<string[]>; part: number }[] = [];
  const { make, discarded } = sinks();
  const archive = new PartedArchive(make, (blob, part) => saved.push({ names: names(blob), part }), 1200);
  // Files of 400 bytes: two fit in a part with their headers, the third starts a new one.
  await Promise.all(['1', '2', '3', '4', '5'].map((n) => archive.add(`${n}.jpg`, new Blob([n.repeat(400)]))));
  assert.deepEqual(
    saved.map((s) => s.part),
    [1, 2],
  );
  assert.deepEqual(discarded, [1]);
  await archive.finish();
  assert.deepEqual(await Promise.all(saved.map(async (s) => [await s.names, s.part])), [
    [['1.jpg', '2.jpg'], 1],
    [['3.jpg', '4.jpg'], 2],
    [['5.jpg'], 3],
  ]);
  assert.deepEqual(discarded, [1, 2]);
  assert.equal(archive.count, 5);
});

test('a file larger than a part gets a part of its own', async () => {
  const parts: number[] = [];
  const { make } = sinks();
  const archive = new PartedArchive(make, (_, part) => void parts.push(part), 1000);
  await archive.add('small', new Blob(['s']));
  await archive.add('huge', new Blob(['h'.repeat(5000)]));
  await archive.add('after', new Blob(['a']));
  await archive.finish();
  assert.deepEqual(parts, [1, 2, 3]);
});

test('discarding drops the part being written, and nothing is saved', async () => {
  const parts: number[] = [];
  const { make, discarded } = sinks();
  const archive = new PartedArchive(make, (_, part) => void parts.push(part), 1000);
  await archive.add('a', new Blob(['a']));
  await archive.discard();
  assert.deepEqual(parts, []);
  assert.deepEqual(discarded, [1]);
});
