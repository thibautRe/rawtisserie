import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type EditParams,
  addInstance,
  defaultEditParams,
  defaultModuleParams,
  moveInstance,
  removeInstance,
  updateInstance,
  updateModule,
} from '@rawtisserie/pipeline';
import { type HistoryOp, HistoryStore, compressHistory } from './history.ts';

const exposure = (p: EditParams, ev: number) => updateModule(p, 'exposure', { params: { ev } });
const glow = (p: EditParams, strength: number) => updateModule(p, 'glow', { enabled: true, params: { strength } });

function store() {
  const s = new HistoryStore(defaultEditParams, { entries: [], end: 0 });
  const ops: HistoryOp[] = [];
  s.onOp = (op) => ops.push(op);
  return { s, ops };
}

test('changes to the same module within the window share an entry', () => {
  const { s, ops } = store();
  const a = exposure(defaultEditParams, 1);
  s.commit(a, 0);
  s.commit(exposure(a, 1.5), 10_000);
  assert.equal(s.getState().entries.length, 1);
  assert.equal(s.getState().entries[0]!.label, 'Exposure: ev 1.5');
  assert.deepEqual(
    ops.map((o) => o.type === 'splice' && o.from),
    [1, 1],
  );
  // Too late, or another module: a new entry.
  s.commit(exposure(s.committed, 2), 40_000);
  s.commit(glow(s.committed, 1), 41_000);
  assert.equal(s.getState().entries.length, 3);
});

test('committing from an earlier point drops the later entries, and restore brings them back', () => {
  const { s, ops } = store();
  s.commit(exposure(defaultEditParams, 1), 0);
  s.commit(glow(s.committed, 1), 1);
  s.commit(glow(s.committed, 2), 60_000);
  s.goto(1);
  // No coalescing with an entry this session didn't write last.
  const snapshot = s.snapshot();
  assert.equal(s.commit(exposure(s.committed, 3), 60_001), 2);
  assert.deepEqual(
    s.getState().entries.map((e) => e.label),
    ['Exposure: ev 1', 'Exposure: ev 3'],
  );
  s.restore(snapshot);
  assert.equal(s.getState().end, 1);
  assert.equal(s.getState().entries.length, 3);
  assert.deepEqual(ops.at(-1), { type: 'splice', from: 2, entries: snapshot.entries.slice(1), end: 1 });
});

test('coming back to the entry written last still coalesces', () => {
  const { s } = store();
  s.commit(exposure(defaultEditParams, 1), 0);
  s.undo();
  s.redo();
  s.commit(exposure(s.committed, 1.5), 20_000);
  assert.equal(s.getState().entries.length, 1);
  assert.equal(s.getState().entries[0]!.label, 'Exposure: ev 1.5');
});

test('undo and redo move the end', () => {
  const { s } = store();
  s.commit(exposure(defaultEditParams, 1), 0);
  s.undo();
  assert.equal(s.getState().live, defaultEditParams);
  s.undo();
  assert.equal(s.getState().end, 0);
  s.redo();
  s.redo();
  assert.equal(s.getState().end, 1);
});

test('compress keeps one entry per changed instance, in order of last change', () => {
  const at = (recipe: EditParams, label = 'x') => ({ label, recipe, createdAt: '2026-01-01T00:00:00Z' });
  const r1 = exposure(defaultEditParams, 1);
  const r2 = glow(r1, 1);
  const r3 = exposure(r2, 2);
  const r4 = updateModule(r3, 'colorBalance', { enabled: true, params: { vibrance: 0.2 } });
  const r5 = updateModule(r4, 'filmic', { params: { contrast: 1.5 } });
  const r6 = updateModule(r5, 'filmic', { params: { contrast: defaultModuleParams.filmic.contrast } });
  const out = compressHistory(defaultEditParams, [at(r1), at(r2), at(r3), at(r4), at(r5), at(r6)]);
  // Filmic is back to its original state: no entry.
  assert.deepEqual(
    out.map((e) => e.label),
    ['Glow: on, strength 1', 'Exposure: ev 2', 'Color balance: vibrance 0.2'],
  );
  assert.deepEqual(out.at(-1)!.recipe, r6);
  assert.deepEqual(compressHistory(defaultEditParams, [at(r1), at(defaultEditParams)]), []);
});

test('adding, removing, renaming and moving instances are entries of their own', () => {
  const { s } = store();
  s.commit(exposure(defaultEditParams, 1), 0);
  s.commit(addInstance(s.committed, 'exposure'), 1);
  s.commit(updateInstance(s.committed, 'exposure', 'exposure-2', { params: { ev: 2 } }), 2);
  s.commit(updateInstance(s.committed, 'exposure', 'exposure-2', { params: { ev: 3 } }), 3);
  s.commit(updateInstance(s.committed, 'exposure', 'exposure-2', { label: 'sky' }), 4);
  s.commit(moveInstance(s.committed, 'exposure-2', -1), 5);
  s.commit(removeInstance(s.committed, 'exposure-2'), 6);
  // The id is free again: this isn't a change to the instance just removed.
  s.commit(addInstance(s.committed, 'exposure'), 7);
  assert.deepEqual(
    s.getState().entries.map((e) => e.label),
    [
      'Exposure: ev 1',
      'Exposure 2: added',
      'Exposure 2: ev 3',
      'Exposure (sky): renamed',
      'Exposure: reordered',
      'Exposure (sky): removed',
      'Exposure 2: added',
    ],
  );
});

test('compress keeps a change of order', () => {
  const at = (recipe: EditParams) => ({ label: 'x', recipe, createdAt: '2026-01-01T00:00:00Z' });
  const original = addInstance(defaultEditParams, 'exposure');
  const moved = moveInstance(original, 'exposure-2', -1);
  const out = compressHistory(original, [at(moved)]);
  assert.deepEqual(
    out.map((e) => e.label),
    ['Exposure: reordered'],
  );
  assert.deepEqual(out.at(-1)!.recipe, moved);
});

test('a labelled change (a preset, a style) gets its own entry', () => {
  const { s } = store();
  s.commit(exposure(defaultEditParams, 1), 0);
  s.commit(exposure(s.committed, 1.2), 1, 'Exposure: preset Bright');
  s.commit(exposure(s.committed, 1.4), 2);
  assert.deepEqual(
    s.getState().entries.map((e) => e.label),
    ['Exposure: ev 1', 'Exposure: preset Bright', 'Exposure: ev 1.4'],
  );
});
