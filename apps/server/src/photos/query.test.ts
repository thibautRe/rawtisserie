import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Target, normalizeFilterQuery, parseLibraryQuery } from './query.ts';

test("the library's query string reads as /api/versions' does: repeated keys are lists", () => {
  const q = parseLibraryQuery('q=beach&tag=People&tag=Places%7CParis&flag=picked&ratingMin=3&sort=filename');
  assert.equal(q.q, 'beach');
  assert.deepEqual(q.tag, ['People', 'Places|Paris']);
  assert.deepEqual(q.flag, ['picked']);
  assert.equal(q.ratingMin, 3);
  assert.equal(q.sort, 'filename');
});

test('an empty query string is the whole library, newest first', () => {
  const q = parseLibraryQuery('');
  assert.equal(q.sort, 'capturedDesc');
  assert.equal(q.tag, undefined);
});

test('"no tags" is its own filter', () => {
  assert.equal(parseLibraryQuery('untagged=true').untagged, 'true');
  assert.throws(() => parseLibraryQuery('untagged=yes'));
});

test('paging is not part of a selection by filter, and a bad filter is refused', () => {
  assert.equal('offset' in parseLibraryQuery('offset=400&limit=200'), false);
  assert.throws(() => parseLibraryQuery('ratingMin=9'));
});

test('a target is ids, or a filter with the versions unticked since', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(Target.parse({ ids: [id] }), { ids: [id] });
  assert.deepEqual(Target.parse({ filter: 'tag=beach' }), { filter: 'tag=beach', except: [] });
  assert.throws(() => Target.parse({ ids: [] }));
});

test('a filter preset keeps the filters only, in a stable order', () => {
  assert.equal(
    normalizeFilterQuery('sort=filename&tag=People&ratingMin=3&offset=200&tag=Places%7CParis&junk=1'),
    'tag=People&tag=Places%7CParis&ratingMin=3',
  );
  assert.equal(normalizeFilterQuery('sort=filename'), '');
});

test('a filter that cannot be read is refused', () => {
  assert.throws(() => normalizeFilterQuery('ratingMin=9'));
});
