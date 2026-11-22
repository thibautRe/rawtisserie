import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickerStart } from './libraryView.ts';

test('the picker starts on the library’s filters, with its sort', () => {
  assert.equal(pickerStart('tag=People&sort=filename', 'c1'), 'tag=People&sort=filename');
  assert.equal(pickerStart('collection=c2', 'c1'), 'collection=c2');
});

test('without filters in the library, the picker starts on the photo’s collection', () => {
  assert.equal(pickerStart(undefined, 'c1'), 'collection=c1');
  assert.equal(pickerStart('', 'c1'), 'collection=c1');
  // The sort and how tags combine aren't filters.
  assert.equal(pickerStart('sort=filename&tagAny=%7C', 'c1'), 'sort=filename&tagAny=%7C&collection=c1');
});

test('with neither, the picker shows everything', () => {
  assert.equal(pickerStart(undefined, null), '');
  assert.equal(pickerStart('sort=ratingDesc', null), 'sort=ratingDesc');
});
