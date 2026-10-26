import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultEditParams, normalizeEditParams } from './params.ts';
import { initPipeline, defaultParams } from './node.ts';

test('TypeScript defaults match the Rust defaults', () => {
  initPipeline();
  assert.deepEqual(JSON.parse(defaultParams()), defaultEditParams);
});

test('normalizeEditParams fills gaps and ignores junk', () => {
  const p = normalizeEditParams({ exposure: { ev: 2 }, color: 'nope', geometry: { crop: { x: 0.5 } } });
  assert.equal(p.exposure.ev, 2);
  assert.equal(p.exposure.black, 0);
  assert.deepEqual(p.color, defaultEditParams.color);
  assert.deepEqual(p.geometry.crop, { x: 0.5, y: 0, width: 1, height: 1 });
});

test('develops a RAW file when RAWTISSERIE_SAMPLE is set', { skip: !process.env.RAWTISSERIE_SAMPLE }, async () => {
  const { Developer } = await import('./node.ts');
  initPipeline();
  const dev = new Developer(readFileSync(process.env.RAWTISSERIE_SAMPLE!));
  const meta = JSON.parse(dev.metadata());
  assert.ok(meta.width > 0);
  const jpeg = dev.renderJpeg('{}', 256, 256, 80);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  dev.free();
});
