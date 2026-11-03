import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dragTo, fineStep, growExtent, modifierFactor, nudge, parseTyped, sinhCurve, snapTo, typedText } from './slider.ts';

const contrast = { min: 0.5, max: 3, step: 0.01, fine: 0.01 };
const ev = { min: -4, max: 4, step: 0.05, fine: 0.01 };

test('modifiers: shift is coarse, ctrl or cmd is fine', () => {
  const keys = { shiftKey: false, ctrlKey: false, metaKey: false };
  assert.equal(modifierFactor(keys), 1);
  assert.equal(modifierFactor({ ...keys, shiftKey: true }), 10);
  assert.equal(modifierFactor({ ...keys, ctrlKey: true }), 0.1);
  assert.equal(modifierFactor({ ...keys, metaKey: true }), 0.1);
});

test('the fine step stops at what the number shows', () => {
  const ev2 = (v: number) => `${v.toFixed(2)} EV`;
  assert.equal(fineStep(0.05, ev2, 1), 0.01);
  // Already at the number's precision.
  assert.equal(fineStep(0.01, ev2, 1), 0.01);
  // More digits than a tenth of the step needs.
  assert.equal(fineStep(0.1, (v) => v.toFixed(3), 1), 0.01);
  // Display units: "+0.0 %" of a fraction shows thousandths.
  assert.equal(fineStep(0.005, (v) => `${(v * 100).toFixed(1)} %`, 100), 0.001);
  // A display coarser than the step keeps the step.
  assert.equal(fineStep(0.01, (v) => `${((v * 180) / Math.PI).toFixed(0)}°`, 180 / Math.PI), 0.01);
});

test('nudge moves by clean steps', () => {
  assert.equal(nudge(0.1, 1, 1, ev, [-4, 4]), 0.15);
  assert.equal(nudge(0.1, -1, 10, ev, [-4, 4]), -0.4);
  assert.equal(nudge(0.1, 1, 0.1, ev, [-4, 4]), 0.11);
});

test('nudge stays on the track, with or without a modifier', () => {
  assert.equal(nudge(2.995, 1, 1, contrast, [0.5, 3]), 3);
  assert.equal(nudge(3, 1, 0.1, contrast, [0.5, 3]), 3);
  assert.equal(nudge(3, 1, 10, contrast, [0.5, 3]), 3);
});

test('on a grown track, nudge reaches its whole length', () => {
  assert.equal(nudge(4.5, 1, 1, contrast, [0.5, 4.5]), 4.5);
  assert.equal(nudge(4.5, -1, 1, contrast, [0.5, 4.5]), 4.49);
  assert.equal(nudge(3.5, 1, 1, contrast, [0.5, 4.5]), 3.51);
});

test('the track grows to contain the value', () => {
  const start = [0.5, 3] as const;
  assert.equal(growExtent(start, 1, contrast), start);
  assert.deepEqual(growExtent(start, 4.2, contrast), [0.5, 4.2]);
  assert.deepEqual(growExtent(start, 0.2, contrast), [0.2, 3]);
});

test('the track does not shrink back', () => {
  const grown = [0.5, 4.2] as const;
  assert.equal(growExtent(grown, 1, contrast), grown);
  assert.deepEqual(growExtent(grown, 0.2, contrast), [0.2, 4.2]);
});

test('a bipolar track grows on both sides, keeping its neutral point centred', () => {
  const start = [-4, 4] as const;
  assert.equal(growExtent(start, 1, ev), start);
  assert.deepEqual(growExtent(start, 6, ev), [-6, 6]);
  assert.deepEqual(growExtent(start, -7, ev), [-7, 7]);
  const grown = [-6, 6] as const;
  assert.equal(growExtent(grown, -5, ev), grown);
});

test('a plain drag snaps to the step, on a grown track too', () => {
  assert.equal(snapTo(1.023, [-4, 4], ev), 1);
  assert.equal(snapTo(1.03, [-4, 4], ev), 1.05);
  assert.equal(snapTo(4.1, [0.5, 4.2], contrast), 4.1);
  assert.equal(snapTo(4.2, [0.5, 4.2], contrast), 4.2);
});

test('a modifier makes the drag relative, without jumping', () => {
  const track = [-4, 4] as const;
  // Pressed far from the thumb: nothing moves.
  const pressed = dragTo(null, 3, 0.1, 0, ev, track);
  assert.equal(pressed.value, 0);
  // The fine drag is ten times slower.
  const fine = dragTo(pressed.anchor, 3.1, 0.1, pressed.value, ev, track);
  assert.equal(fine.value, 0.01);
  // Small moves add up rather than being rounded away.
  assert.equal(dragTo(fine.anchor, 3.3, 0.1, fine.value, ev, track).value, 0.03);
  // Releasing it keeps going from there, at full speed.
  const released = dragTo(fine.anchor, 3.1, 1, fine.value, ev, track);
  assert.equal(released.value, 0.01);
  assert.equal(dragTo(released.anchor, 3.6, 1, released.value, ev, track).value, 0.51);
});

test('engaging a modifier keeps a value finer than its steps', () => {
  assert.equal(dragTo(null, 3, 10, 2.12, ev, [-4, 4]).value, 2.12);
});

test('a drag with a modifier stays on the track', () => {
  const { anchor } = dragTo(null, 0, 10, 2.9, contrast, [0.5, 3]);
  assert.equal(dragTo(anchor, 1, 10, 2.9, contrast, [0.5, 3]).value, 3);
  assert.equal(dragTo(anchor, -1, 10, 2.9, contrast, [0.5, 3]).value, 0.5);
  assert.equal(dragTo(anchor, 1, 10, 2.9, contrast, [0.5, 4.2]).value, 4.2);
});

test('typing accepts a decimal comma, signs and units', () => {
  assert.equal(parseTyped('4.2', 1, 0, 5), 4.2);
  assert.equal(parseTyped('4,2', 1, 0, 5), 4.2);
  assert.equal(parseTyped(' +1.5 EV', 1, -10, 10), 1.5);
  assert.equal(parseTyped('−2', 1, -10, 10), -2);
  assert.equal(parseTyped('abc', 1, 0, 5), null);
  assert.equal(parseTyped('', 1, 0, 5), null);
});

test('typing is clamped to the hard range', () => {
  assert.equal(parseTyped('9', 1, 0, 5), 5);
  assert.equal(parseTyped('-1', 1, 0, 5), 0);
});

test('typing uses display units', () => {
  assert.equal(parseTyped('150', 100, 0, 2), 1.5);
  assert.equal(typedText(1.5, 100), '150');
  assert.equal(typedText(0.07, 100), '7');
  assert.equal(typedText(0.1 + 0.2, 1), '0.3');
});

test('the sinh curve keeps 0 and the range ends, and inverts exactly', () => {
  const c = sinhCurve(90);
  for (const v of [-90, 0, 90]) assert.ok(Math.abs(c.toValue(v) - v) < 1e-9);
  for (const v of [-180, -45, -0.5, 3, 60, 180]) assert.ok(Math.abs(c.toValue(c.toPosition(v)) - v) < 1e-9);
  // Finer in the middle, coarser at the ends.
  const slope = (p: number) => (c.toValue(p + 1e-4) - c.toValue(p)) / 1e-4;
  assert.ok(Math.abs(slope(0) - 2 / Math.sinh(2)) < 1e-3);
  assert.ok(slope(85) > 1.8);
});

test('drags and snapping on a curved track work in values', () => {
  const c = sinhCurve(90);
  const hue = { min: -90, max: 90, step: 0.5, fine: 0.05 };
  // A position snaps to the value step.
  assert.equal(snapTo(c.toPosition(10.2), [-90, 90], hue, c), 10);
  // A relative drag moves along the track: 10 positions from 0 is less than 10 values.
  const start = dragTo(null, 0, 1, 0, hue, [-90, 90], c);
  const moved = dragTo(start.anchor, 10, 1, 0, hue, [-90, 90], c);
  assert.equal(moved.value, Number(c.toValue(10).toFixed(1)));
  assert.equal(moved.value, 5.6);
});
