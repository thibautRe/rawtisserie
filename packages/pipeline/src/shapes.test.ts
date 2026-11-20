import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type GeometricShape,
  type SensorMapping,
  flattenPath,
  freshShapeId,
  fromSensor,
  normalizeShape,
  shapeOutline,
  simplifyStroke,
  toSensor,
  translateShape,
} from './shapes.ts';

const close = (a: number[], b: number[], eps = 1e-6) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]!) < eps),
    `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`,
  );

test('normalizeShape fills optional fields and refuses junk', () => {
  assert.deepEqual(normalizeShape({ type: 'ellipse', center: [0.4, 0.3], radii: [0.05, 0.05] }), {
    type: 'ellipse',
    center: [0.4, 0.3],
    radii: [0.05, 0.05],
    rotation: 0,
    feather: 0,
    opacity: 1,
  });
  assert.equal(normalizeShape({ type: 'ellipse', center: [0.4], radii: [0.05, 0.05] }), null);
  assert.equal(normalizeShape({ type: 'blob' }), null);
  assert.equal(normalizeShape({ type: 'brush', points: [[0, 0, 0.1]] }), null);
  assert.deepEqual(normalizeShape({ type: 'brush', points: [] }), { type: 'brush', points: [], opacity: 1 });
  assert.deepEqual(normalizeShape({ type: 'raster', source: 'exposure' }), {
    type: 'raster',
    source: 'exposure',
    invert: false,
    opacity: 1,
  });
  assert.equal(normalizeShape({ type: 'raster' }), null);
  assert.equal(normalizeShape({ type: 'raster', source: 'exposure', invert: 1 }), null);
});

test('translateShape moves every point', () => {
  const path = normalizeShape({
    type: 'path',
    points: [
      [0.1, 0.1, 0.1, 0.1, 0.2, 0.1],
      [0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
      [0.1, 0.3, 0.1, 0.3, 0.1, 0.3],
    ],
  })!;
  const moved = translateShape(path as GeometricShape, 0.1, -0.05);
  close(moved.type === 'path' ? moved.points[0]! : [], [0.2, 0.05, 0.2, 0.05, 0.3, 0.05]);
});

test('ellipse outlines are round in pixels', () => {
  const circle = normalizeShape({ type: 'ellipse', center: [0.5, 0.5], radii: [0.1, 0.1], feather: 0.05 })!;
  const { edge, feather } = shapeOutline(circle as GeometricShape, { width: 200, height: 100 });
  // 10 px radius: 0.05 across the width, 0.1 across the height.
  const xs = edge[0]!.map((p) => p[0]);
  const ys = edge[0]!.map((p) => p[1]);
  close([Math.max(...xs), Math.max(...ys)], [0.55, 0.6], 1e-3);
  assert.equal(feather.length, 1);
});

test('paths go through their nodes', () => {
  const poly = flattenPath([
    [0, 0, 0, 0, 0, 0],
    [1, 0, 1, 0, 1, 0],
    [1, 1, 1, 1, 1, 1],
  ]);
  assert.equal(poly.length, 48);
  close(poly[16]!, [1, 0]);
  close(poly[8]!, [0.5, 0]);
});

test('simplifyStroke keeps corners and drops collinear points', () => {
  const line = Array.from({ length: 11 }, (_, i) => [i / 10, 0, 0.01, 0.5] as const);
  assert.equal(simplifyStroke([...line], 0.001).length, 2);
  const corner = [...line, [1, 0.5, 0.01, 0.5] as const];
  assert.deepEqual(
    simplifyStroke(corner, 0.001).map((p) => p[0]),
    [0, 1, 1],
  );
});

test('freshShapeId takes the first free id', () => {
  assert.equal(freshShapeId([]), 's1');
  assert.equal(freshShapeId(['s1', 's3']), 's2');
});

test('the sensor mapping round-trips, with lens distortion', () => {
  // A quarter turn with a crop, as Rust gives it for a 6000 × 4000 sensor.
  const affine: SensorMapping['affine'] = [600, 3600, 0, -2400, 4200, 0];
  const scale = Array.from({ length: 1025 }, (_, i) => 1 - 0.06 * (i / 1024));
  const lenses = [null, { cx: 3000, cy: 2000, toIndex: 1024 / (1.1 * 3605 ** 2), scale }];
  // With perspective too (a homography).
  const perspectives: SensorMapping['perspective'][] = [
    [0, 0],
    [0.12, -0.05],
  ];
  for (const [lens, perspective] of lenses.flatMap((l) => perspectives.map((p) => [l, p] as const))) {
    const m: SensorMapping = { width: 6000, height: 4000, affine, perspective, lens };
    for (const [x, y] of [
      [0.5, 0.5],
      [0, 0],
      [1, 0.2],
    ] as const) {
      const [u, v] = toSensor(m, x, y);
      close(fromSensor(m, u, v), [x, y], 1e-5);
    }
  }
  const identity: SensorMapping = {
    width: 10,
    height: 10,
    affine: [0, 0, 10, 0, 0, 10],
    perspective: [0, 0],
    lens: null,
  };
  close(toSensor(identity, 0.3, 0.6), [0.3, 0.6]);
});
