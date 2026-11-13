import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Bucket, RenderStats } from './stats.ts';

const HOUR = 3600_000;
const T0 = Date.UTC(2026, 10, 13, 14, 0, 0);

function setup() {
  let now = T0 + 5 * 60_000;
  const written: Bucket[] = [];
  const stats = new RenderStats(async (b) => void written.push({ ...b }), { now: () => now });
  return { stats, written, at: (t: number) => (now = t) };
}

test('an hour keeps its peak, longest wait and render counts', async () => {
  const { stats, written } = setup();
  stats.pendingNow(3);
  stats.pendingNow(12);
  stats.pendingNow(4);
  stats.started(800);
  stats.started(95_000);
  stats.finished(true, 1500);
  stats.finished(true, 2500);
  stats.finished(false, 300);
  await stats.flush();
  assert.deepEqual(written, [
    { hour: T0, peakPending: 12, maxWaitMs: 95_000, renders: 2, failures: 1, renderMs: 4000, maxRenderMs: 2500 },
  ]);
});

test('counts are written as increments since the last write; peaks as they stand', async () => {
  const { stats, written } = setup();
  stats.pendingNow(5);
  stats.finished(true, 1000);
  await stats.flush();
  stats.finished(true, 1000);
  await stats.flush();
  await stats.flush();
  assert.deepEqual(
    written.map((b) => [b.renders, b.renderMs, b.peakPending]),
    [
      [1, 1000, 5],
      [1, 1000, 5],
      [0, 0, 5],
    ],
  );
});

test('a new hour writes the last one and starts at the current queue', async () => {
  const { stats, written, at } = setup();
  stats.pendingNow(40);
  stats.finished(true, 2000);
  stats.pendingNow(30);
  at(T0 + HOUR + 1000);
  // Nothing happens for a while, but 30 renders are still waiting: the new hour counts them.
  await stats.flush();
  assert.equal(written.length, 2);
  assert.deepEqual(
    written.map((b) => [new Date(b.hour).toISOString(), b.peakPending, b.renders]),
    [
      ['2026-11-13T14:00:00.000Z', 40, 1],
      ['2026-11-13T15:00:00.000Z', 30, 0],
    ],
  );
});

test('a failed write at the hour change is reported, not thrown', async () => {
  let now = T0;
  const errors: unknown[] = [];
  const stats = new RenderStats(async () => Promise.reject(new Error('database down')), {
    now: () => now,
    onError: (err) => errors.push(err),
  });
  stats.pendingNow(1);
  now = T0 + HOUR;
  stats.pendingNow(1);
  await new Promise((r) => setImmediate(r));
  assert.equal((errors[0] as Error).message, 'database down');
});
