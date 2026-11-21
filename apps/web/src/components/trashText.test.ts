import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrashItem } from '@rawtisserie/api';
import { deletedIn, describeDeletion, describeVersions } from './trashText.ts';

const v = (id: string, photoId: string, versionCount: number) => ({ id, photoId, versionCount });
const item = (id: string, photoId: string, photoInTrash: boolean) => ({ id, photoId, photoInTrash }) as TrashItem;

test('moving all of a photo’s versions says photos, otherwise versions', () => {
  assert.equal(describeVersions([v('a', 'p', 1)]), '1 photo');
  assert.equal(describeVersions([v('a', 'p', 2), v('b', 'p', 2), v('c', 'q', 1)]), '3 photos');
  assert.equal(describeVersions([v('a', 'p', 2)]), '1 version');
  assert.equal(describeVersions([v('a', 'p', 2), v('c', 'q', 1)]), '2 versions');
});

test('deleting from the trash names the originals that go with it', () => {
  // q: one of its two trashed versions selected, the original stays for the other.
  // r: still has a version in the library.
  const all = [item('a', 'p', true), item('b', 'q', true), item('c', 'q', true), item('d', 'r', false)];
  assert.match(describeDeletion([all[0]!], all).body, /^1 original file will be deleted, with its edits/);
  assert.match(describeDeletion([all[1]!], all).body, /^The edit history and curation of this version/);
  assert.match(describeDeletion([all[0]!, all[1]!, all[2]!], all).body, /^2 original files will be deleted/);
  assert.match(describeDeletion([all[3]!], all).body, /Their original files stay/);
  assert.equal(describeDeletion(all, all).title, 'Delete 4 items permanently?');
  assert.match(describeDeletion([all[0]!], all).body, /can’t be undone\.$/);
});

test('days left before the trash is purged', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  assert.equal(deletedIn('2026-12-13T11:00:00Z', now), 'in 30 days');
  assert.equal(deletedIn('2026-11-14T11:00:00Z', now), 'tomorrow');
  assert.equal(deletedIn('2026-11-13T12:00:00Z', now), 'today');
});
