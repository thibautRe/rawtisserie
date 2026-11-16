import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchQuestion, photoCount } from './selectionText.ts';

test('counts are grouped, and singular for one', () => {
  assert.equal(photoCount(1), '1 photo');
  assert.equal(photoCount(1240), '1,240 photos');
});

test('a change to a large selection is asked with its number', () => {
  assert.deepEqual(patchQuestion({ rating: 3 }, 320), { title: 'Rate 320 photos 3 stars?', confirm: 'Rate' });
  assert.equal(patchQuestion({ rating: 0 }, 320).title, 'Clear the rating of 320 photos?');
  assert.equal(patchQuestion({ flag: 'rejected' }, 1240).title, 'Reject 1,240 photos?');
  assert.equal(patchQuestion({ flag: null }, 300).title, 'Unflag 300 photos?');
  assert.equal(patchQuestion({ colorLabel: 'red' }, 300).title, 'Label 300 photos red?');
  assert.equal(patchQuestion({ addTags: ['People|Alice'] }, 300).title, 'Tag 300 photos People › Alice?');
  assert.equal(patchQuestion({ removeTags: ['beach'] }, 300).title, 'Remove beach from 300 photos?');
});
