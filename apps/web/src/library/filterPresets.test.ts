import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFilters, filtersOf, sameFilters, withFilters } from './filterPresets.ts';

test('a preset saves the filters, not the sort', () => {
  assert.equal(filtersOf(new URLSearchParams('sort=filename&tag=a&ratingMin=3')), 'tag=a&ratingMin=3');
});

test('applying a preset replaces the filters and keeps the sort', () => {
  const next = withFilters(new URLSearchParams('sort=filename&tag=a&q=x'), 'tag=b&flag=picked');
  assert.equal(next.toString(), 'tag=b&flag=picked&sort=filename');
});

test('filters are the same whatever their order', () => {
  assert.ok(sameFilters('tag=a&tag=b&ratingMin=2', 'ratingMin=2&tag=b&tag=a&sort=filename'));
  assert.ok(!sameFilters('tag=a', 'tag=a&tag=b'));
});

test('a preset reads as its filters in a few words', () => {
  assert.equal(
    describeFilters('ratingMin=3&flag=picked&tag=People%7CAlice&untagged=true'),
    '★ 3+ · picked · no tags · People › Alice',
  );
});
