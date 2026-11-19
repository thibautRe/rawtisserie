/**
 * Render queue: renders thumbnails/previews for versions whose `render_status` is
 * `pending`, on a small pool of worker threads. The database is the source of
 * truth, so pending work survives restarts. A worker is started when there's work and
 * stopped once idle: WebAssembly memory never shrinks, so a worker that has decoded a
 * large RAW keeps that memory until it exits.
 *
 * A render that fails is tried again by itself: after `RETRY_DELAYS_MS` (what passes: a
 * storage error, a worker that crashed), then by the next build (`config.revision`), on
 * start (what a deploy fixes: a file missing from the image, a pipeline bug). So a
 * failure never needs someone to re-render by hand.
 */
import { Worker } from 'node:worker_threads';
// Loaded here too, before any worker: a native addon loaded only in workers can be
// unloaded when one exits, which crashes the others (and workers stop when idle).
import 'sharp';
import type { Queryable } from '@databases/pg';
import type { FastifyBaseLogger } from 'fastify';
import { AUTO_RECIPE_LABEL, type EditParams, type PhotoMetadata } from '@rawtisserie/pipeline';
import { config } from '../config.ts';
import { db, photos, sql, versions } from '../db.ts';
import { RENDER_SIZES, deleteRenders, renderKey, type RenderFormat, type RenderSize } from '../photos/storage.ts';
import { renderSource } from './source.ts';
import { RenderStats, writeRenderStats } from './stats.ts';
import type { RenderJob, RenderResult } from './types.ts';

const IDLE_MS = 2 * 60_000;

/** After the 1st, 2nd and 3rd failure in a row, the next try; then none until the next build. */
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;
/** How often renders due for another try are looked for. */
const RETRY_SWEEP_MS = 60_000;

/** When a render that failed `attempts` times in a row is tried again: ms from now, or null (the next build). */
export const retryDelay = (attempts: number): number | null => RETRY_DELAYS_MS[attempts - 1] ?? null;

/** What renders are made as now, and at what quality (sharp's AVIF scale, roadmap 7.11). */
const FORMAT: RenderFormat = 'avif';
/** As good as the JPEGs before (q82 and q88, by SSIM) at about 65 % and 45 % of their size. */
const QUALITY: Record<RenderSize, number> = { thumb: 65, preview: 60 };

interface PoolWorker {
  worker: Worker | null;
  busy: boolean;
  /** The job it's running, resolved when the worker answers (or crashes). */
  pending: { jobId: number; resolve: (r: RenderResult) => void } | null;
  idle: ReturnType<typeof setTimeout> | undefined;
}

export class RenderQueue {
  private queue: string[] = [];
  private inFlight = new Set<string>();
  /** Versions edited again while rendering: render once more when done (since when). */
  private dirty = new Map<string, number>();
  /** When each waiting version was queued (for those left from before a restart: the start). */
  private queuedAt = new Map<string, number>();
  private stats: RenderStats;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private pool: PoolWorker[] = [];
  private nextJobId = 1;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
    this.stats = new RenderStats(writeRenderStats(db), {
      onError: (err) => log.warn({ err }, 'could not write render stats'),
    });
  }

  start() {
    for (let i = 0; i < config.renderConcurrency; i++) {
      this.pool.push({ worker: null, busy: false, pending: null, idle: undefined });
    }
    this.flushTimer = setInterval(() => void this.flushStats(), 60_000);
    this.flushTimer.unref();
    this.retryTimer = setInterval(
      () => void this.retryDue().catch((err) => this.log.warn({ err }, 'could not look for renders to retry')),
      RETRY_SWEEP_MS,
    );
    this.retryTimer.unref();
  }

  async stop() {
    clearInterval(this.flushTimer);
    clearInterval(this.retryTimer);
    await Promise.all(this.pool.map((entry) => this.retire(entry)));
    this.pool = [];
    await this.flushStats();
  }

  /** Write this hour's figures so far (`render_stats`), e.g. before reading them. */
  async flushStats() {
    await this.stats.flush().catch((err) => this.log.warn({ err }, 'could not write render stats'));
  }

  /** How long the oldest waiting version has waited (0 when none is). */
  oldestWaitMs(): number {
    const oldest = Math.min(...this.queue.map((id) => this.queuedAt.get(id) ?? Date.now()));
    return this.queue.length ? Date.now() - oldest : 0;
  }

  private countPending() {
    this.stats.pendingNow(this.queue.length + this.inFlight.size);
  }

  /**
   * Queue every version still marked as pending (e.g. after a restart), with those that
   * failed under another build: this one may have fixed them, so they get their tries again.
   */
  async enqueuePending() {
    const retried = await db.query(sql`
      UPDATE versions SET render_status = 'pending', render_error = NULL, render_attempts = 0, render_retry_at = NULL
      WHERE render_status = 'failed' AND render_failed_build IS DISTINCT FROM ${config.revision}
      RETURNING id`);
    if (retried.length) this.log.info({ versions: retried.length }, 'retrying renders that failed under another build');
    const rows = await db.query(sql`SELECT id FROM versions WHERE render_status = 'pending' ORDER BY created_at`);
    for (const row of rows) this.enqueue(row.id as string);
  }

  /** Queue the renders that failed and are due for another try. */
  async retryDue() {
    const rows = await db.query(sql`
      UPDATE versions SET render_status = 'pending', render_retry_at = NULL
      WHERE render_status = 'failed' AND render_retry_at <= now()
      RETURNING id`);
    for (const row of rows) this.enqueue(row.id as string);
  }

  /** Mark a render failed, with when to try it again (`retryDelay`). */
  private async fail(versionId: string, error: string) {
    const delays = RETRY_DELAYS_MS as readonly number[];
    const [row] = (await db.query(sql`
      UPDATE versions SET render_status = 'failed', render_error = ${error},
        render_attempts = render_attempts + 1, render_failed_build = ${config.revision},
        render_retry_at = CASE WHEN render_attempts < ${delays.length}
          THEN now() + (${delays}::int[])[render_attempts + 1] * interval '1 millisecond' END
      WHERE id = ${versionId}
      RETURNING render_attempts, render_retry_at`)) as { render_attempts: number; render_retry_at: Date | null }[];
    if (row)
      this.log.warn(
        { versionId, error, attempts: row.render_attempts, retryAt: row.render_retry_at },
        row.render_retry_at ? 'render failed, will retry' : 'render failed, retried by the next build',
      );
  }

  enqueue(versionId: string) {
    if (this.inFlight.has(versionId)) {
      if (!this.dirty.has(versionId)) this.dirty.set(versionId, Date.now());
    } else if (!this.queue.includes(versionId)) {
      this.queue.push(versionId);
      this.queuedAt.set(versionId, Date.now());
    }
    this.countPending();
    this.pump();
  }

  /** The entry's worker, started if it has none. */
  private spawn(entry: PoolWorker): Worker {
    clearTimeout(entry.idle);
    if (entry.worker) return entry.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url));
    worker.on('message', (result: RenderResult) => {
      if (entry.pending?.jobId !== result.jobId) return;
      const { resolve } = entry.pending;
      entry.pending = null;
      resolve(result);
    });
    worker.on('error', (err) => {
      this.log.error({ err }, 'render worker crashed');
      if (entry.worker === worker) entry.worker = null;
      const pending = entry.pending;
      entry.pending = null;
      pending?.resolve({ jobId: pending.jobId, ok: false, error: 'Render worker crashed' });
    });
    entry.worker = worker;
    return worker;
  }

  /** Stop the entry's worker, freeing its memory; the next job starts another. */
  private async retire(entry: PoolWorker) {
    clearTimeout(entry.idle);
    const worker = entry.worker;
    entry.worker = null;
    await worker?.terminate();
  }

  private pump() {
    for (const entry of this.pool) {
      if (entry.busy) continue;
      const versionId = this.queue.shift();
      if (!versionId) {
        clearTimeout(entry.idle);
        if (entry.worker) entry.idle = setTimeout(() => void this.retire(entry), IDLE_MS).unref();
        continue;
      }
      clearTimeout(entry.idle);
      entry.busy = true;
      this.inFlight.add(versionId);
      this.stats.started(Date.now() - (this.queuedAt.get(versionId) ?? Date.now()));
      this.queuedAt.delete(versionId);
      this.process(entry, versionId)
        .catch(async (err) => {
          // Before the worker ran (the database, storage): failed like a render, so it's retried.
          this.log.error({ err, versionId }, 'render failed');
          await this.fail(versionId, err instanceof Error ? err.message : String(err)).catch((e) =>
            this.log.error({ err: e, versionId }, 'could not record a failed render'),
          );
        })
        .finally(() => {
          entry.busy = false;
          this.inFlight.delete(versionId);
          const again = this.dirty.get(versionId);
          if (again !== undefined) {
            this.dirty.delete(versionId);
            this.queue.push(versionId);
            this.queuedAt.set(versionId, again);
          }
          this.countPending();
          this.pump();
        });
    }
  }

  private run(entry: PoolWorker, job: Omit<RenderJob, 'jobId'>): Promise<RenderResult> {
    const jobId = this.nextJobId++;
    return new Promise((resolve) => {
      entry.pending = { jobId, resolve };
      this.spawn(entry).postMessage({ ...job, jobId });
    });
  }

  private async process(entry: PoolWorker, versionId: string) {
    const job = await renderSource(versionId);
    if (!job) return;
    const started = Date.now();
    const result = await this.run(entry, {
      sourceKey: job.sourceKey,
      params: job.params,
      autoDefaults: job.autoDefaults,
      importedEdits: job.importedEdits,
      userLuts: job.userLuts,
      extractMetadata: job.needsMetadata,
      luts: job.luts,
      outputs: (Object.entries(RENDER_SIZES) as [RenderSize, number][]).map(([size, maxSize]) => ({
        key: renderKey(versionId, size, FORMAT),
        maxSize,
        quality: QUALITY[size],
      })),
    });

    this.stats.finished(result.ok, Date.now() - started);
    if (!result.ok) {
      await this.fail(versionId, result.error);
      return;
    }
    this.log.info({ versionId, ms: Date.now() - started }, 'rendered');
    const stored = await db.tx(async (tx) => {
      const [before] = await tx.query(sql`SELECT render_format FROM versions WHERE id = ${versionId} FOR UPDATE`);
      if (!before) return false;
      await tx.query(sql`
        UPDATE versions
        SET render_status = 'ready', render_error = NULL, render_version = render_version + 1, render_format = ${FORMAT},
          render_attempts = 0, render_retry_at = NULL, render_failed_build = NULL
        WHERE id = ${versionId}`);
      if (result.defaultRecipe) await addDefaultRecipe(tx, versionId, result.defaultRecipe, result.imported);
      if (result.resolvedRecipe && job.params) await resolveEntry(tx, versionId, job.params, result.resolvedRecipe);
      if (result.metadata) {
        await photos(tx).update({ id: job.photoId }, metadataColumns(result.metadata));
        // The in-camera rating seeds versions that haven't been rated yet.
        const rating = Math.min(5, Math.max(0, result.metadata.rating ?? 0));
        if (rating) await versions(tx).update({ photo_id: job.photoId, rating: 0 }, { rating });
      }
      return { previous: before.render_format as RenderFormat };
    });
    // Deleted while it rendered (e.g. from the trash): what it wrote has nothing left to show.
    if (!stored) await deleteRenders(versionId);
    // Rendered in another format than before (JPEG, before 7.11): those files are stale.
    else if (stored.previous !== FORMAT) await deleteRenders(versionId, [stored.previous]);
  }
}

/**
 * Record the recipe a new image starts with (auto-tuned) as its first history
 * entry, and the import of edits from another application after it (`imported`), if the
 * version still has no history. The revision isn't bumped: a developer opened before
 * this ran saves over it instead of getting a conflict. An import is an edit.
 */
async function addDefaultRecipe(
  tx: Queryable,
  versionId: string,
  recipe: EditParams,
  imported: { label: string; recipe: EditParams } | null,
) {
  const entries = [{ label: AUTO_RECIPE_LABEL, recipe }, ...(imported ? [imported] : [])];
  const inserted = await tx.query(sql`
    INSERT INTO history_entries (version_id, seq, label, recipe)
    SELECT ${versionId}, e.seq, e.label, e.recipe
    FROM jsonb_to_recordset(${JSON.stringify(entries.map((e, i) => ({ ...e, seq: i + 1 })))}::jsonb)
      AS e(seq int, label text, recipe jsonb)
    WHERE NOT EXISTS (SELECT 1 FROM history_entries WHERE version_id = ${versionId})
    RETURNING seq`);
  if (inserted.length)
    await versions(tx).update(
      { id: versionId, history_end: 0 },
      { history_end: entries.length, ...(imported && { edited: true }) },
    );
}

/**
 * Write the auto-tunes resolved while rendering (roadmap 8.7) into the history entry
 * they were rendered from, if it's still the current one and unchanged. Like the default
 * recipe, the revision isn't bumped: a developer opened before resolves them itself and
 * saves over it. If the version changed meanwhile, it's rendered (and resolved) again.
 */
async function resolveEntry(tx: Queryable, versionId: string, rendered: EditParams, resolved: EditParams) {
  await tx.query(sql`
    UPDATE history_entries h SET recipe = ${JSON.stringify(resolved)}::jsonb
    FROM versions v
    WHERE v.id = ${versionId} AND h.version_id = v.id AND h.seq = v.history_end
      AND h.recipe = ${JSON.stringify(rendered)}::jsonb`);
}

/** Map extracted metadata onto the indexed (and user-editable) columns. */
function metadataColumns(m: PhotoMetadata) {
  const capturedAt = m.capturedAt ? new Date(m.capturedAt) : null;
  return {
    exif: m,
    camera_make: m.make,
    camera_model: m.model,
    lens: m.lensModel,
    iso: m.iso,
    exposure_time: m.exposureTime,
    f_number: m.fNumber,
    focal_length: m.focalLength,
    exposure_bias: m.exposureBias,
    captured_at: capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
    width: m.width,
    height: m.height,
    gps_latitude: m.gpsLatitude,
    gps_longitude: m.gpsLongitude,
    artist: m.artist,
    copyright: m.copyright,
  };
}
