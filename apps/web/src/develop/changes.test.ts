import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addInstance, addMaskShape, defaultEditParams, updateMask, updateShape } from '@rawtisserie/pipeline';
import { describeChange } from './changes.ts';

test('mask changes are labelled', () => {
  const circle = {
    type: 'ellipse' as const,
    center: [0.5, 0.5] as [number, number],
    radii: [0.1, 0.1] as [number, number],
    rotation: 0,
    feather: 0,
    opacity: 1,
  };
  const two = addInstance(defaultEditParams, 'exposure');
  const empty = updateMask(two, 'exposure', 'exposure-2', {});
  assert.equal(describeChange(two, empty).label, 'Exposure 2: mask added');
  const ranged = updateMask(empty, 'exposure', 'exposure-2', { opacity: 0.5 });
  assert.equal(describeChange(empty, ranged).label, 'Exposure 2: mask opacity 0.5');
  const [drawn] = addMaskShape(ranged, 'exposure', 'exposure-2', circle);
  assert.equal(describeChange(ranged, drawn).label, 'Exposure 2: mask shapes');
  const moved = updateShape(drawn, 's1', { ...circle, center: [0.4, 0.5] });
  assert.deepEqual(describeChange(drawn, moved), {
    label: 'Exposure 2: mask shape edited',
    moduleId: 'exposure-2',
    structural: false,
  });
});
