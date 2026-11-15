import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDelete, describeRename, managedTags, planEdit } from './tagManager.ts';

const { tree, info } = managedTags({
  levels: [
    { value: 'People', photos: 120, trashed: 2 },
    { value: 'People|Alice', photos: 119, trashed: 2 },
    { value: 'People|Alice|Kid', photos: 3, trashed: 0 },
    { value: 'Family', photos: 5, trashed: 0 },
    { value: 'Family|Alice', photos: 5, trashed: 0 },
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
  assert.deepEqual(describeRename('People|Alice', 'People|Alicia', info), {
    text: 'People › Alice becomes People › Alicia on 119 photos (and 2 versions in the trash). The tag under it follows.',
    action: 'Rename',
  });
  assert.equal(describeRename('People|Alice|Kid', 'Kid', info).action, 'Move');
  const merge = describeRename('People|Alice', 'Family|Alice', info);
  assert.equal(merge.action, 'Merge');
  assert.match(merge.text, /Family › Alice exists already: they’ll be one tag\./);
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

const key = (code: string) => ({
  code,
  key: code.slice(3).toLowerCase(),
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
});

test('the editor says what saving will do, and its button says it too', () => {
  const edit = (e: Partial<Parameters<typeof planEdit>[0]>) =>
    planEdit({ tag: 'People|Alice', parent: 'People', name: 'Alice', shortcut: null, ...e }, info);
  // As it was: nothing to save, the button still says what it'd do.
  assert.deepEqual(edit({}), { problem: '', effects: [], changes: [], action: 'Save' });
  // `|` isn't a way to move it: Parent is.
  assert.equal(
    edit({ name: 'Family|Alice' }).problem,
    'A name can’t contain |: choose where the tag goes with Parent.',
  );
  assert.equal(edit({ name: ' ' }).problem, '');
  const merged = edit({ parent: 'Family' });
  assert.equal(merged.action, 'Merge');
  assert.deepEqual(merged.changes, [{ type: 'rename', from: 'People|Alice', to: 'Family|Alice' }]);
  assert.equal(edit({ parent: 'People|Alice|Kid' }).problem, 'A tag can’t go inside itself.');

  // Renamed and given a shortcut: the rename first, then the shortcut on its new path.
  const both = edit({ name: 'Alicia', shortcut: [key('KeyA')] });
  assert.deepEqual(
    both.changes.map((c) => c.type),
    ['rename', 'shortcut'],
  );
  assert.deepEqual(both.changes[1], { type: 'shortcut', tag: 'People|Alicia', shortcut: [key('KeyA')] });
  assert.match(both.effects[1]!, /^Ctrl\+Alt\+A will add or remove People › Alicia/);
  // Another tag's shortcut.
  assert.equal(edit({ shortcut: [key('KeyO')] }).problem, 'Places › Paris has Ctrl+Alt+O');

  const fresh = planEdit({ tag: null, parent: 'Places', name: 'Paris', shortcut: null }, info);
  assert.equal(fresh.problem, 'Places › Paris exists already.');
  const created = planEdit({ tag: null, parent: 'Places', name: 'Lyon', shortcut: null }, info);
  assert.deepEqual([created.action, created.changes], ['Create', [{ type: 'create', tag: 'Places|Lyon' }]]);
});
