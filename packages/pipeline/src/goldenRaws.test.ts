/**
 * Every golden RAW (`crates/pipeline/tests/golden/raws`) decodes and renders through
 * the WebAssembly build, not only natively: a decoder can work in Rust's tests and
 * still fail in wasm (rawler's CR3 decoder once called `Instant::now`, which panics
 * there). Skipped until `./scripts/fetch-golden-raws.sh` has run; CI runs it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Developer, initPipeline } from './node.ts';

const dir = new URL('../../../crates/pipeline/tests/golden/', import.meta.url);
const names = readFileSync(new URL('raws.txt', dir), 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => line.split(/\s+/)[1]!);
const fetched = names.every((name) => existsSync(new URL(`raws/${name}`, dir)));

for (const name of names) {
  test(`decodes and renders ${name} in wasm`, { skip: !fetched && 'golden RAWs not fetched' }, () => {
    initPipeline();
    const dev = new Developer(readFileSync(new URL(`raws/${name}`, dir)));
    try {
      const meta = JSON.parse(dev.metadata());
      assert.ok(meta.width > 0 && meta.height > 0);
      const jpeg = dev.renderJpeg('{}', 256, 256, 80);
      assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
    } finally {
      dev.free();
    }
  });
}
