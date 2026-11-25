import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrushShape, GradientShape, RasterShape } from '@rawtisserie/pipeline';
import { shapeSettings, withShapeSettings } from './shapeSettings.ts';

const brush: BrushShape = {
  type: 'brush',
  points: [
    [0.1, 0.1, 0.01, 0.5],
    [0.2, 0.2, 0.03, 0.7],
  ],
  opacity: 1,
};

test("a stroke's size is its points' mean radius, and scales them all", () => {
  const s = shapeSettings(brush)!;
  assert.ok(Math.abs(s.size! - 0.02) < 1e-12 && Math.abs(s.hardness! - 0.6) < 1e-12 && s.opacity === 1);
  const next = withShapeSettings(brush, { size: 0.04 });
  for (const [r, want] of next.points.map((p, i) => [p[2], [0.02, 0.06][i]!])) assert.ok(Math.abs(r! - want!) < 1e-12);
  assert.deepEqual(
    withShapeSettings(brush, { hardness: 0.9 }).points.map((p) => p[3]),
    [0.9, 0.9],
  );
});

test('feather is set on the shapes that have one, opacity on all', () => {
  const gradient: GradientShape = { type: 'gradient', anchor: [0.5, 0.5], angle: 0, feather: 0.3, opacity: 1 };
  assert.equal(shapeSettings(gradient)?.featherMax, 1);
  assert.deepEqual(withShapeSettings(gradient, { feather: 0.2, opacity: 0.5 }), {
    ...gradient,
    feather: 0.2,
    opacity: 0.5,
  });
  const raster: RasterShape = { type: 'raster', source: 'a', invert: false, opacity: 1 };
  assert.deepEqual(shapeSettings(raster), { opacity: 1 });
  assert.deepEqual(withShapeSettings(raster, { feather: 0.2 }), raster);
  assert.equal(shapeSettings(undefined), null);
});
