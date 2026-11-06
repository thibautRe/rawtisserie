/// <reference lib="webworker" />
/**
 * Runs the WebAssembly pixel pipeline off the main thread. Holds at most one
 * decoded RAW file; the pipeline caches its demosaiced base image between renders.
 * When only the point operations need to run (colour edits), they are split across
 * a pool of workers, at full size even while dragging.
 */
import type { EditParams, SensorMapping } from '@rawtisserie/pipeline';
import init, { Developer } from '@rawtisserie/pipeline/wasm';
import wasmUrl from '@rawtisserie/pipeline/wasm/pipeline_bg.wasm?url';
import { PointPool } from './pointPool.ts';
import type { Overlays, Placement, Region, WorkerRequest, WorkerResponse } from './protocol.ts';
import { computeScope } from './scopes.ts';

declare const self: DedicatedWorkerGlobalScope;

const ready = init({ module_or_path: wasmUrl });
let developer: Developer | null = null;
const pool = PointPool.create();

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

/** RGBA8 pixels as an image the page can show without copying them on its thread. */
const toBitmap = (data: Uint8Array, width: number, height: number) =>
  createImageBitmap(
    new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.length), width, height),
  );

/** A region as the wasm module takes it. */
const regionArg = (r: Region | null) => (r ? new Uint32Array([r.x, r.y, r.width, r.height]) : undefined);

/** The last sensor mapping, by the lens and geometry instances it comes from. */
let mapping: { key: string; value: SensorMapping } | null = null;
function sensorMapping(dev: Developer, params: EditParams, json: string): SensorMapping {
  const key = JSON.stringify(params.modules.filter((m) => m.kind === 'lens' || m.kind === 'geometry'));
  if (mapping?.key !== key) mapping = { key, value: JSON.parse(dev.sensorMapping(json)) as SensorMapping };
  return mapping.value;
}

// One message at a time: pool renders await their workers, and nothing else may touch
// the developer meanwhile.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(event.data));
};

async function handle(msg: WorkerRequest) {
  const started = performance.now();
  try {
    await ready;
    if (msg.type === 'load') {
      developer?.free();
      developer = null;
      developer = new Developer(new Uint8Array(msg.bytes));
      mapping = null;
      pool?.invalidate();
      post({ type: 'loaded', id: msg.id, metadata: JSON.parse(developer.metadata()), ms: performance.now() - started });
      return;
    }
    if (!developer) throw new Error('No RAW file loaded');
    const params = JSON.stringify(msg.params);
    if (msg.type === 'render') {
      const isDraft = msg.fullWidth !== msg.maxWidth || msg.fullHeight !== msg.maxHeight;
      const full = { width: msg.fullWidth, height: msg.fullHeight, region: regionArg(msg.fullRegion) };
      // Where the full-size render sits, which a draft stands in for.
      const [frameWidth, frameHeight] = developer.outputSize(params, full.width, full.height);
      const [x, y, fullWidth, fullHeight] = developer.outputRegion(params, full.width, full.height, full.region);
      const placement: Placement = {
        x: x!,
        y: y!,
        width: fullWidth!,
        height: fullHeight!,
        frameWidth: frameWidth!,
        frameHeight: frameHeight!,
      };
      const [sourceWidth, sourceHeight] = developer.outputSize(params, 0, 0);
      const sensor = sensorMapping(developer, msg.params, params);
      // The scope shows the image, without the clipping indicators: drawn before them.
      const drawScope = (data: Uint8Array, width: number, height: number) => {
        const req = msg.scope;
        if (!req || req.width < 1 || req.height < 1) return null;
        const pixels = computeScope(data, width, height, req);
        return { mode: req.mode, image: createImageBitmap(new ImageData(pixels, req.width, req.height)) };
      };
      const rendered = async (data: Uint8Array, width: number, height: number, scope: ReturnType<typeof drawScope>) => {
        const bitmap = await toBitmap(data, width, height);
        const scopeBitmap = scope && (await scope.image);
        post(
          {
            type: 'rendered',
            id: msg.id,
            width,
            height,
            fullWidth: fullWidth!,
            fullHeight: fullHeight!,
            placement,
            sourceWidth: sourceWidth!,
            sourceHeight: sourceHeight!,
            mapping: sensor,
            bitmap,
            scope: scope && { mode: scope.mode, bitmap: scopeBitmap! },
            ms: performance.now() - started,
          },
          scopeBitmap ? [bitmap, scopeBitmap] : [bitmap],
        );
      };
      // A draft stands in for a full-size render while dragging. If only the point
      // operations need to run, the pool renders full size about as fast: do that.
      const upgrade = isDraft && !!pool && developer.isSpatialCached(params, full.width, full.height, full.region);
      if (pool && (!isDraft || upgrade)) {
        const { width, height, data } = await pool.render(developer, params, full.width, full.height, full.region);
        let overlays: Overlays = msg.overlays;
        if (upgrade && overlays.stripes) {
          // Stripe widths were scaled for the draft.
          const [draftWidth] = developer.outputSize(params, msg.maxWidth, msg.maxHeight);
          overlays = { ...overlays, stripes: (overlays.stripes * frameWidth!) / draftWidth! };
        }
        const scope = drawScope(data, width, height);
        if (overlays.display || overlays.sensor || overlays.mask || overlays.toneCurve) {
          const json = JSON.stringify(overlays);
          developer.paintOverlays(params, full.width, full.height, data, width, height, json, full.region);
        }
        await rendered(data, width, height, scope);
        return;
      }
      const region = regionArg(msg.region);
      const painted = !!(msg.overlays.display || msg.overlays.sensor || msg.overlays.mask || msg.overlays.toneCurve);
      // With a scope, the overlays are painted after it is drawn (as `render` would).
      const split = painted && !!msg.scope;
      const overlays = split ? '{}' : JSON.stringify(msg.overlays);
      const img = developer.render(params, msg.maxWidth, msg.maxHeight, overlays, region);
      const { width, height } = img;
      const data = img.takeData();
      img.free();
      const scope = drawScope(data, width, height);
      if (split) {
        const json = JSON.stringify(msg.overlays);
        developer.paintOverlays(params, msg.maxWidth, msg.maxHeight, data, width, height, json, region);
      }
      await rendered(data, width, height, scope);
    } else if (msg.type === 'autoTuneFilmic') {
      const [white, black] = developer.autoTuneFilmic(params, msg.maxWidth, msg.maxHeight);
      post({
        type: 'autoTunedFilmic',
        id: msg.id,
        white: white ?? null,
        black: black ?? null,
        ms: performance.now() - started,
      });
    } else if (msg.type === 'detectIlluminant') {
      const [x, y] = developer.detectIlluminant(params, msg.instance, msg.maxWidth, msg.maxHeight, msg.method);
      const xy: [number, number] | null = x === undefined || y === undefined ? null : [x, y];
      post({ type: 'detectedIlluminant', id: msg.id, xy, ms: performance.now() - started });
    } else if (msg.type === 'toneCurveInput') {
      const r = developer.toneCurveInput(params, msg.instance, msg.maxWidth, msg.maxHeight);
      // [fitLow, fitHigh, count, ...count histograms one after the other]
      const count = r[2] ?? 0;
      const size = count ? (r.length - 3) / count : 0;
      const bins = Array.from({ length: count }, (_, k) => Array.from(r.subarray(3 + k * size, 3 + (k + 1) * size)));
      const input = count ? { fit: [r[0]!, r[1]!] as [number, number], bins } : null;
      post({ type: 'toneCurveInput', id: msg.id, input, ms: performance.now() - started });
    } else if (msg.type === 'export') {
      const jpeg = developer.renderJpeg(params, msg.maxSize, msg.maxSize, msg.quality);
      // Full-resolution renders are large: drop the cache so the next preview rebuilds a small one.
      developer.releaseCache();
      post({ type: 'exported', id: msg.id, jpeg: jpeg.buffer as ArrayBuffer, ms: performance.now() - started }, [
        jpeg.buffer as ArrayBuffer,
      ]);
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
}
