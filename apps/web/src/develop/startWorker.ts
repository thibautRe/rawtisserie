/**
 * Starting a worker, checked: it says it's alive (`announceAlive`, once its module has
 * loaded) within `ALIVE_MS`, or it's ended and started again. Firefox sometimes starts a
 * worker from an empty script (a broken cache entry, after several workers asked for the
 * same script at once): such a worker never answers, and whatever waits on it hangs.
 */

/** Long enough for a dev server to transform a worker's modules the first time. */
const ALIVE_MS = 10_000;
const TRIES = 3;
const ALIVE = 'worker-alive';

/** In the worker, last thing in its module: it's ready for messages. */
export function announceAlive() {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: ALIVE });
}

/**
 * A worker made by `create` that said it's alive (made again, a few times, until one
 * does). `signal` gives up: the worker being started is ended.
 */
export async function startWorker(create: () => Worker, what: string, signal?: AbortSignal): Promise<Worker> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    const worker = create();
    const alive = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ALIVE_MS);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(false);
      });
      worker.onmessage = (e) => {
        if ((e.data as { type?: string })?.type !== ALIVE) return;
        clearTimeout(timer);
        resolve(true);
      };
      worker.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
    worker.onmessage = worker.onerror = null;
    if (alive) return worker;
    worker.terminate();
    signal?.throwIfAborted();
    if (attempt >= TRIES) throw new Error(`The ${what} didn’t start`);
    console.warn(`The ${what} didn’t start: starting it again`);
  }
}
