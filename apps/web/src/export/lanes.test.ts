import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportLanes, originalGroups } from './lanes.ts';

test('versions of one file are grouped when they follow each other', () => {
  assert.deepEqual(originalGroups(['a', 'a', 'b', 'a', 'c', 'c']), [[0, 1], [2], [3], [4, 5]]);
  assert.deepEqual(originalGroups([]), []);
});

test('a lane per four threads, from one to three', () => {
  assert.equal(exportLanes(2), 1);
  assert.equal(exportLanes(8), 2);
  assert.equal(exportLanes(16), 3);
  assert.equal(exportLanes(64), 3);
});
