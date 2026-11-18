import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clickRating,
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

test('a click shows only that rating, Ctrl/⌘ adds or removes one, Shift a range', () => {
  const click = (
    s: string,
    n: number,
    mods: { toggle?: boolean; range?: boolean } = {},
    anchor: number | null = null,
  ) => after(s, (p) => clickRating(p, n, mods, anchor));
  assert.equal(click('', 3), 'rating=3');
  assert.equal(click('rating=3', 3), '');
  assert.equal(click('rating=3', 4), 'rating=4');
  // Unrated photos are one of them.
  assert.equal(click('', 0), 'rating=0');
  assert.equal(click('rating=2', 4, { toggle: true }), 'rating=2&rating=4');
  assert.equal(click('ratingMin=3', 4, { toggle: true }), 'rating=3&rating=5');
  // A run up to 5 is "at least", as older links have it; all of them is no filter.
  assert.equal(click('rating=3', 5, { range: true }, 3), 'ratingMin=3');
  assert.equal(click('rating=2', 0, { range: true }, 2), 'rating=0&rating=1&rating=2');
  assert.equal(click('rating=0&rating=1&rating=2&rating=3&rating=4', 5, { toggle: true }), '');
  assert.deepEqual(ratingSet(q('ratingMin=4')), [4, 5]);
  assert.deepEqual(ratingSet(q('rating=0&rating=2')), [0, 2]);
});

test('ratings read back in a few words', () => {
  assert.equal(describeRating(q('ratingMin=3')), '★ 3+');
  assert.equal(describeRating(q('rating=2')), '★ 2');
  assert.equal(describeRating(q('rating=2&rating=3')), '★ 2–3');
  assert.equal(describeRating(q('rating=1&rating=3&rating=5')), '★ 1, 3, 5');
  assert.equal(describeRating(q('rating=0')), 'unrated');
  assert.equal(describeRating(q('rating=0&rating=1')), 'unrated or ★ 1');
  assert.equal(describeRating(q('')), null);
});
