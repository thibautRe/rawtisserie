/// <reference lib="webworker" />
/**
 * Runs the WebAssembly pixel pipeline off the main thread. Holds at most one
 * decoded RAW file; the pipeline caches its demosaiced base image between renders.
 */
import init, { Developer } from '@rawtisserie/pipeline/wasm';
import wasmUrl from '@rawtisserie/pipeline/wasm/pipeline_bg.wasm?url';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const ready = init({ module_or_path: wasmUrl });
let developer: Developer | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  const started = performance.now();
  try {
    await ready;
    if (msg.type === 'load') {
      developer?.free();
      developer = null;
      developer = new Developer(new Uint8Array(msg.bytes));
      post({ type: 'loaded', id: msg.id, metadata: JSON.parse(developer.metadata()), ms: performance.now() - started });
      return;
    }
    if (!developer) throw new Error('No RAW file loaded');
    const params = JSON.stringify(msg.params);
    if (msg.type === 'render') {
      const img = developer.render(params, msg.maxWidth, msg.maxHeight, JSON.stringify(msg.overlays));
      const { width, height } = img;
      const data = img.takeData();
      img.free();
      const isDraft = msg.fullWidth !== msg.maxWidth || msg.fullHeight !== msg.maxHeight;
      const [fullWidth, fullHeight] = isDraft ? developer.outputSize(params, msg.fullWidth, msg.fullHeight) : [width, height];
      post(
        {
          type: 'rendered',
          id: msg.id,
          width,
          height,
          fullWidth: fullWidth!,
          fullHeight: fullHeight!,
          data: data.buffer as ArrayBuffer,
          ms: performance.now() - started,
        },
        [data.buffer as ArrayBuffer],
      );
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
};
