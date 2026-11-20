import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RANGES,
  growSpan,
  hueCss,
  maskIsActive,
  maskSummary,
  moveHandle,
  rangePolygons,
  shiftRange,
  trackSpan,
} from './masks.ts';
import { defaultMask } from '@rawtisserie/pipeline';

const L = RANGES.luminance;
const H = RANGES.hue;

test('moving a handle pushes the ones it meets', () => {
  assert.deepEqual(moveHandle([-3, -1, 1, 3], 1, 2, L), [-3, 2, 2, 3]);
  assert.deepEqual(moveHandle([-3, -1, 1, 3], 2, -4, L), [-4, -4, -4, 3]);
  // Past the track, up to the hard limits.
  assert.deepEqual(moveHandle([-3, -1, 1, 3], 3, 9.04, L), [-3, -1, 1, 9]);
  assert.deepEqual(moveHandle([-3, -1, 1, 3], 3, 99, L), [-3, -1, 1, 18]);
  assert.deepEqual(moveHandle([-3, -1, 1, 3], 0, -30, L), [-21, -1, 1, 3]);
});

test('hue handles move around the circle', () => {
  // A red range across 0°.
  const red: [number, number, number, number] = [330, 350, 30, 50];
  assert.deepEqual(moveHandle(red, 2, 10, H), [330, 350, 10, 50]);
  assert.deepEqual(moveHandle(red, 3, 90, H), [330, 350, 30, 90]);
  // Past `c`, `b` pushes it.
  assert.deepEqual(moveHandle(red, 1, 40, H), [330, 40, 40, 50]);
  // `a` moved towards `b` pushes it; moved away widens the rise.
  assert.deepEqual(moveHandle(red, 0, 355, H), [355, 355, 30, 50]);
  assert.deepEqual(moveHandle(red, 0, 300, H), [300, 350, 30, 50]);
  // Just behind its predecessor, a handle stays there rather than going round.
  assert.deepEqual(moveHandle(red, 2, 340, H), [330, 350, 350, 50]);
});

test('ranges shift as a whole', () => {
  assert.deepEqual(shiftRange([-3, -1, 1, 3], 2, L), [-1, 1, 3, 5]);
  assert.deepEqual(shiftRange([-3, -1, 1, 3], 30, L), [12, 14, 16, 18]);
  assert.deepEqual(shiftRange([330, 350, 30, 50], 20, H), [350, 10, 50, 70]);
});

test('a hue range across 0° is drawn twice', () => {
  const polys = rangePolygons([330, 350, 30, 50], H, 360, 10);
  assert.equal(polys.length, 2);
  assert.equal(polys[0], '330.0,10 350.0,0 390.0,0 410.0,10');
  assert.equal(polys[1], '-30.0,10 -10.0,0 30.0,0 50.0,10');
  assert.equal(rangePolygons([-3, -1, 1, 3], L, 180, 10).length, 1);
});

test('hue colours follow the masks’ hues', () => {
  // Red ≈ 12°, green ≈ 128°, blue ≈ 266°.
  const rgb = (css: string) => [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16));
  const [r1, g1, b1] = rgb(hueCss(12));
  assert.ok(r1! > g1! && r1! > b1!, hueCss(12));
  const [r2, g2, b2] = rgb(hueCss(128));
  assert.ok(g2! > r2! && g2! > b2!, hueCss(128));
  const [r3, g3, b3] = rgb(hueCss(266));
  assert.ok(b3! > r3! && b3! > g3!, hueCss(266));
});

test('an empty mask does nothing', () => {
  assert.equal(maskIsActive(undefined), false);
  assert.equal(maskIsActive({ ...defaultMask }), false);
  assert.equal(maskIsActive({ ...defaultMask, opacity: 0.5 }), true);
  assert.equal(maskIsActive({ ...defaultMask, hue: [0, 1, 2, 3] }), true);
  assert.equal(maskIsActive({ ...defaultMask, hue: [0, 1, 2, 3], enabled: false }), false);
});

test('the track widens to a range past its ends', () => {
  assert.deepEqual(trackSpan([-3, -1, 1, 3], L), [-12, 6]);
  assert.deepEqual(trackSpan([-3, -1, 8, 14], L), [-12, 14]);
  assert.deepEqual(trackSpan([-15, -14, 1, 3], L), [-15, 6]);
  assert.deepEqual(trackSpan(null, L), [-12, 6]);
  assert.deepEqual(rangePolygons([0, 2, 4, 6], L, 120, 10, [0, 12]), ['0.0,10 20.0,0 40.0,0 60.0,10']);
});

test('a track widens while a handle is held past its end', () => {
  // A quarter of luminance's usual 18 EV per second, up to the hard limits.
  assert.deepEqual(growSpan([-12, 6], 1, 1, L), [-12, 10.5]);
  assert.deepEqual(growSpan([-12, 6], -1, 0.5, L), [-14.25, 6]);
  assert.deepEqual(growSpan([-12, 16], 1, 2, L), [-12, 18]);
  assert.deepEqual(growSpan([0, 360], 1, 1, H), [0, 360]);
});

test('a mask in a few words', () => {
  assert.equal(maskSummary({ ...defaultMask }), 'everywhere');
  const shape = { shape: 's1', op: 'union' as const };
  assert.equal(
    maskSummary({ ...defaultMask, drawn: [shape, shape], luminance: [-3, -1, 1, 3], opacity: 0.6, blend: 'softLight' }),
    '2 shapes · luminance · 60 % · soft light',
  );
  assert.equal(maskSummary({ ...defaultMask, invert: true, enabled: false }), 'inverted');
});
