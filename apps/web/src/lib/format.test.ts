import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatDuration } from './format.ts';

test('durations read at a glance', () => {
  assert.equal(formatDuration(0), '0.0 s');
  assert.equal(formatDuration(870), '0.9 s');
  assert.equal(formatDuration(42_400), '42 s');
  assert.equal(formatDuration(200_000), '3 min 20 s');
  assert.equal(formatDuration(180_000), '3 min');
  assert.equal(formatDuration(7_500_000), '2 h 5 min');
  assert.equal(formatDuration(7_200_000), '2 h');
});

test('sizes are in units of 1024, up to TB', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(50 * 1024 ** 3), '50.0 GB');
  assert.equal(formatBytes(2.5 * 1024 ** 4), '2.5 TB');
});
