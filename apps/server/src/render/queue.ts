/**
 * Render queue: renders thumbnails/previews for versions whose `render_status` is
 * `pending`, on a small pool of worker threads. The database is the source of
 * truth, so pending work survives restarts.
 */
import { Worker } from 'node:worker_threads';
import type { Queryable } from '@databases/pg';
import type { FastifyBaseLogger } from 'fastify';
import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';
import { config } from '../config.ts';
import { db, photos, sql, versions } from '../db.ts';
import { RENDER_SIZES, renderPath, type RenderSize } from '../photos/storage.ts';
import { renderSource } from './source.ts';
import type { RenderJob, RenderResult } from './types.ts';

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

export class RenderQueue {
  private queue: string[] = [];
  private inFlight = new Set<string>();
  /** Versions edited again while rendering: render once more when done. */
  private dirty = new Set<string>();
  private pool: PoolWorker[] = [];
  private pending = new Map<number, (r: RenderResult) => void>();
  private nextJobId = 1;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
  }

  start() {
    for (let i = 0; i < config.renderConcurrency; i++) this.pool.push(this.spawn());
  }

  async stop() {
    await Promise.all(this.pool.map((w) => w.worker.terminate()));
    this.pool = [];
  }

  /** Queue every version still marked as pending (e.g. after a restart). */
  async enqueuePending() {
    const rows = await db.query(sql`SELECT id FROM versions WHERE render_status = 'pending' ORDER BY created_at`);
    for (const row of rows) this.enqueue(row.id as string);
  }

  enqueue(versionId: string) {
    if (this.inFlight.has(versionId)) {
      this.dirty.add(versionId);
    } else if (!this.queue.includes(versionId)) {
      this.queue.push(versionId);
    }
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
      this.process(entry, versionId)
        .catch((err) => this.log.error({ err, versionId }, 'render failed'))
        .finally(() => {
          entry.busy = false;
          this.inFlight.delete(versionId);
          if (this.dirty.delete(versionId)) this.queue.push(versionId);
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
      sourcePath: job.sourcePath,
      params: job.params,
      autoDefaults: job.autoDefaults,
      extractMetadata: job.needsMetadata,
      luts: [...job.luts.values()],
      outputs: (Object.entries(RENDER_SIZES) as [RenderSize, number][]).map(([size, maxSize]) => ({
        path: renderPath(versionId, size),
        maxSize,
        quality: size === 'thumb' ? 82 : 88,
      })),
    });

    if (!result.ok) {
      this.log.warn({ versionId, error: result.error }, 'render failed');
      await versions(db).update({ id: versionId }, { render_status: 'failed', render_error: result.error });
      return;
    }
    this.log.info({ versionId, ms: Date.now() - started }, 'rendered');
    await db.tx(async (tx) => {
      await tx.query(sql`
        UPDATE versions SET render_status = 'ready', render_error = NULL, render_version = render_version + 1
        WHERE id = ${versionId}`);
      if (result.defaultRecipe) await addDefaultRecipe(tx, versionId, result.defaultRecipe);
      if (result.metadata) {
        await photos(tx).update({ id: job.photoId }, metadataColumns(result.metadata));
        // The in-camera rating seeds versions that haven't been rated yet.
        const rating = Math.min(5, Math.max(0, result.metadata.rating ?? 0));
        if (rating) await versions(tx).update({ photo_id: job.photoId, rating: 0 }, { rating });
      }
    });
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
    SELECT ${versionId}, 1, 'Lens correction (auto)', ${JSON.stringify(recipe)}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM history_entries WHERE version_id = ${versionId})
    RETURNING seq`);
  if (inserted.length) await versions(tx).update({ id: versionId, history_end: 0 }, { history_end: 1 });
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
