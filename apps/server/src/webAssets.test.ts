import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { KEEP_DAYS, keepAssets } from './webAssets.ts';

const DAY = 24 * 3600_000;

async function build(dir: string, files: Record<string, string>) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
}

test("a build's files stay after the next deploys, until KEEP_DAYS after they were last current", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'assets-'));
  const [b, kept] = [path.join(root, 'build'), path.join(root, 'kept')];
  const t0 = Date.UTC(2026, 10, 1);
  try {
    await build(b, { 'index-v1.js': 'one', 'shared.wasm': 'w' });
    assert.deepEqual(await keepAssets(b, kept, t0), { added: 2, removed: 0, total: 2 });

    // The next deploy: v1's chunk is kept for the pages still on it.
    await build(b, { 'index-v2.js': 'two', 'shared.wasm': 'w' });
    assert.deepEqual(await keepAssets(b, kept, t0 + DAY), { added: 1, removed: 0, total: 2 });
    assert.deepEqual((await readdir(kept)).sort(), ['index-v1.js', 'index-v2.js', 'shared.wasm']);
    assert.equal(await readFile(path.join(kept, 'index-v1.js'), 'utf8'), 'one');

    // Counted from when it was last current (t0), not from the last deploy.
    await keepAssets(b, kept, t0 + (KEEP_DAYS - 1) * DAY);
    assert.ok((await readdir(kept)).includes('index-v1.js'));
    const later = await keepAssets(b, kept, t0 + (KEEP_DAYS + 1) * DAY);
    assert.equal(later.removed, 1);
    // The current build's files stay however old they are.
    assert.deepEqual((await readdir(kept)).sort(), ['index-v2.js', 'shared.wasm']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a copy cut short is replaced, not served', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'assets-'));
  const [b, kept] = [path.join(root, 'build'), path.join(root, 'kept')];
  try {
    await build(b, { 'a.js': 'whole' });
    await build(kept, { 'a.js.partial': 'wh' });
    await keepAssets(b, kept);
    assert.deepEqual(await readdir(kept), ['a.js']);
    assert.equal(await readFile(path.join(kept, 'a.js'), 'utf8'), 'whole');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
