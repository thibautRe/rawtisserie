import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayTag, isUnder, normalizeTag, retag, tagParent, tagTree } from './tags.ts';

test('tags are paths', () => {
  assert.equal(normalizeTag(' People | Gwen |'), 'People|Gwen');
  assert.equal(normalizeTag('AC/DC'), 'AC/DC');
  assert.equal(displayTag('People|Gwen'), 'People › Gwen');
  assert.equal(tagParent('People|Gwen'), 'People');
  assert.equal(tagParent('People'), null);
  assert.ok(isUnder('People|Gwen', 'People') && isUnder('People', 'People'));
  assert.ok(!isUnder('Peoples', 'People'));
  assert.equal(retag('People|Gwen|2026', 'People|Gwen', 'Family|Gwen'), 'Family|Gwen|2026');
});

test('a tree of the levels, by name, missing ones added', () => {
  const tree = tagTree([
    { value: 'People', count: 3 },
    { value: 'People|Nova', count: 1 },
    { value: 'People|Gwen', count: 2 },
    { value: '2026|11', count: 5 },
  ]);
  assert.deepEqual(
    tree.map((n) => [n.path, n.count, n.children.map((c) => c.name)]),
    [
      ['2026', 0, ['11']],
      ['People', 3, ['Gwen', 'Nova']],
    ],
  );
});
