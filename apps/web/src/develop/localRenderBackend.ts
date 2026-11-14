import {
  EXPORT_FORMATS,
  type EditParams,
  type ExportMetadata,
  type ExportOptions,
  type PhotoMetadata,
  lutIds,
} from '@rawtisserie/pipeline';
import type {
  GuideLine,
  IlluminantDetection,
  Overlays,
  ParsedLut,
  PerspectiveCorrection,
  PerspectiveFit,
  Region,
  ToneCurveInput,
  WorkerRequest,
  WorkerResponse,
} from './protocol.ts';
import type { Frame, LutSource, RenderBackend } from './renderBackend.ts';
import { startWorker } from './startWorker.ts';
import type { ScopeRequest } from './scopes.ts';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Renders in the browser: promise-based RPC to the pipeline worker. */
export class LocalRenderBackend implements RenderBackend {
  /** The pipeline worker, once it said it's alive. */
  private worker: Promise<Worker>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private lutSource: LutSource | null = null;
  /** The LUTs sent to the worker, or being fetched for it, by id. */
  private luts = new Map<string, Promise<void>>();
  private disposed = new AbortController();

  /** Without `pool`, renders run on the pipeline worker alone (exports, several at once). */
  constructor({ pool = true }: { pool?: boolean } = {}) {
    this.worker = startWorker(
      () =>
        new Worker(new URL('./pipeline.worker.ts', import.meta.url), {
          type: 'module',
          name: pool ? 'pipeline' : 'export',
        }),
      'pipeline worker',
      this.disposed.signal,
    ).then((worker) => {
      // `startWorker` resolved: from here, every message is an answer.
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.type === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data);
      };
      worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Pipeline worker crashed'));
        this.pending.clear();
      };
      return worker;
    });
  }

  private call<T extends WorkerResponse>(msg: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []) {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: WorkerResponse) => void, reject });
      this.worker.then(
        (worker) => worker.postMessage({ ...msg, id }, transfer),
        (err: Error) => {
          this.pending.delete(id);
          reject(err);
        },
      );
    });
  }

  setLutSource(source: LutSource) {
    this.lutSource = source;
  }

  async parseLut(bytes: ArrayBuffer): Promise<ParsedLut> {
    const r = await this.call<Extract<WorkerResponse, { type: 'parsedLut' }>>({ type: 'parseLut', bytes }, [bytes]);
    return { lutId: r.lutId, size: r.size, bitDepth: r.bitDepth, packed: r.packed };
  }

  /**
   * Send the worker the LUTs `params` uses that it doesn't have yet. One that can't be
   * had is skipped (and asked for again next time).
   */
  private sendLuts(params: EditParams): Promise<unknown> {
    const source = this.lutSource;
    if (!source) return Promise.resolve();
    return Promise.all(
      lutIds(params).map((lutId) => {
        let sent = this.luts.get(lutId);
        if (!sent) {
          sent = source(lutId).then(async (bytes) => {
            if (!bytes) throw new Error(`LUT ${lutId} unavailable`);
            // A copy: the source keeps its own.
            const copy = bytes.slice(0);
            await this.call({ type: 'lut', lutId, bytes: copy }, [copy]);
          });
          sent.catch(() => this.luts.delete(lutId));
          this.luts.set(lutId, sent);
        }
        return sent.catch(() => {});
      }),
    );
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
    await this.sendLuts(params);
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

  async thumbnail(params: EditParams, maxWidth: number, maxHeight: number): Promise<ImageBitmap> {
    await this.sendLuts(params);
    const r = await this.call<Extract<WorkerResponse, { type: 'thumbnail' }>>({
      type: 'thumbnail',
      params,
      maxWidth,
      maxHeight,
    });
    return r.bitmap;
  }

  async export(params: EditParams, options: ExportOptions, metadata: ExportMetadata): Promise<Blob> {
    await this.sendLuts(params);
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

  async detectLines(params: EditParams, maxWidth: number, maxHeight: number): Promise<GuideLine[]> {
    const r = await this.call<Extract<WorkerResponse, { type: 'detectedLines' }>>({
      type: 'detectLines',
      params,
      maxWidth,
      maxHeight,
    });
    return r.lines;
  }

  async fitPerspective(
    params: EditParams,
    lines: GuideLine[],
    mode: PerspectiveFit,
  ): Promise<PerspectiveCorrection | null> {
    const r = await this.call<Extract<WorkerResponse, { type: 'fittedPerspective' }>>({
      type: 'fitPerspective',
      params,
      lines,
      mode,
    });
    return r.fit;
  }

  dispose() {
    // Ends the worker if it's still starting.
    this.disposed.abort();
    this.worker.then(
      (w) => w.terminate(),
      () => {},
    );
    for (const p of this.pending.values()) p.reject(new Error('Pipeline disposed'));
    this.pending.clear();
  }
}
