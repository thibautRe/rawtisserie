import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BUILTIN_LUTS, LUT_ID, freeLutName } from './luts.ts';
import { builtinLutUrl, initPipeline, parseLut } from './node.ts';

test('built-in LUT files decode to their ids', () => {
  initPipeline();
  const names = new Set<string>();
  for (const lut of BUILTIN_LUTS) {
    assert.match(lut.id, LUT_ID);
    assert.ok(!names.has(lut.name), `${lut.name} is listed twice`);
    names.add(lut.name);
    const parsed = parseLut(readFileSync(builtinLutUrl(lut.id)));
    try {
      assert.equal(parsed.id, lut.id, lut.name);
    } finally {
      parsed.free();
    }
  }
});

test('parseLut reads .cube files and rejects junk', () => {
  initPipeline();
  const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  const parsed = parseLut(new TextEncoder().encode(cube));
  assert.deepEqual([parsed.size, parsed.bitDepth], [2, 16]);
  const again = parseLut(parsed.takePacked());
  assert.equal(again.id, parsed.id);
  parsed.free();
  again.free();
  assert.throws(() => parseLut(new TextEncoder().encode('LUT_3D_SIZE 2\n0 0 0\n')), /LUT_3D_SIZE 2 needs 8/);
});

test('freeLutName numbers names that are taken, ignoring case', () => {
  assert.equal(freeLutName('Kodak', []), 'Kodak');
  assert.equal(freeLutName('Kodak', ['kodak']), 'Kodak (2)');
  assert.equal(freeLutName('Kodak', ['Kodak', 'Kodak (2)']), 'Kodak (3)');
});
