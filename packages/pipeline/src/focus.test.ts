import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { type FocusMap, focusCells, focusView, NO_EDGE } from './focus.ts';
import type { SensorMapping } from './shapes.ts';

/** A 4 × 2 map: sharp edges on the right, a blurred one top left, none bottom left. */
const raw = Uint8Array.from([30, NO_EDGE, 0, 5, NO_EDGE, NO_EDGE, 2, 2]);
const map: FocusMap = { version: 2, cols: 4, rows: 2, cells: deflateSync(raw).toString('base64') };

const identity: SensorMapping = {
  width: 400,
  height: 200,
  affine: [0, 0, 400, 0, 0, 200],
  perspective: [0, 0],
  lens: null,
};

test('cells are inflated', async () => {
  assert.deepEqual(await focusCells(map), raw);
});

test('a map of the wrong size is refused', async () => {
  await assert.rejects(focusCells({ ...map, cols: 3 }));
});

test('a view of the whole sensor keeps the cells where they are', () => {
  const view = focusView(map, raw, identity, 400, 200);
  assert.equal(view.width, 4);
  assert.equal(view.height, 2);
  assert.deepEqual(view.cells, raw);
});

test('a view is as fine as the map, over what the frame shows', () => {
  // Output x 0…1 → sensor x 0…200: the left half, at the map's density.
  const crop: SensorMapping = { ...identity, affine: [0, 0, 200, 0, 0, 200] };
  const view = focusView(map, raw, crop, 200, 200);
  assert.equal(view.width, 2);
  assert.equal(view.height, 2);
  assert.deepEqual([...view.cells], [30, NO_EDGE, NO_EDGE, NO_EDGE]);
});

test('a quarter turn turns the cells', () => {
  // Rotated clockwise: output (x, y) shows sensor (y, 1 − x).
  const turned: SensorMapping = { ...identity, affine: [0, 200, 0, -200, 400, 0] };
  const view = focusView(map, raw, turned, 200, 400);
  assert.equal(view.width, 2);
  assert.equal(view.height, 4);
  // Output row 0 is sensor column 0, from the bottom row up.
  assert.deepEqual([...view.cells.slice(0, 2)], [NO_EDGE, 30]);
  assert.deepEqual([...view.cells.slice(6, 8)], [2, 5]);
});

test('cells outside the sensor have no edge', () => {
  const beyond: SensorMapping = { ...identity, affine: [-400, 0, 800, 0, 0, 200] };
  const view = focusView(map, raw, beyond, 800, 200);
  assert.deepEqual([...view.cells.slice(0, 4)], [NO_EDGE, NO_EDGE, NO_EDGE, NO_EDGE]);
});
