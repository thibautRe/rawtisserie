import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveRange } from './filmicRange.ts';

const start = { whiteExposure: 3, blackExposure: -9, dynamicRangeScaling: 0 };

test('the scaling rescales white and black around middle grey', () => {
  assert.deepEqual(moveRange(start, 'dynamicRangeScaling', 50), { whiteExposure: 4.5, blackExposure: -13.5, dynamicRangeScaling: 50 });
  assert.deepEqual(moveRange(start, 'dynamicRangeScaling', -50), { whiteExposure: 1.5, blackExposure: -4.5, dynamicRangeScaling: -50 });
  // Relative to the current scaling, so going back to 0 restores the unscaled range.
  const scaled = { whiteExposure: 4.5, blackExposure: -13.5, dynamicRangeScaling: 50 };
  assert.deepEqual(moveRange(scaled, 'dynamicRangeScaling', 0), start);
});

test('the scaling keeps white and black within their limits', () => {
  const r = moveRange({ whiteExposure: 8, blackExposure: -10, dynamicRangeScaling: 0 }, 'dynamicRangeScaling', 200);
  assert.deepEqual(r, { whiteExposure: 16, blackExposure: -16, dynamicRangeScaling: 200 });
});

test('white and black move the scaling, keeping the unscaled range', () => {
  // 12 EV → 15 EV: +25 %.
  assert.deepEqual(moveRange(start, 'whiteExposure', 6), { whiteExposure: 6, blackExposure: -9, dynamicRangeScaling: 25 });
  assert.deepEqual(moveRange(start, 'blackExposure', -6), { whiteExposure: 3, blackExposure: -6, dynamicRangeScaling: -25 });
  // Unscaled range 12 EV, already at +50 %: 18 → 15 EV is +25 %.
  const scaled = { whiteExposure: 4.5, blackExposure: -13.5, dynamicRangeScaling: 50 };
  assert.equal(moveRange(scaled, 'blackExposure', -10.5).dynamicRangeScaling, 25);
});

test('the scaling from white and black stays within its limits', () => {
  assert.equal(moveRange(start, 'blackExposure', -1).dynamicRangeScaling, -50);
});
