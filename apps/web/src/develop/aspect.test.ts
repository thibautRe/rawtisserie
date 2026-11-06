import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FREE_ASPECT,
  aspectLabel,
  aspectText,
  aspectRatio,
  constrainAspect,
  flipCrop,
  isPortrait,
  parseAspect,
} from './aspect.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('typed ratios', () => {
  close(parseAspect('51:48')!, 51 / 48);
  close(parseAspect(' 16 / 9 ')!, 16 / 9);
  close(parseAspect('16x9')!, 16 / 9);
  close(parseAspect('16X9')!, 16 / 9);
  close(parseAspect('16×9')!, 16 / 9);
  close(parseAspect('16 * 9')!, 16 / 9);
  close(parseAspect('2.39')!, 2.39);
  close(parseAspect('2,39:1')!, 2.39);
  close(parseAspect('A4')!, Math.SQRT2);
  close(parseAspect(' a3 ')!, Math.SQRT2);
  close(parseAspect('B5')!, Math.SQRT2);
  close(parseAspect('Letter')!, 11 / 8.5);
  for (const bad of ['A', 'A123', 'D4', '', 'abc', '16:', ':9', '0:1', '1:0', '1:2:3'])
    assert.equal(parseAspect(bad), null, bad);
});

test('presets and flipping', () => {
  const frame = 1.5;
  assert.equal(aspectRatio(FREE_ASPECT, frame), null);
  assert.equal(aspectRatio({ ...FREE_ASPECT, flipped: true }, frame), null);
  close(aspectRatio({ preset: '3:2', custom: '', flipped: true }, frame)!, 2 / 3);
  close(aspectRatio({ preset: 'xpan', custom: '', flipped: false }, frame)!, 65 / 24);
  close(aspectRatio({ preset: 'original', custom: '', flipped: true }, frame)!, 1 / 1.5);
  close(aspectRatio({ preset: 'custom', custom: '51:48', flipped: false }, frame)!, 51 / 48);
  assert.equal(aspectRatio({ preset: 'custom', custom: 'nope', flipped: false }, frame), null);
  assert.equal(aspectLabel('XPan (65:24)', true), 'XPan (24:65)');
  assert.equal(aspectLabel('Original', true), 'Original');
});

test('flipping a crop swaps its pixel width and height', () => {
  const frame = 1.5; // 6000×4000
  const rect = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }; // 1200×800 px
  const flipped = flipCrop(rect, frame);
  close(flipped.width * 6000, 800);
  close(flipped.height * 4000, 1200);
  close(flipped.x + flipped.width / 2, 0.5);
  close(flipped.y + flipped.height / 2, 0.5);
  assert.ok(isPortrait(flipped, frame) && !isPortrait(rect, frame));
  // The full frame becomes the largest 2:3 crop.
  const full = flipCrop({ x: 0, y: 0, width: 1, height: 1 }, frame);
  close(full.height, 1);
  close((full.width * 6000) / 4000, 2 / 3);
  close(full.x, (1 - full.width) / 2);
  // Constraining to the flipped ratio keeps it as is.
  const kept = constrainAspect(flipped, 2 / 3, frame);
  for (const k of ['x', 'y', 'width', 'height'] as const) close(kept[k], flipped[k]);
});

test('ratios as text', () => {
  assert.equal(aspectText(6000 / 4000), '3:2');
  assert.equal(aspectText(4000 / 6000), '3:2');
  assert.equal(aspectText(1621 / 1080), '3:2'); // a fitted render's rounding
  assert.equal(aspectText(65 / 24), '65:24');
  assert.equal(aspectText(1), '1:1');
  // Nothing simple: the closest preset.
  assert.equal(aspectText(Math.SQRT2 * 1.001), 'A4');
  assert.equal(aspectText(7 / 6), '7:6');
  assert.equal(aspectText(1.611), '3:2');
});
