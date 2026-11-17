/// <reference lib="webworker" />
/**
 * One worker of the pipeline worker's denoise pool (`denoisePool.ts`): holds a raw
 * denoise model (`DenoiseRunner`) and denoises the tiles it's sent, one at a time.
 */
import init, { DenoiseRunner } from '@rawtisserie/pipeline/wasm';
import type { DenoiseRequest, DenoiseResponse } from './protocol.ts';
import { announceAlive } from './startWorker.ts';

declare const self: DedicatedWorkerGlobalScope;

let started: (instance: Promise<unknown>) => void;
const ready = new Promise<unknown>((resolve) => (started = resolve));
/** The model loaded, and its id. */
let runner: { id: string; runner: DenoiseRunner } | null = null;

const post = (msg: DenoiseResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<DenoiseRequest>) => {
  const msg = event.data;
  if (msg.type === 'init') return started(init({ module_or_path: msg.module }));
  try {
    await ready;
    if (msg.type === 'model') {
      runner?.runner.free();
      runner = null;
      runner = { id: msg.model, runner: new DenoiseRunner(new Uint8Array(msg.bytes)) };
      return;
    }
    if (runner?.id !== msg.model) throw new Error(`Model ${msg.model} not loaded`);
    const out = runner.runner.run(
      new Uint32Array(msg.core),
      msg.size,
      msg.xtrans,
      new Float32Array(msg.noise),
      new Float32Array(msg.planes),
    );
    post({ type: 'denoised', id: msg.id, values: out.buffer as ArrayBuffer }, [out.buffer as ArrayBuffer]);
  } catch (err) {
    if (msg.type === 'run')
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    else console.error(err);
  }
};

announceAlive();
