/**
 * Render queue: renders thumbnails/previews for photos whose `render_status` is
 * `pending`, on a small pool of worker threads. The database is the source of
 * truth, so pending work survives restarts.
 */
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import type { PhotoMetadata } from '@rawtisserie/pipeline';
import { config } from '../config.ts';
import { db, photos, sql } from '../db.ts';
import { RENDER_SIZES, originalPath, renderPath, type RenderSize } from '../photos/storage.ts';
import type { RenderJob, RenderResult } from './types.ts';

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

export class RenderQueue {
  private queue: string[] = [];
  private inFlight = new Set<string>();
  /** Photos edited again while rendering: render once more when done. */
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

  /** Queue every photo still marked as pending (e.g. after a restart). */
  async enqueuePending() {
    const rows = await db.query(sql`SELECT id FROM photos WHERE render_status = 'pending' ORDER BY created_at`);
    for (const row of rows) this.enqueue(row.id as string);
  }

  enqueue(photoId: string) {
    if (this.inFlight.has(photoId)) {
      this.dirty.add(photoId);
    } else if (!this.queue.includes(photoId)) {
      this.queue.push(photoId);
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
      const photoId = this.queue.shift();
      if (!photoId) return;
      entry.busy = true;
      this.inFlight.add(photoId);
      this.process(entry, photoId)
        .catch((err) => this.log.error({ err, photoId }, 'render failed'))
        .finally(() => {
          entry.busy = false;
          this.inFlight.delete(photoId);
          if (this.dirty.delete(photoId)) this.queue.push(photoId);
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

  private async process(entry: PoolWorker, photoId: string) {
    const photo = await photos(db).findOne({ id: photoId });
    if (!photo) return;
    const started = Date.now();
    const result = await this.run(entry, {
      sourcePath: originalPath(photo.storage_key),
      params: photo.edit_params,
      extractMetadata: photo.exif === null,
      outputs: (Object.entries(RENDER_SIZES) as [RenderSize, number][]).map(([size, maxSize]) => ({
        path: renderPath(photo.id, size),
        maxSize,
        quality: size === 'thumb' ? 82 : 88,
      })),
    });

    if (!result.ok) {
      this.log.warn({ photoId, error: result.error }, 'render failed');
      await photos(db).update({ id: photoId }, { render_status: 'failed', render_error: result.error });
      return;
    }
    this.log.info({ photoId, ms: Date.now() - started }, 'rendered');
    await photos(db).update(
      { id: photoId },
      {
        render_status: 'ready',
        render_error: null,
        render_version: photo.render_version + 1,
        ...(result.metadata ? metadataColumns(result.metadata) : {}),
      },
    );
  }
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
    ...(m.rating ? { rating: Math.min(5, Math.max(0, m.rating)) } : {}),
  };
}
