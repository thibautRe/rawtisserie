import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergePages } from './pages.ts';

const v = (...ids: string[]) => ids.map((id) => ({ id }));

test('pages fill their slots, the latest total wins', () => {
  const { items, total, stale } = mergePages(
    [
      { page: 0, versions: v('a', 'b'), total: 5, updatedAt: 1 },
      { page: 2, versions: v('e'), total: 5, updatedAt: 2 },
    ],
    2,
  );
  assert.equal(total, 5);
  assert.deepEqual(
    items.map((i) => i?.id),
    ['a', 'b', undefined, undefined, 'e'],
  );
  assert.deepEqual(stale, []);
});

test('a version on two pages keeps the newer one, and the older page is fetched again', () => {
  // `n` was added at the top after page 1 was fetched: page 0 (newer) pushed `b` onto page 1.
  const { items, total, stale } = mergePages(
    [
      { page: 0, versions: v('n', 'a'), total: 4, updatedAt: 2 },
      { page: 1, versions: v('a', 'b'), total: 3, updatedAt: 1 },
    ],
    2,
  );
  assert.equal(total, 4);
  assert.deepEqual(
    items.map((i) => i?.id),
    ['n', 'a', undefined, 'b'],
  );
  assert.deepEqual(stale, [1]);
});

test('a version that moved is listed once', () => {
  // `x` moved from the end (no date yet) to the top; the last page still has it.
  const { items, stale } = mergePages(
    [
      { page: 1, versions: v('b', 'x'), total: 4, updatedAt: 1 },
      { page: 0, versions: v('x', 'a'), total: 4, updatedAt: 2 },
    ],
    2,
  );
  assert.deepEqual(
    items.map((i) => i?.id),
    ['x', 'a', 'b', undefined],
  );
  assert.deepEqual(stale, [1]);
});
