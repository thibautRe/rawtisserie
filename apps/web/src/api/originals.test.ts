import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evictions } from './originals.ts';

const MB = 1024 ** 2;

test('keeps everything within the budget', () => {
  assert.deepEqual(evictions([{ url: 'a', size: 40 * MB, usedAt: 1 }], 100 * MB), []);
});

test('drops the least recently used first, until the rest fits', () => {
  const entries = [
    { url: 'new', size: 40 * MB, usedAt: 30 },
    { url: 'old', size: 40 * MB, usedAt: 10 },
    { url: 'mid', size: 40 * MB, usedAt: 20 },
  ];
  assert.deepEqual(evictions(entries, 90 * MB), ['old']);
  assert.deepEqual(evictions(entries, 50 * MB), ['old', 'mid']);
});

test('those never recorded as used go before any that were, oldest stored first', () => {
  const entries = [
    { url: 'used', size: 40 * MB, usedAt: 5 },
    { url: 'unknown1', size: 40 * MB, usedAt: 0 },
    { url: 'unknown2', size: 40 * MB, usedAt: 0 },
  ];
  assert.deepEqual(evictions(entries, 50 * MB), ['unknown1', 'unknown2']);
});
