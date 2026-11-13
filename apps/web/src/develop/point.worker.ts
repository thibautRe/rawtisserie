/// <reference lib="webworker" />
/**
 * One worker of the pipeline worker's pool (`pointPool.ts`): holds a horizontal strip
 * of the cached spatial image and runs the point operations (exposure … tone mapping)
 * on it, so that a full-size render of a colour edit is split across cores. Also
 * diffuses one channel of a diffuse step at a time (see `PointPool.diffuse`).
 */
import init, { PointRenderer, diffusePlane } from '@rawtisserie/pipeline/wasm';
import type { PointRequest, PointResponse } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

/** Instantiated from the module the pipeline worker compiled (its first message). */
let started: (instance: Promise<unknown>) => void;
const ready = new Promise<unknown>((resolve) => (started = resolve));
let renderer: PointRenderer | null = null;
/** The LUTs loaded, packed: for the renderer, once there is one. */
const luts = new Map<string, Uint8Array>();

const post = (msg: PointResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<PointRequest>) => {
  const msg = event.data;
  if (msg.type === 'init') return started(init({ module_or_path: msg.module }));
  try {
    await ready;
    if (msg.type === 'strip') {
      const args = [
        msg.width,
        msg.height,
        new Float32Array(msg.pixels),
        new Float32Array(msg.asShot),
        msg.maskIds,
        new Float32Array(msg.masks),
      ] as const;
      // The renderer stays, with its LUTs and compiled stages; only its pixels change.
      if (renderer) renderer.setStrip(...args);
      else {
        renderer = new PointRenderer(...args);
        for (const bytes of luts.values()) renderer.loadLut(bytes);
      }
      return;
    }
    if (msg.type === 'lut') {
      const bytes = new Uint8Array(msg.bytes);
      luts.set(msg.lutId, bytes);
      renderer?.loadLut(bytes);
      return;
    }
    if (msg.type === 'unloadLut') {
      luts.delete(msg.lutId);
      renderer?.unloadLut(msg.lutId);
      return;
    }
    if (msg.type === 'diffuse') {
      const mask = msg.mask ? new Uint8Array(msg.mask) : undefined;
      const plane = diffusePlane(msg.params, msg.scale, msg.width, msg.height, new Float32Array(msg.plane), mask);
      post({ type: 'rendered', id: msg.id, data: plane.buffer as ArrayBuffer }, [plane.buffer as ArrayBuffer]);
      return;
    }
    if (!renderer) throw new Error('No strip loaded');
    const img = renderer.render(msg.params);
    const data = img.takeData();
    img.free();
    post({ type: 'rendered', id: msg.id, data: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]);
  } catch (err) {
    if (msg.type === 'render' || msg.type === 'diffuse')
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    else console.error(err);
  }
};
