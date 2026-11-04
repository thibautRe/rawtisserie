import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SensorMapping } from '@rawtisserie/pipeline';
import { defaultSource, displayScale, hexToRec2020, rec2020ToHex } from './retouch.ts';

test('fill colours round-trip through sRGB', () => {
  for (const hex of ['#000000', '#ffffff', '#c04020', '#2e8b57']) assert.equal(rec2020ToHex(hexToRec2020(hex)), hex);
  // Middle grey stays grey.
  const [r, g, b] = hexToRec2020('#777777');
  assert.ok(Math.abs(r - g) < 1e-3 && Math.abs(g - b) < 1e-3);
});

test('new spots copy from beside them, inside the frame', () => {
  assert.deepEqual(defaultSource([0.5, 0.5], [0.02, 0.03]), [0.05, 0]);
  assert.deepEqual(defaultSource([0.95, 0.5], [0.02, 0.03]), [-0.05, 0]);
});

test('displayScale measures the sensor in screen pixels', () => {
  // A 6000 × 4000 sensor shown whole at 600 × 400: the short side is 400 px.
  const m: SensorMapping = { width: 6000, height: 4000, affine: [0, 0, 6000, 0, 0, 4000], lens: null };
  assert.ok(Math.abs(displayScale(m, [0.5, 0.5], 600, 400) - 400) < 1e-3);
});
