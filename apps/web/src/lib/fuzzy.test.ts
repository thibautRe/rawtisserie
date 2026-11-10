import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDistance, fold, fuzzyFilter, fuzzyScore } from './fuzzy.ts';

test('fold ignores case, accents and surrounding space', () => {
  assert.equal(fold('  Île-de-FRANCE '), 'ile-de-france');
});

test('edit distance counts a swap of neighbours as one typo', () => {
  assert.equal(editDistance('baech', 'beach'), 1);
  assert.equal(editDistance('beach', 'beach'), 0);
  assert.equal(editDistance('bech', 'beach'), 1);
  assert.equal(editDistance('', 'abc'), 3);
});

test('better matches score higher', () => {
  const score = (q: string, c: string) => fuzzyScore(fold(q), c) ?? -1;
  assert.ok(score('beach', 'Beach') > score('beach', 'beaches'));
  assert.ok(score('bea', 'beach') > score('york', 'new york'));
  assert.ok(score('york', 'new york') > score('ork', 'new york'));
  assert.ok(score('ork', 'new york') > score('baech', 'beach'));
  assert.ok(score('baech', 'beach') > score('nwyk', 'new york'));
  assert.equal(fuzzyScore('zz', 'beach'), null);
  // Too short to guess a typo.
  assert.equal(fuzzyScore('bx', 'beach'), null);
});

test('typos are forgiven on the start of longer tags', () => {
  assert.notEqual(fuzzyScore(fold('mountian'), 'mountains'), null);
  assert.notEqual(fuzzyScore(fold('portrat'), 'portrait'), null);
  assert.notEqual(fuzzyScore(fold('strt'), 'street'), null);
});

test('fuzzyFilter sorts by score, then weight, then name', () => {
  const tags = [
    { value: 'seagull', count: 2 },
    { value: 'sea', count: 1 },
    { value: 'seascape', count: 5 },
    { value: 'forest', count: 9 },
  ];
  const found = fuzzyFilter('sea', tags, { key: (t) => t.value, weight: (t) => t.count });
  assert.deepEqual(
    found.map((t) => t.value),
    ['sea', 'seascape', 'seagull'],
  );
  assert.equal(fuzzyFilter('s', tags, { key: (t) => t.value, limit: 1 }).length, 1);
});
