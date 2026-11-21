import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type EditParams, defaultEditParams, findModule, updateModule } from '@rawtisserie/pipeline';
import { compareRecipe, framingKey, targetLabel } from './compare.ts';

const cropped = (p: EditParams, x: number) =>
  updateModule(p, 'geometry', { params: { crop: { x, y: 0, width: 0.5, height: 0.5 } } });
const exposed = (p: EditParams, ev: number) => updateModule(p, 'exposure', { params: { ev } });

test('the compared recipe keeps its look and takes the current framing', () => {
  const other = cropped(exposed(defaultEditParams, 1), 0);
  const current = cropped(exposed(defaultEditParams, -1), 0.25);
  const r = compareRecipe(other, current);
  assert.equal(findModule(r, 'exposure')!.params.ev, 1);
  assert.deepEqual(findModule(r, 'geometry'), findModule(current, 'geometry'));
  assert.deepEqual(findModule(r, 'lens'), findModule(current, 'lens'));
  assert.equal(r.modules.length, other.modules.length);
});

test('modules stay in pipeline order', () => {
  const r = compareRecipe(defaultEditParams, defaultEditParams);
  assert.deepEqual(
    r.modules.map((m) => m.kind),
    defaultEditParams.modules.map((m) => m.kind),
  );
});

test('only framing changes the key', () => {
  const p = defaultEditParams;
  assert.equal(framingKey(exposed(p, 2)), framingKey(p));
  assert.notEqual(framingKey(cropped(p, 0.1)), framingKey(p));
});

test('targets are named', () => {
  const entries = [{ label: 'Exposure' }];
  const versions = [{ id: 'v2', label: 'Version 2', thumbUrl: null, recipe: async () => defaultEditParams }];
  assert.equal(targetLabel({ kind: 'history', seq: 0 }, entries, versions), 'Original');
  assert.equal(targetLabel({ kind: 'history', seq: 1 }, entries, versions), '1. Exposure');
  assert.equal(targetLabel({ kind: 'version', id: 'v2' }, entries, versions), 'Version 2');
});
