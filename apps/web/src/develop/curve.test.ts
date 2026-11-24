import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveAt, fineScale } from './curve.ts';

test('curveAt passes through the nodes and stays in [0, 1]', () => {
  const nodes = [0.1, 0.5, 0.9, 0.3, 0.5, 0.7];
  nodes.forEach((y, k) => assert.ok(Math.abs(curveAt(nodes, k / 5) - y) < 1e-12));
  assert.equal(curveAt([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 0.37), 0.5);
  for (let x = 0; x <= 1; x += 0.01) {
    const y = curveAt([0, 1, 0, 1, 0, 1], x);
    assert.ok(y >= 0 && y <= 1, `${x}: ${y}`);
  }
});

test('a fine scale spreads the values near neutral, and keeps the ends and neutral in place', () => {
  for (const neutral of [0, 0.5]) {
    const scale = fineScale(neutral);
    for (const v of [0, neutral, 1]) assert.ok(Math.abs(scale.toShown(v) - v) < 1e-12, `${neutral}: ${v}`);
    for (const v of [0, 0.1, 0.3, 0.52, 0.8, 1]) assert.ok(Math.abs(scale.toValue(scale.toShown(v)) - v) < 1e-12);
  }
  const half = fineScale(0.5);
  // A small change near neutral takes more than twice the room.
  assert.ok(half.toShown(0.51) - 0.5 > 0.024);
  assert.ok(0.5 - half.toShown(0.49) > 0.024);
});
