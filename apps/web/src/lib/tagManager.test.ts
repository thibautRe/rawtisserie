import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDelete, describeRename, managedTags } from './tagManager.ts';

const { tree, info } = managedTags({
  levels: [
    { value: 'People', photos: 120, trashed: 2 },
    { value: 'People|Gwen', photos: 119, trashed: 2 },
    { value: 'People|Gwen|Kid', photos: 3, trashed: 0 },
    { value: 'Family', photos: 5, trashed: 0 },
    { value: 'Family|Gwen', photos: 5, trashed: 0 },
  ],
  own: [
    { tag: 'Places|Paris', shortcut: [{ code: 'KeyO', key: 'o', ctrl: true, alt: true, shift: false, meta: false }] },
  ],
});

test("the manager's tree has the user's own tags, and what's under each", () => {
  assert.deepEqual(
    tree.map((n) => n.path),
    ['Family', 'People', 'Places'],
  );
  assert.deepEqual(info.get('People'), { photos: 120, trashed: 2, shortcut: null, descendants: 2 });
  assert.equal(info.get('Places|Paris')!.shortcut!.length, 1);
});

test('what a rename, a move or a merge will do, in words', () => {
  assert.deepEqual(describeRename('People|Gwen', 'People|Gwendolyn', info), {
    text: 'People › Gwen becomes People › Gwendolyn on 119 photos (and 2 versions in the trash). The tag under it follows.',
    action: 'Rename',
  });
  assert.equal(describeRename('People|Gwen|Kid', 'Kid', info).action, 'Move');
  const merge = describeRename('People|Gwen', 'Family|Gwen', info);
  assert.equal(merge.action, 'Merge');
  assert.match(merge.text, /Family › Gwen exists already: they’ll be one tag\./);
  // Nothing has it yet: no photos to speak of.
  assert.equal(describeRename('Places', 'Travel', info).text, 'Places becomes Travel. The tag under it follows.');
});

test('what a delete will do, in words', () => {
  assert.equal(
    describeDelete('People', info),
    'People will be removed from 120 photos (and 2 versions in the trash), with the 2 tags under it. The photos stay; this can’t be undone.',
  );
  assert.equal(
    describeDelete('Places|Paris', info),
    'Places › Paris will be removed. Its shortcut goes with it. The photos stay; this can’t be undone.',
  );
});
