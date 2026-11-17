/**
 * Raw denoise tiles (roadmap 3.5) run on workers of their own (`denoise.worker.ts`),
 * started when a recipe needs them and ended when there's nothing left to do, so their
 * memory (a model, and a few hundred MB of scratch per tile) goes with them. Not the
 * render pool's: a tile takes seconds, and colour drags would wait behind it.
 */
import type { DenoiseTile } from '@rawtisserie/pipeline/wasm';
import type { DenoiseRequest, DenoiseResponse } from './protocol.ts';
import { startWorker } from './startWorker.ts';

/** As many as the render pool at most (`pointPool.ts`), for the same reason. */
const MAX_WORKERS = 4;
/** Workers end this long after their last tile. */
const IDLE_MS = 20_000;

interface Slot {
  worker: Worker;
  model: string | null;
  busy: boolean;
}

export interface TileResult {
  key: bigint;
  core: Uint32Array;
  /** Null if it failed (the developer hands the tile out again). */
  values: Float32Array | null;
}

export class DenoisePool {
  private slots: Promise<Slot>[] = [];
  private pending = new Map<number, { resolve: (v: ArrayBuffer) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly size: number;
  private wasm: Promise<WebAssembly.Module>;

  constructor(wasm: Promise<WebAssembly.Module>) {
    this.wasm = wasm;
    this.size = Math.max(1, Math.min(MAX_WORKERS, Math.floor((navigator.hardwareConcurrency || 2) / 2) - 1));
  }

  /**
   * Denoises `tile` with `model` (its bytes, sent to a worker that doesn't have it), on a
   * free worker. Resolves with the result, or a failure (never rejects).
   */
  async run(tile: DenoiseTile, model: string, bytes: Uint8Array): Promise<TileResult> {
    const core = new Uint32Array(tile.core);
    const key = tile.key;
    const msg = {
      type: 'run' as const,
      model,
      core: Array.from(core),
      size: tile.size,
      xtrans: tile.xtrans,
      noise: Array.from(tile.noise),
      planes: tile.takePlanes().buffer as ArrayBuffer,
    };
    tile.free();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let slot: Slot | null = null;
    try {
      slot = await this.take();
      if (slot.model !== model) {
        const copy = bytes.slice().buffer;
        slot.worker.postMessage({ type: 'model', model, bytes: copy } satisfies DenoiseRequest, [copy]);
        slot.model = model;
      }
      const values = await this.request(slot.worker, msg);
      return { key, core, values: new Float32Array(values) };
    } catch (err) {
      console.warn('Denoising a tile failed', err);
      return { key, core, values: null };
    } finally {
      if (slot) slot.busy = false;
      this.scheduleIdle();
    }
  }

  dispose() {
    void this.end();
  }

  /** A free worker, started if there's room for one (callers keep at most `size` tiles going). */
  private async take(): Promise<Slot> {
    for (;;) {
      const slots = await Promise.all(this.slots);
      const free = slots.find((s) => !s.busy);
      if (free) {
        free.busy = true;
        return free;
      }
      if (this.slots.length < this.size) {
        const slot = this.start();
        this.slots.push(slot);
        const s = await slot;
        s.busy = true;
        return s;
      }
      // All busy: try again once one answers.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async start(): Promise<Slot> {
    const module = await this.wasm;
    const worker = await startWorker(
      () => new Worker(new URL('./denoise.worker.ts', import.meta.url), { type: 'module' }),
      'denoise worker',
    );
    worker.onmessage = (e: MessageEvent<DenoiseResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.type === 'error') p.reject(new Error(e.data.message));
      else p.resolve(e.data.values);
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'Denoise worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      // Its memory may be what failed: start afresh next time.
      void this.end();
    };
    worker.postMessage({ type: 'init', module } satisfies DenoiseRequest);
    return { worker, model: null, busy: false };
  }

  private request(worker: Worker, msg: Omit<Extract<DenoiseRequest, { type: 'run' }>, 'id'>) {
    const id = this.nextId++;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id } satisfies DenoiseRequest, [msg.planes]);
    });
  }

  private scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void Promise.all(this.slots).then((slots) => {
        if (slots.every((s) => !s.busy)) void this.end();
      });
    }, IDLE_MS);
  }

  private async end() {
    const slots = await Promise.all(this.slots.map((s) => s.catch(() => null)));
    this.slots = [];
    for (const s of slots) s?.worker.terminate();
  }
}
