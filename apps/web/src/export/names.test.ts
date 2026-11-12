import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveName, uniqueName } from './names.ts';

test('names that are taken get -2, -3… before their extension', () => {
  const taken = new Set(['a.jpg', 'a-2.jpg', 'notes']);
  const has = (n: string) => taken.has(n);
  assert.equal(uniqueName('b.jpg', has), 'b.jpg');
  assert.equal(uniqueName('a.jpg', has), 'a-3.jpg');
  assert.equal(uniqueName('notes', has), 'notes-2');
  assert.equal(
    uniqueName('.hidden', (n) => n === '.hidden'),
    '.hidden-2',
  );
});

test('the archive is named after when it was made', () => {
  assert.equal(archiveName(new Date(2026, 10, 1, 9, 5, 7)), 'rawtisserie-2026-11-01-090507.zip');
  assert.equal(archiveName(new Date(2026, 10, 1, 9, 5, 7), 'retry'), 'rawtisserie-2026-11-01-090507-retry.zip');
  assert.equal(archiveName(new Date(2026, 10, 1, 9, 5, 7), undefined, 2), 'rawtisserie-2026-11-01-090507-part2.zip');
});
