import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayTag, isUnder, normalizeTag, retag, tagParent, tagTree, filterTagTree } from './tags.ts';

test('tags are paths', () => {
  assert.equal(normalizeTag(' People | Alice |'), 'People|Alice');
  assert.equal(normalizeTag('AC/DC'), 'AC/DC');
  assert.equal(displayTag('People|Alice'), 'People › Alice');
  assert.equal(tagParent('People|Alice'), 'People');
  assert.equal(tagParent('People'), null);
  assert.ok(isUnder('People|Alice', 'People') && isUnder('People', 'People'));
  assert.ok(!isUnder('Peoples', 'People'));
  assert.equal(retag('People|Alice|2026', 'People|Alice', 'Family|Alice'), 'Family|Alice|2026');
});

test('a tree of the levels, by name, missing ones added', () => {
  const tree = tagTree([
    { value: 'People', count: 3 },
    { value: 'People|Bob', count: 1 },
    { value: 'People|Alice', count: 2 },
    { value: '2026|11', count: 5 },
  ]);
  assert.deepEqual(
    tree.map((n) => [n.path, n.count, n.children.map((c) => c.name)]),
    [
      ['2026', 0, ['11']],
      ['People', 3, ['Alice', 'Bob']],
    ],
  );
});

test('searching the tree keeps the matches, the way to them and what is under them', () => {
  const tree = tagTree([
    { value: 'People|Alice|Kid', count: 1 },
    { value: 'People|Bob', count: 1 },
    { value: 'Places|Paris', count: 1 },
  ]);
  const paths = (nodes: ReturnType<typeof tagTree>): string[] => nodes.flatMap((n) => [n.path, ...paths(n.children)]);
  assert.deepEqual(paths(filterTagTree(tree, 'alíce')), ['People', 'People|Alice', 'People|Alice|Kid']);
  assert.deepEqual(paths(filterTagTree(tree, 'peo')), ['People', 'People|Alice', 'People|Alice|Kid', 'People|Bob']);
  assert.deepEqual(paths(filterTagTree(tree, ' ')), paths(tree));
  assert.deepEqual(filterTagTree(tree, 'nowhere'), []);
});
