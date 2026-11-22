import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type EditParams, defaultEditParams, findModule, updateModule } from '@rawtisserie/pipeline';
import { compareRecipe, framingKey, splitClip, targetLabel } from './compare.ts';

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

test('the split divider crosses the whole pane, the assessment frame and margin too', () => {
  const hidden = (clip: string) => Number(/inset\(0 ([\d.]+)px/.exec(clip)![1]);
  // Without the assessment mode, the window is the pane.
  assert.equal(hidden(splitClip(0.25, 800, 800)), 600);
  // A window 500 wide centred in 800 (150 either side): the divider beyond it on the left
  // hides all of it, on the right none of it; within it, what's right of it.
  assert.equal(hidden(splitClip(0.1, 800, 500)), 500);
  assert.equal(hidden(splitClip(0.95, 800, 500)), 0);
  assert.equal(hidden(splitClip(0.5, 800, 500)), 250);
});
