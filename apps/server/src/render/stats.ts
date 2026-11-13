/**
 * The render queue's figures per hour (`render_stats`): peak number of pending renders
 * (waiting or rendering), longest wait before a render started, renders done and failed,
 * and how long they took. Kept in memory for the current hour and merged into its row
 * every minute, when the hour changes, and on shutdown: counts as increments since the
 * last write (added up), peaks as maxima. So restarts and several server processes add
 * up correctly, and a crash loses at most a minute of counts.
 */
import type { Queryable } from '@databases/pg';
import { sql } from '@databases/pg';

export interface Bucket {
  hour: number;
  peakPending: number;
  maxWaitMs: number;
  renders: number;
  failures: number;
  renderMs: number;
  maxRenderMs: number;
}

const HOUR = 3600_000;
const hourOf = (t: number) => t - (t % HOUR);
const empty = (hour: number, pending: number): Bucket => ({
  hour,
  peakPending: pending,
  maxWaitMs: 0,
  renders: 0,
  failures: 0,
  renderMs: 0,
  maxRenderMs: 0,
});

/** Merges a bucket into its hour's row: counts added up, peaks kept at their maximum. */
export const writeRenderStats = (db: Queryable) => async (b: Bucket) => {
  await db.query(sql`
    INSERT INTO render_stats (hour, peak_pending, max_wait_ms, renders, failures, render_ms, max_render_ms)
    VALUES (${new Date(b.hour)}, ${b.peakPending}, ${b.maxWaitMs}, ${b.renders}, ${b.failures},
      ${b.renderMs}, ${b.maxRenderMs})
    ON CONFLICT (hour) DO UPDATE SET
      peak_pending = GREATEST(render_stats.peak_pending, EXCLUDED.peak_pending),
      max_wait_ms = GREATEST(render_stats.max_wait_ms, EXCLUDED.max_wait_ms),
      renders = render_stats.renders + EXCLUDED.renders,
      failures = render_stats.failures + EXCLUDED.failures,
      render_ms = render_stats.render_ms + EXCLUDED.render_ms,
      max_render_ms = GREATEST(render_stats.max_render_ms, EXCLUDED.max_render_ms)`);
};

export class RenderStats {
  private bucket: Bucket;
  private pending = 0;
  private write: (b: Bucket) => Promise<void>;
  private now: () => number;
  private onError: (err: unknown) => void;

  constructor(
    write: (b: Bucket) => Promise<void>,
    { now = Date.now, onError = (_err: unknown) => {} }: { now?: () => number; onError?: (err: unknown) => void } = {},
  ) {
    this.write = write;
    this.now = now;
    this.onError = onError;
    this.bucket = empty(hourOf(now()), 0);
  }

  /** The current hour's bucket, after writing out the previous one if the hour changed. */
  private current(): Bucket {
    const hour = hourOf(this.now());
    if (hour !== this.bucket.hour) {
      const done = this.bucket;
      // A queue that spans hours counts in each of them.
      this.bucket = empty(hour, this.pending);
      this.write(done).catch(this.onError);
    }
    return this.bucket;
  }

  /** Renders pending (waiting or rendering) right now. */
  pendingNow(count: number) {
    this.pending = count;
    const b = this.current();
    b.peakPending = Math.max(b.peakPending, count);
  }

  /** A render started after waiting `ms` in the queue. */
  started(waitMs: number) {
    const b = this.current();
    b.maxWaitMs = Math.max(b.maxWaitMs, Math.round(waitMs));
  }

  finished(ok: boolean, ms: number) {
    const b = this.current();
    if (!ok) {
      b.failures++;
      return;
    }
    b.renders++;
    b.renderMs += Math.round(ms);
    b.maxRenderMs = Math.max(b.maxRenderMs, Math.round(ms));
  }

  /** Merge what the current hour has gathered since the last write into its row. */
  async flush() {
    this.pendingNow(this.pending);
    const b = this.bucket;
    const counts = { renders: b.renders, failures: b.failures, renderMs: b.renderMs };
    b.renders = b.failures = b.renderMs = 0;
    await this.write({ ...b, ...counts });
  }
}
