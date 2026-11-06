import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FRAME, type Frame, frameLayout } from './frame.ts';
import { frameLayout as frameLayoutWasm, initPipeline } from './node.ts';

const frames: Frame[] = [
  DEFAULT_FRAME,
  { ...DEFAULT_FRAME, size: 0 },
  { ...DEFAULT_FRAME, size: 0.137, line: 0.01, lineOffset: 0.02 },
  { ...DEFAULT_FRAME, size: 0.03, aspect: 1 },
  { ...DEFAULT_FRAME, size: 0.05, aspect: 1.25, orientation: 'portrait' },
  { ...DEFAULT_FRAME, size: 0.2, aspect: 16 / 9, orientation: 'landscape', position: [0.2, 0.9] },
  { ...DEFAULT_FRAME, size: 0.1, aspect: 4 / 3, position: [1, 0], line: 0.003, lineOffset: 0.015 },
];
const sizes: [number, number][] = [
  [6000, 4000],
  [4000, 6000],
  [1080, 1080],
  [2047, 1365],
  [333, 501],
  [7, 3],
];

test('frame layout matches Rust', () => {
  initPipeline();
  for (const frame of frames) {
    for (const [w, h] of sizes) {
      const [width, height, x, y, lineOffset, lineWidth] = frameLayoutWasm(JSON.stringify(frame), w, h);
      assert.deepEqual(
        frameLayout(frame, w, h),
        { width, height, x, y, lineOffset, lineWidth },
        `${JSON.stringify(frame)} ${w}×${h}`,
      );
    }
  }
});

test('Rust reads the default frame', () => {
  initPipeline();
  const [width, height] = frameLayoutWasm('{}', 600, 400);
  assert.deepEqual(
    [width, height],
    [frameLayout(DEFAULT_FRAME, 600, 400).width, frameLayout(DEFAULT_FRAME, 600, 400).height],
  );
});
