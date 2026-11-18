import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameInQuery } from './filterPresets.ts';

test('saved filters follow a tag renamed or deleted, wherever it is', () => {
  const query = 'tag=People%7CAlice&notTag=People&tagAny=People&ratingMin=3';
  assert.equal(renameInQuery(query, 'People', 'Family'), 'tag=Family%7CAlice&notTag=Family&tagAny=Family&ratingMin=3');
  assert.equal(
    renameInQuery(query, 'People|Alice', 'People|Alicia'),
    'tag=People%7CAlicia&notTag=People&tagAny=People&ratingMin=3',
  );
  assert.equal(renameInQuery(query, 'People', null), 'ratingMin=3');
  // Untouched: the same string back.
  assert.equal(renameInQuery(query, 'Places', 'Travel'), query);
});
