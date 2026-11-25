import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCells, encodeCells, type FocusMap, focusView, NO_DETAIL } from './focus.ts';
import type { SensorMapping } from './shapes.ts';

/** A 4 × 2 map: the right half sharp, the bottom-left without detail. */
const map: FocusMap = {
  version: 1,
  cols: 4,
  rows: 2,
  cells: encodeCells(Uint8Array.from([0, 0, 254, 254, NO_DETAIL, NO_DETAIL, 254, 254])),
  sharpness: 1,
  area: { x: 0.5, y: 0, width: 0.5, height: 1, cx: 0.75, cy: 0.5 },
};

const identity: SensorMapping = {
  width: 400,
  height: 200,
  affine: [0, 0, 400, 0, 0, 200],
  perspective: [0, 0],
  lens: null,
};

test('cells round-trip through base64', () => {
  const cells = Uint8Array.from([0, 1, 127, 254, 255]);
  assert.deepEqual(decodeCells(encodeCells(cells)), cells);
});

test('a view of the whole sensor keeps the cells where they are', () => {
  const view = focusView(map, identity, 400, 200);
  assert.equal(view.cols, 64);
  assert.equal(view.rows, 32);
  const cells = decodeCells(view.cells);
  assert.equal(cells[0], 0);
  assert.equal(cells[63], 254);
  assert.equal(cells[31 * 64], NO_DETAIL);
  assert.deepEqual(view.area, map.area);
});

test('a crop to the left half leaves the area out', () => {
  // Output x 0…1 → sensor x 0…200.
  const crop: SensorMapping = { ...identity, affine: [0, 0, 200, 0, 0, 200] };
  const view = focusView(map, crop, 200, 200);
  assert.equal(view.area, null);
  // Blurred on the left, blending into the sharp half (out of the frame) towards the right.
  const cells = decodeCells(view.cells);
  assert.ok(cells.every((c, i) => c === NO_DETAIL || i % 64 >= 32 || c === 0));
  assert.ok(cells[63]! > 0 && cells[63]! < 254);
});

test('a quarter turn moves the area', () => {
  // Rotated clockwise: output (x, y) shows sensor (y, 1 − x).
  const turned: SensorMapping = { ...identity, affine: [0, 200, 0, -200, 400, 0] };
  const view = focusView(map, turned, 200, 400);
  assert.equal(view.cols, 32);
  assert.equal(view.rows, 64);
  const area = view.area!;
  assert.ok(Math.abs(area.cy - 0.75) < 1e-6 && Math.abs(area.cx - 0.5) < 1e-6, JSON.stringify(area));
  assert.ok(Math.abs(area.y - 0.5) < 1e-6 && Math.abs(area.height - 0.5) < 1e-6);
});
