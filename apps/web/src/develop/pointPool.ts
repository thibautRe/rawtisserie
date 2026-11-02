/**
 * Splits the point operations of a render across a pool of workers (`point.worker.ts`),
 * from inside the pipeline worker. Each worker holds a horizontal strip of the
 * developer's cached spatial image (re-sent only when that image changes), so a colour
 * edit costs one message with the recipe per worker, and the strips render in parallel.
 *
 * No shared memory: every worker runs its own instance of the wasm module, which needs
 * neither cross-origin isolation nor a threaded build.
 */
import type { Developer } from '@rawtisserie/pipeline/wasm';
import type { PointRequest, PointResponse } from './protocol.ts';

/**
 * Busy workers slow the page down: with 8 on an 8-core/16-thread laptop, the main
 * thread's tasks took ~40 % longer (shared cores, lower turbo clocks) and the slider
 * drags went over their budget. 4 kept it within, for ~25 % fewer frames per second.
 */
const MAX_WORKERS = 4;

type Pending = { resolve: (data: ArrayBuffer) => void; reject: (e: Error) => void };

export class PointPool {
  private workers: Worker[];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Which spatial image the workers hold (`Developer.spatialInfo`), and its split. */
  private spatialId = -1;
  private strips: [number, number][] = [];

  /** A pool sized for this machine, or null when there aren't enough cores to share. */
  static create(): PointPool | null {
    // `hardwareConcurrency` counts hardware threads: use about half the cores.
    const n = Math.min(MAX_WORKERS, Math.floor((navigator.hardwareConcurrency || 1) / 2) - 1);
    return n >= 2 ? new PointPool(n) : null;
  }

  private constructor(n: number) {
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./point.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<PointResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.type === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data.data);
      };
      w.onerror = (e) => this.fail(new Error(e.message || 'Point worker crashed'));
      return w;
    });
  }

  /** Forget the strips the workers hold (e.g. another photo was loaded: its ids start over). */
  invalidate() {
    this.spatialId = -1;
  }

  /** Interactive render of `params` (JSON) within `maxWidth × maxHeight`, to RGBA8. */
  async render(dev: Developer, params: string, maxWidth: number, maxHeight: number) {
    const [id, width, height] = dev.spatialInfo(params, maxWidth, maxHeight) as unknown as [number, number, number];
    if (id !== this.spatialId) this.upload(dev, params, maxWidth, maxHeight, width, height, id);
    const parts = await Promise.all(this.strips.map((_, i) => this.call(i, params)));
    const data = new Uint8Array(width * height * 4);
    let offset = 0;
    for (const part of parts) {
      data.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return { width, height, data };
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.fail(new Error('Point pool disposed'));
  }

  private upload(dev: Developer, params: string, maxWidth: number, maxHeight: number, width: number, height: number, id: number) {
    const rows = Math.ceil(height / this.workers.length);
    this.strips = [];
    for (let y0 = 0; y0 < height; y0 += rows) this.strips.push([y0, Math.min(height, y0 + rows)]);
    const asShot = Array.from(dev.asShotIlluminant());
    this.strips.forEach(([y0, y1], i) => {
      const pixels = dev.spatialRows(params, maxWidth, maxHeight, y0, y1).buffer as ArrayBuffer;
      this.post(i, { type: 'strip', width, height: y1 - y0, pixels, asShot }, [pixels]);
    });
    this.spatialId = id;
  }

  private call(worker: number, params: string) {
    const id = this.nextId++;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post(worker, { type: 'render', id, params });
    });
  }

  private post(worker: number, msg: PointRequest, transfer: Transferable[] = []) {
    this.workers[worker]!.postMessage(msg, transfer);
  }

  private fail(err: Error) {
    // A worker may have lost its strip: send them all again next time.
    this.spatialId = -1;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
