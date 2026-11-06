import {
  EXPORT_FORMATS,
  type EditParams,
  type ExportMetadata,
  type ExportOptions,
  type PhotoMetadata,
} from '@rawtisserie/pipeline';
import type {
  IlluminantDetection,
  Overlays,
  Region,
  ToneCurveInput,
  WorkerRequest,
  WorkerResponse,
} from './protocol.ts';
import type { Frame, RenderBackend } from './renderBackend.ts';
import type { ScopeRequest } from './scopes.ts';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Renders in the browser: promise-based RPC to the pipeline worker. */
export class LocalRenderBackend implements RenderBackend {
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

  async render(
    params: EditParams,
    maxWidth: number,
    maxHeight: number,
    overlays: Overlays = {},
    full?: { width: number; height: number; region?: Region | null },
    region: Region | null = null,
    scope: ScopeRequest | null = null,
  ): Promise<Frame> {
    full ??= { width: maxWidth, height: maxHeight, region };
    const r = await this.call<Extract<WorkerResponse, { type: 'rendered' }>>({
      type: 'render',
      params,
      maxWidth,
      maxHeight,
      region,
      fullWidth: full.width,
      fullHeight: full.height,
      fullRegion: full.region ?? null,
      overlays,
      scope,
    });
    return {
      image: r.bitmap,
      fullWidth: r.fullWidth,
      fullHeight: r.fullHeight,
      placement: r.placement,
      sourceWidth: r.sourceWidth,
      sourceHeight: r.sourceHeight,
      mapping: r.mapping,
      scope: r.scope && { mode: r.scope.mode, image: r.scope.bitmap },
      ms: r.ms,
    };
  }

  async export(params: EditParams, options: ExportOptions, metadata: ExportMetadata): Promise<Blob> {
    const r = await this.call<Extract<WorkerResponse, { type: 'exported' }>>({
      type: 'export',
      params,
      options,
      metadata,
    });
    const type = EXPORT_FORMATS.find((f) => f.value === options.format)?.mimeType ?? 'application/octet-stream';
    return new Blob([r.file], { type });
  }

  async autoTuneFilmic(
    params: EditParams,
    maxWidth: number,
    maxHeight: number,
  ): Promise<{ white: number; black: number } | null> {
    const r = await this.call<Extract<WorkerResponse, { type: 'autoTunedFilmic' }>>({
      type: 'autoTuneFilmic',
      params,
      maxWidth,
      maxHeight,
    });
    return r.white === null || r.black === null ? null : { white: r.white, black: r.black };
  }

  async detectIlluminant(
    params: EditParams,
    instance: string,
    method: IlluminantDetection,
    maxWidth: number,
    maxHeight: number,
  ): Promise<[number, number] | null> {
    const r = await this.call<Extract<WorkerResponse, { type: 'detectedIlluminant' }>>({
      type: 'detectIlluminant',
      params,
      instance,
      method,
      maxWidth,
      maxHeight,
    });
    return r.xy;
  }

  async toneCurveInput(
    params: EditParams,
    instance: string,
    maxWidth: number,
    maxHeight: number,
  ): Promise<ToneCurveInput | null> {
    const r = await this.call<Extract<WorkerResponse, { type: 'toneCurveInput' }>>({
      type: 'toneCurveInput',
      params,
      instance,
      maxWidth,
      maxHeight,
    });
    return r.input;
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Pipeline disposed'));
    this.pending.clear();
  }
}
