import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveAt } from './curve.ts';

test('curveAt passes through the nodes and stays in [0, 1]', () => {
  const nodes = [0.1, 0.5, 0.9, 0.3, 0.5, 0.7];
  nodes.forEach((y, k) => assert.ok(Math.abs(curveAt(nodes, k / 5) - y) < 1e-12));
  assert.equal(curveAt([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 0.37), 0.5);
  for (let x = 0; x <= 1; x += 0.01) {
    const y = curveAt([0, 1, 0, 1, 0, 1], x);
    assert.ok(y >= 0 && y <= 1, `${x}: ${y}`);
  }
});
