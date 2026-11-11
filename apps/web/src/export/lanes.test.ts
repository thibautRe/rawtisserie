import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportLanes, originalGroups } from './lanes.ts';

test('versions of one file are grouped when they follow each other', () => {
  assert.deepEqual(originalGroups(['a', 'a', 'b', 'a', 'c', 'c']), [[0, 1], [2], [3], [4, 5]]);
  assert.deepEqual(originalGroups([]), []);
});

test('a lane per four threads, from one to three, fewer for large photos', () => {
  const mp24 = 6000 * 4000;
  assert.equal(exportLanes(2, mp24), 1);
  assert.equal(exportLanes(8, mp24), 2);
  assert.equal(exportLanes(16, mp24), 3);
  assert.equal(exportLanes(64, mp24), 3);
  assert.equal(exportLanes(16, 8256 * 5504), 2); // 45 MP
  assert.equal(exportLanes(16, 9504 * 6336), 1); // 61 MP
  assert.equal(exportLanes(16, null), 2);
  assert.equal(exportLanes(2, 9504 * 6336), 1);
});
