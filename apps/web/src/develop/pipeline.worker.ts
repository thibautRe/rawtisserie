/// <reference lib="webworker" />
/**
 * Runs the WebAssembly pixel pipeline off the main thread. Holds at most one
 * decoded RAW file; the pipeline caches its demosaiced base image between renders.
 * When only the point operations need to run (colour edits), they are split across
 * a pool of workers, at full size even while dragging.
 */
import init, { Developer } from '@rawtisserie/pipeline/wasm';
import wasmUrl from '@rawtisserie/pipeline/wasm/pipeline_bg.wasm?url';
import { PointPool } from './pointPool.ts';
import type { Overlays, WorkerRequest, WorkerResponse } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const ready = init({ module_or_path: wasmUrl });
let developer: Developer | null = null;
const pool = PointPool.create();

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

/** RGBA8 pixels as an image the page can show without copying them on its thread. */
const toBitmap = (data: Uint8Array, width: number, height: number) =>
  createImageBitmap(new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.length), width, height));

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
      pool?.invalidate();
      post({ type: 'loaded', id: msg.id, metadata: JSON.parse(developer.metadata()), ms: performance.now() - started });
      return;
    }
    if (!developer) throw new Error('No RAW file loaded');
    const params = JSON.stringify(msg.params);
    if (msg.type === 'render') {
      const isDraft = msg.fullWidth !== msg.maxWidth || msg.fullHeight !== msg.maxHeight;
      // A draft stands in for a full-size render while dragging. If only the point
      // operations need to run, the pool renders full size about as fast: do that.
      const upgrade = isDraft && !!pool && developer.isSpatialCached(params, msg.fullWidth, msg.fullHeight);
      if (pool && (!isDraft || upgrade)) {
        const { width, height, data } = await pool.render(developer, params, msg.fullWidth, msg.fullHeight);
        let overlays: Overlays = msg.overlays;
        if (upgrade && overlays.stripes) {
          // Stripe widths were scaled for the draft.
          const [draftWidth] = developer.outputSize(params, msg.maxWidth, msg.maxHeight);
          overlays = { ...overlays, stripes: (overlays.stripes * width) / draftWidth! };
        }
        if (overlays.display || overlays.sensor) {
          developer.paintOverlays(params, msg.fullWidth, msg.fullHeight, data, width, height, JSON.stringify(overlays));
        }
        const bitmap = await toBitmap(data, width, height);
        post({ type: 'rendered', id: msg.id, width, height, fullWidth: width, fullHeight: height, bitmap, ms: performance.now() - started }, [bitmap]);
        return;
      }
      const img = developer.render(params, msg.maxWidth, msg.maxHeight, JSON.stringify(msg.overlays));
      const { width, height } = img;
      const data = img.takeData();
      img.free();
      const [fullWidth, fullHeight] = isDraft ? developer.outputSize(params, msg.fullWidth, msg.fullHeight) : [width, height];
      const bitmap = await toBitmap(data, width, height);
      post({ type: 'rendered', id: msg.id, width, height, fullWidth: fullWidth!, fullHeight: fullHeight!, bitmap, ms: performance.now() - started }, [bitmap]);
    } else if (msg.type === 'autoTuneFilmic') {
      const [white, black] = developer.autoTuneFilmic(params, msg.maxWidth, msg.maxHeight);
      post({ type: 'autoTunedFilmic', id: msg.id, white: white ?? null, black: black ?? null, ms: performance.now() - started });
    } else if (msg.type === 'detectIlluminant') {
      const [x, y] = developer.detectIlluminant(params, msg.instance, msg.maxWidth, msg.maxHeight, msg.method);
      const xy: [number, number] | null = x === undefined || y === undefined ? null : [x, y];
      post({ type: 'detectedIlluminant', id: msg.id, xy, ms: performance.now() - started });
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
