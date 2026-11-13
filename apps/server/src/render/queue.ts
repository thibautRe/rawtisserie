/**
 * Render queue: renders thumbnails/previews for versions whose `render_status` is
 * `pending`, on a small pool of worker threads. The database is the source of
 * truth, so pending work survives restarts.
 */
import { Worker } from 'node:worker_threads';
import type { Queryable } from '@databases/pg';
import type { FastifyBaseLogger } from 'fastify';
import { AUTO_RECIPE_LABEL, type EditParams, type PhotoMetadata } from '@rawtisserie/pipeline';
import { config } from '../config.ts';
import { db, photos, sql, versions } from '../db.ts';
import { RENDER_SIZES, deleteRenders, renderKey, type RenderSize } from '../photos/storage.ts';
import { renderSource } from './source.ts';
import { RenderStats, writeRenderStats } from './stats.ts';
import type { RenderJob, RenderResult } from './types.ts';

interface PoolWorker {
  worker: Worker;
  busy: boolean;
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
  private pool: PoolWorker[] = [];
  private pending = new Map<number, (r: RenderResult) => void>();
  private nextJobId = 1;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
    this.stats = new RenderStats(writeRenderStats(db), {
      onError: (err) => log.warn({ err }, 'could not write render stats'),
    });
  }

  start() {
    for (let i = 0; i < config.renderConcurrency; i++) this.pool.push(this.spawn());
    this.flushTimer = setInterval(() => void this.flushStats(), 60_000);
    this.flushTimer.unref();
  }

  async stop() {
    clearInterval(this.flushTimer);
    await Promise.all(this.pool.map((w) => w.worker.terminate()));
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

  /** Queue every version still marked as pending (e.g. after a restart). */
  async enqueuePending() {
    const rows = await db.query(sql`SELECT id FROM versions WHERE render_status = 'pending' ORDER BY created_at`);
    for (const row of rows) this.enqueue(row.id as string);
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

  private spawn(): PoolWorker {
    const entry: PoolWorker = { worker: new Worker(new URL('./worker.ts', import.meta.url)), busy: false };
    entry.worker.on('message', (result: RenderResult) => {
      this.pending.get(result.jobId)?.(result);
      this.pending.delete(result.jobId);
    });
    entry.worker.on('error', (err) => {
      this.log.error({ err }, 'render worker crashed; restarting');
      for (const [id, resolve] of this.pending) resolve({ jobId: id, ok: false, error: 'Render worker crashed' });
      this.pending.clear();
      const idx = this.pool.indexOf(entry);
      if (idx >= 0) this.pool[idx] = this.spawn();
    });
    return entry;
  }

  private pump() {
    for (const entry of this.pool) {
      if (entry.busy) continue;
      const versionId = this.queue.shift();
      if (!versionId) return;
      entry.busy = true;
      this.inFlight.add(versionId);
      this.stats.started(Date.now() - (this.queuedAt.get(versionId) ?? Date.now()));
      this.queuedAt.delete(versionId);
      this.process(entry, versionId)
        .catch((err) => this.log.error({ err, versionId }, 'render failed'))
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
      this.pending.set(jobId, resolve);
      entry.worker.postMessage({ ...job, jobId });
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
      extractMetadata: job.needsMetadata,
      luts: job.luts,
      outputs: (Object.entries(RENDER_SIZES) as [RenderSize, number][]).map(([size, maxSize]) => ({
        key: renderKey(versionId, size),
        maxSize,
        quality: size === 'thumb' ? 82 : 88,
      })),
    });

    this.stats.finished(result.ok, Date.now() - started);
    if (!result.ok) {
      this.log.warn({ versionId, error: result.error }, 'render failed');
      await versions(db).update({ id: versionId }, { render_status: 'failed', render_error: result.error });
      return;
    }
    this.log.info({ versionId, ms: Date.now() - started }, 'rendered');
    const stored = await db.tx(async (tx) => {
      const updated = await tx.query(sql`
        UPDATE versions SET render_status = 'ready', render_error = NULL, render_version = render_version + 1
        WHERE id = ${versionId} RETURNING id`);
      if (!updated.length) return false;
      if (result.defaultRecipe) await addDefaultRecipe(tx, versionId, result.defaultRecipe);
      if (result.resolvedRecipe && job.params) await resolveEntry(tx, versionId, job.params, result.resolvedRecipe);
      if (result.metadata) {
        await photos(tx).update({ id: job.photoId }, metadataColumns(result.metadata));
        // The in-camera rating seeds versions that haven't been rated yet.
        const rating = Math.min(5, Math.max(0, result.metadata.rating ?? 0));
        if (rating) await versions(tx).update({ photo_id: job.photoId, rating: 0 }, { rating });
      }
      return true;
    });
    // Deleted while it rendered (e.g. from the trash): what it wrote has nothing left to show.
    if (!stored) await deleteRenders(versionId);
  }
}

/**
 * Record the recipe a new image starts with (lens correction) as its first history
 * entry, if the version still has no history. The revision isn't bumped: a developer
 * opened before this ran saves over it instead of getting a conflict.
 */
async function addDefaultRecipe(tx: Queryable, versionId: string, recipe: EditParams) {
  const inserted = await tx.query(sql`
    INSERT INTO history_entries (version_id, seq, label, recipe)
    SELECT ${versionId}, 1, ${AUTO_RECIPE_LABEL}, ${JSON.stringify(recipe)}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM history_entries WHERE version_id = ${versionId})
    RETURNING seq`);
  if (inserted.length) await versions(tx).update({ id: versionId, history_end: 0 }, { history_end: 1 });
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
