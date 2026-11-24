import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListRequest, Target, normalizeFilterQuery, parseLibraryQuery, parseListQuery } from './query.ts';

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

test('boolean tag filters and exact ratings read as lists (roadmap 8.12)', () => {
  const q = parseLibraryQuery('tag=People%7CAlice&tag=People%7CBob&tagAny=People&notTag=Places&rating=2&rating=3');
  assert.deepEqual(q.tag, ['People|Alice', 'People|Bob']);
  assert.deepEqual(q.tagAny, ['People']);
  assert.deepEqual(q.notTag, ['Places']);
  assert.deepEqual(q.rating, [2, 3]);
  assert.throws(() => parseLibraryQuery('rating=6'));
  assert.equal(
    normalizeFilterQuery('sort=filename&rating=4&notTag=a&tagAny=%7C&tag=b'),
    'tag=b&notTag=a&tagAny=%7C&rating=4',
  );
});

test('collections are ids, or "none" for photos in none', () => {
  const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  assert.deepEqual(parseLibraryQuery(`collection=${id}&collection=none`).collection, [id, 'none']);
  assert.deepEqual(parseLibraryQuery(`collection=${id}`).collection, [id]);
  assert.throws(() => parseLibraryQuery('collection=Trips'));
  assert.equal(normalizeFilterQuery(`collection=none&sort=filename`), 'collection=none');
});

test('a page listing versions kept outside the filters: the query with its paging, and ids', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const q = parseListQuery('flag=unflagged&limit=50&offset=100');
  assert.deepEqual([q.flag, q.limit, q.offset], [['unflagged'], 50, 100]);
  assert.deepEqual(ListRequest.parse({ query: '', keep: [id] }).keep, [id]);
  assert.throws(() => ListRequest.parse({ query: '', keep: ['nope'] }));
  assert.deepEqual(Target.parse({ filter: '', keep: [id] }), { filter: '', except: [], keep: [id] });
});
