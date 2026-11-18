import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Collection,
  collectionIndex,
  collectionPath,
  collectionTree,
  filterCollectionTree,
  isWithin,
  normalizeCollectionName,
} from './collections.ts';

const c = (id: string, parentId: string | null, name: string, photos: number, latest: string): Collection => ({
  id,
  parentId,
  name,
  createdAt: '2026-01-01T00:00:00Z',
  photos,
  latest,
});
const LIST = [
  c('y', null, '2026', 0, '2026-01-01'),
  c('a', 'y', '2026-11-09', 4, '2026-11-09'),
  c('b', 'y', '2026-11-10', 2, '2026-11-10'),
  c('j', null, 'Japan', 3, '2025-04-10'),
  c('k', 'j', 'Kyoto', 1, '2025-04-12'),
];

test('a tree, newest first at each level, with totals of what is under', () => {
  const tree = collectionTree(LIST);
  assert.deepEqual(
    tree.map((n) => [n.name, n.total]),
    [
      ['2026', 6],
      ['Japan', 4],
    ],
  );
  assert.deepEqual(
    tree[0]!.children.map((n) => n.name),
    ['2026-11-10', '2026-11-09'],
  );
  // The facets' counts (under the other filters) replace the photos.
  const counted = collectionTree(LIST, new Map([['a', 1]]));
  assert.equal(counted[0]!.total, 1);
  assert.equal(counted[1]!.total, 0);
});

test('paths, ancestry and search', () => {
  const byId = collectionIndex(collectionTree(LIST));
  assert.deepEqual(collectionPath(byId, 'k'), ['Japan', 'Kyoto']);
  assert.ok(isWithin(byId, 'k', 'j'));
  assert.ok(isWithin(byId, 'j', 'j'));
  assert.ok(!isWithin(byId, 'j', 'k'));
  const found = filterCollectionTree(collectionTree(LIST), 'kyo');
  assert.deepEqual(
    found.map((n) => [n.name, n.children.map((k) => k.name)]),
    [['Japan', ['Kyoto']]],
  );
  // Every word, anywhere in the name.
  assert.deepEqual(
    filterCollectionTree(collectionTree(LIST), '11 10')[0]!.children.map((n) => n.name),
    ['2026-11-10'],
  );
  assert.equal(normalizeCollectionName('  Wedding \n day '), 'Wedding day');
});
