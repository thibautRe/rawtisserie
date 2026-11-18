import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryDelay } from './queue.ts';

test('a failed render is tried again after 1 min, 10 min, 1 h, then not until the next build', () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(retryDelay), [60_000, 600_000, 3_600_000, null, null]);
});
