import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addInstance, defaultEditParams, findModule, updateModule } from '@rawtisserie/pipeline';

// Web storage for the module (Node has none by default).
const storage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
};
Object.assign(globalThis, { localStorage: storage(), sessionStorage: storage() });
const { copyEdits, lastSelection, pasteEdit, readClipboard, rememberPick } = await import('./editClipboard.ts');

test('a copy is pasted like a style, labelled with its source', () => {
  const source = updateModule(defaultEditParams, 'exposure', { params: { ev: 1.5 } });
  assert.equal(readClipboard(), null);
  assert.equal(copyEdits(source, lastSelection(source), 'DSC01234'), source.modules.length);
  const clip = readClipboard()!;
  assert.equal(clip.source, 'DSC01234');
  const edit = pasteEdit(clip);
  assert.equal(edit.label, 'Paste from DSC01234');
  assert.equal(pasteEdit(clip, true).label, 'Paste from DSC01234 (appended)');
  assert.notEqual(edit.key, pasteEdit(clip, true).key);
  assert.equal(findModule(edit.apply(defaultEditParams), 'exposure')!.params.ev, 1.5);
});

test('the copy picks what was picked last time, and the defaults for instances it never saw', () => {
  const recipe = updateModule(defaultEditParams, 'retouch', {});
  const ids = (r: typeof recipe) => lastSelection(r).ids;
  assert.ok(!ids(recipe).includes('retouch'), 'retouch is not copied by default');
  assert.ok(ids(recipe).includes('exposure'));

  rememberPick(recipe, {
    ids: ['retouch', 'filmic'],
    modes: {},
    groups: { filmic: ['look'] },
    autoTune: { filmic: true },
  });
  const other = addInstance(recipe, 'exposure');
  const picked = lastSelection(other);
  assert.ok(picked.ids.includes('exposure-2'), 'not seen last time: picked by default');
  assert.ok(!picked.ids.includes('exposure'), 'unpicked last time');
  assert.deepEqual(picked.groups, { filmic: ['look'] });
  assert.deepEqual(picked.autoTune, { filmic: true });
});
