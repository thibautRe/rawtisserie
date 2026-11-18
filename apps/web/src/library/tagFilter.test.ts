import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clickStar,
  cycleTag,
  describeRating,
  describeTags,
  ratingSet,
  setUntagged,
  tagGroups,
  tagState,
  toggleAny,
} from './tagFilter.ts';

const q = (s: string) => new URLSearchParams(s);
const after = (s: string, change: (p: URLSearchParams) => void) => {
  const p = q(s);
  change(p);
  return decodeURIComponent(p.toString());
};

test('a tag cycles: used, excluded, not used', () => {
  let p = q('untagged=true');
  cycleTag(p, 'sunset');
  assert.equal(tagState(p, 'sunset'), 'include');
  assert.equal(p.has('untagged'), false);
  cycleTag(p, 'sunset');
  assert.equal(tagState(p, 'sunset'), 'exclude');
  cycleTag(p, 'sunset');
  assert.equal(tagState(p, 'sunset'), null);
  assert.equal(p.toString(), '');
  // A group down to one tag forgets its "any".
  p = q('tag=People|Alice&tag=People|Bob&tagAny=People');
  cycleTag(p, 'People|Bob');
  assert.deepEqual(p.getAll('tagAny'), []);
});

test('tags group by parent, each group all or any', () => {
  const p = q('tag=People|Alice&tag=sunset&tag=People|Bob');
  assert.deepEqual(
    [...tagGroups(p)],
    [
      ['People', ['People|Alice', 'People|Bob']],
      ['|', ['sunset']],
    ],
  );
  toggleAny(p, 'People');
  assert.deepEqual(describeTags(p), ['People › Alice or People › Bob', 'sunset']);
  toggleAny(p, 'People');
  assert.deepEqual(describeTags(p), ['People › Alice', 'People › Bob', 'sunset']);
  // Alice and nobody else.
  assert.deepEqual(describeTags(q('tag=People|Alice&notTag=People')), ['People › Alice', 'no other People']);
  assert.deepEqual(describeTags(q('notTag=Places')), ['not Places']);
});

test('"No tags" leaves the excluded tags', () => {
  assert.equal(
    after('tag=a&notTag=b&tagAny=|', (p) => setUntagged(p, true)),
    'notTag=b&untagged=true',
  );
});

test('a click is "at least", Ctrl/⌘ toggles a star, Shift picks a range', () => {
  assert.equal(
    after('', (p) => clickStar(p, 3, {}, null)),
    'ratingMin=3',
  );
  assert.equal(
    after('ratingMin=3', (p) => clickStar(p, 3, {}, null)),
    '',
  );
  // At least 1: rated, unrated photos left out.
  assert.equal(
    after('', (p) => clickStar(p, 1, {}, null)),
    'ratingMin=1',
  );
  // 3+ without 4: 3 and 5.
  assert.equal(
    after('ratingMin=3', (p) => clickStar(p, 4, { toggle: true }, 3)),
    'rating=3&rating=5',
  );
  assert.equal(
    after('', (p) => clickStar(p, 2, { toggle: true }, null)),
    'rating=2',
  );
  // Back to a run up to 5: "at least" again.
  assert.equal(
    after('rating=3&rating=5', (p) => clickStar(p, 4, { toggle: true }, 5)),
    'ratingMin=3',
  );
  assert.equal(
    after('rating=2', (p) => clickStar(p, 3, { range: true }, 2)),
    'rating=2&rating=3',
  );
  assert.equal(
    after('', (p) => clickStar(p, 4, { range: true }, 2)),
    'rating=2&rating=3&rating=4',
  );
  assert.deepEqual(ratingSet(q('ratingMin=4')), [4, 5]);
});

test('ratings read back in a few words', () => {
  assert.equal(describeRating(q('ratingMin=3')), '★ 3+');
  assert.equal(describeRating(q('rating=2')), '★ 2');
  assert.equal(describeRating(q('rating=2&rating=3')), '★ 2–3');
  assert.equal(describeRating(q('rating=1&rating=3&rating=5')), '★ 1, 3, 5');
  assert.equal(describeRating(q('')), null);
});
