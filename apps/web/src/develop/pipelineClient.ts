import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';
import type { Overlays, WorkerRequest, WorkerResponse } from './protocol.ts';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface Frame {
  image: ImageData;
  /** Size of the full-size render, in device pixels; drafts are stretched to it. */
  fullWidth: number;
  fullHeight: number;
  ms: number;
}

/** Promise-based RPC to the pipeline worker. */
export class PipelineClient {
  private worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.type === 'error') p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Pipeline worker crashed'));
      this.pending.clear();
    };
  }

  private call<T extends WorkerResponse>(msg: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []) {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: WorkerResponse) => void, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Decode a RAW file. The buffer is transferred (and becomes unusable here). */
  async load(bytes: ArrayBuffer): Promise<PhotoMetadata> {
    const r = await this.call<Extract<WorkerResponse, { type: 'loaded' }>>({ type: 'load', bytes }, [bytes]);
    return r.metadata;
  }

  /** Render within `maxWidth × maxHeight`, as a draft of the render within `full` if given. */
  async render(
    params: EditParams,
    maxWidth: number,
    maxHeight: number,
    overlays: Overlays = {},
    full = { width: maxWidth, height: maxHeight },
  ): Promise<Frame> {
    const r = await this.call<Extract<WorkerResponse, { type: 'rendered' }>>({
      type: 'render',
      params,
      maxWidth,
      maxHeight,
      fullWidth: full.width,
      fullHeight: full.height,
      overlays,
    });
    return {
      image: new ImageData(new Uint8ClampedArray(r.data), r.width, r.height),
      fullWidth: r.fullWidth,
      fullHeight: r.fullHeight,
      ms: r.ms,
    };
  }

  async exportJpeg(params: EditParams, maxSize: number, quality = 92): Promise<Blob> {
    const r = await this.call<Extract<WorkerResponse, { type: 'exported' }>>({ type: 'export', params, maxSize, quality });
    return new Blob([r.jpeg], { type: 'image/jpeg' });
  }

  /** Filmic white/black relative exposures measured on the image, or null. */
  async autoTuneFilmic(params: EditParams, maxWidth: number, maxHeight: number): Promise<{ white: number; black: number } | null> {
    const r = await this.call<Extract<WorkerResponse, { type: 'autoTunedFilmic' }>>({
      type: 'autoTuneFilmic',
      params,
      maxWidth,
      maxHeight,
    });
    return r.white === null || r.black === null ? null : { white: r.white, black: r.black };
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Pipeline disposed'));
    this.pending.clear();
  }
}
