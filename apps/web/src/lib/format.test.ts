import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgo, formatBytes, formatDuration } from './format.ts';

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

test('how long ago, by minutes and hours, then by days, then the date', () => {
  const now = new Date(2026, 10, 14, 15, 30);
  const at = (...a: [number, number, number, number, number]) => new Date(...a).toISOString();
  assert.equal(formatAgo(at(2026, 10, 14, 15, 29), now), '1 minute ago');
  assert.equal(formatAgo(new Date(now.getTime() - 20_000).toISOString(), now), 'just now');
  assert.equal(formatAgo(at(2026, 10, 14, 15, 2), now), '28 minutes ago');
  assert.equal(formatAgo(at(2026, 10, 14, 9, 0), now), '6 hours ago');
  assert.equal(formatAgo(at(2026, 10, 13, 23, 0), now), 'yesterday');
  // Yesterday by the calendar, even under a day ago.
  assert.equal(formatAgo(at(2026, 10, 13, 18, 0), new Date(2026, 10, 14, 1, 0)), 'yesterday');
  assert.equal(formatAgo(at(2026, 10, 10, 12, 0), now), '4 days ago');
  assert.match(formatAgo(at(2026, 9, 2, 12, 0), now), /2/);
  assert.match(formatAgo(at(2025, 9, 2, 12, 0), now), /2025/);
});
