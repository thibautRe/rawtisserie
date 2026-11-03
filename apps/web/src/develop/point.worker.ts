/// <reference lib="webworker" />
/**
 * One worker of the pipeline worker's pool (`pointPool.ts`): holds a horizontal strip
 * of the cached spatial image and runs the point operations (exposure … tone mapping)
 * on it, so that a full-size render of a colour edit is split across cores.
 */
import init, { PointRenderer } from '@rawtisserie/pipeline/wasm';
import wasmUrl from '@rawtisserie/pipeline/wasm/pipeline_bg.wasm?url';
import type { PointRequest, PointResponse } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const ready = init({ module_or_path: wasmUrl });
let renderer: PointRenderer | null = null;

const post = (msg: PointResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<PointRequest>) => {
  const msg = event.data;
  try {
    await ready;
    if (msg.type === 'strip') {
      renderer?.free();
      renderer = null;
      renderer = new PointRenderer(msg.width, msg.height, new Float32Array(msg.pixels), new Float32Array(msg.asShot));
      return;
    }
    if (!renderer) throw new Error('No strip loaded');
    const img = renderer.render(msg.params);
    const data = img.takeData();
    img.free();
    post({ type: 'rendered', id: msg.id, data: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]);
  } catch (err) {
    if (msg.type === 'render')
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    else console.error(err);
  }
};
