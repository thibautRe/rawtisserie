/**
 * Zoomed-in views for the culling loupe: tiles of a version at 100 % (and at powers of
 * two below, down to the stored preview's size), rendered on demand by one worker
 * thread (`zoomWorker.ts`) that keeps the last file decoded. Requests the client gave
 * up on (it moved on) are dropped before they're rendered. The worker is stopped when
 * idle, which frees the memory a full-resolution decode takes.
 */
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import type { RenderSource } from './source.ts';
import type { ZoomJob, ZoomLevels, ZoomRequest, ZoomResponse, ZoomSource } from './zoomTypes.ts';

const IDLE_MS = 2 * 60_000;

interface Job {
  body: ZoomJob;
  source: ZoomSource;
  signal: AbortSignal | undefined;
  resolve: (r: ZoomResponse) => void;
}

export class ZoomError extends Error {
  /** No such tile; or the client went away before it was rendered. */
  reason: 'notFound' | 'cancelled' | 'failed';
  constructor(message: string, reason: ZoomError['reason']) {
    super(message);
    this.reason = reason;
  }
}

const CANCELLED = 'Cancelled';

export class ZoomRenderer {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private running: { jobId: number; resolve: (r: ZoomResponse) => void } | null = null;
  private nextJobId = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
  }

  async levels(source: RenderSource, signal?: AbortSignal): Promise<ZoomLevels> {
    const res = await this.run({ kind: 'levels' }, source, signal);
    if (!('levels' in res)) throw new Error('Unexpected zoom response');
    return res.levels;
  }

  async tile(source: RenderSource, level: number, col: number, row: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.run({ kind: 'tile', level, col, row, quality: 90 }, source, signal);
    if (!('jpeg' in res)) throw new Error('Unexpected zoom response');
    return res.jpeg;
  }

  async stop() {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }

  private async run(body: ZoomJob, src: RenderSource, signal?: AbortSignal) {
    const source: ZoomSource = {
      sourceKey: src.sourceKey,
      params: src.params,
      autoDefaults: src.autoDefaults,
      luts: src.luts,
    };
    const res = await new Promise<ZoomResponse>((resolve) => {
      this.queue.push({ body, source, signal, resolve });
      this.pump();
    });
    if (!res.ok) {
      throw new ZoomError(res.error, res.notFound ? 'notFound' : res.error === CANCELLED ? 'cancelled' : 'failed');
    }
    return res;
  }

  private pump() {
    if (this.running) return;
    let job: Job | undefined;
    while ((job = this.queue.shift())) {
      if (!job.signal?.aborted) break;
      job.resolve({ jobId: 0, ok: false, error: CANCELLED });
    }
    clearTimeout(this.idle);
    if (!job) {
      this.idle = setTimeout(() => void this.stop(), IDLE_MS);
      return;
    }
    const jobId = this.nextJobId++;
    const done = job.resolve;
    this.running = {
      jobId,
      resolve: (r) => {
        this.running = null;
        done(r);
        this.pump();
      },
    };
    this.spawn().postMessage({ ...job.body, jobId, source: job.source } satisfies ZoomRequest);
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./zoomWorker.ts', import.meta.url));
    worker.on('message', (res: ZoomResponse) => {
      if (this.running?.jobId === res.jobId) this.running.resolve(res);
    });
    worker.on('error', (err) => {
      this.log.error({ err }, 'zoom worker crashed');
      if (this.worker === worker) this.worker = null;
      this.running?.resolve({ jobId: this.running.jobId, ok: false, error: 'Zoom worker crashed' });
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }
}
