import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFilterQuery } from './filterPresets.ts';

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
