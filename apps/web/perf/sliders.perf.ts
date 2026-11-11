/**
 * How the developer feels while dragging a slider, measured in a real browser on the
 * production build of the public `/develop` page.
 *
 *   npm run test:perf -w @rawtisserie/web
 *
 * Reports, per scenario: UI frame intervals, how busy the main thread is, the time from
 * a pointer event to the slider showing it, and how often and how fast the image
 * updates. Fails when a budget is exceeded. Scenarios run in order on one photo and each
 * leaves its edit on, so later ones render more modules. PERF_RAW picks the file
 * (default: the golden Sony ARW, see scripts/fetch-golden-raws.sh), PERF_CPU_THROTTLE
 * slows the CPU down (default 1; budgets then don't apply), PERF_JSON writes the results
 * to a file, PERF_NO_BUDGETS only reports.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type CDPSession, type Page, chromium } from 'playwright';
import { build, preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const raw =
  process.env.PERF_RAW ??
  fileURLToPath(new URL('../../../crates/pipeline/tests/golden/raws/sony-ilce-7m3.arw', import.meta.url));
const throttle = Number(process.env.PERF_CPU_THROTTLE ?? 1);
const DRAG_MS = 4000;
/** How often the mouse reports a position; the browser coalesces these per frame. */
const MOUSE_INTERVAL_MS = 8;

interface Scenario {
  name: string;
  /** Matches the start of the slider's text. */
  slider: RegExp;
  /** Image updates per second, which depend on the machine: set low enough to only catch regressions. */
  minImageFps: number;
}

/** The UI must stay smooth whatever the image is doing. */
const BUDGET = { minUiFps: 55, maxFrameP95: 25, maxInputP95: 40, maxMainBusy: 50 };

const SCENARIOS: Scenario[] = [
  { name: 'exposure (point pass)', slider: /^Exposure/, minImageFps: 15 },
  { name: 'filmic contrast (LUT rebuild)', slider: /^Contrast/, minImageFps: 10 },
  { name: 'primaries hue (3D table)', slider: /^Hue[^ ]/, minImageFps: 7 },
  { name: 'glow softness (spatial)', slider: /^Threshold softness/, minImageFps: 8 },
  { name: 'equalizer mix (spatial)', slider: /^Mix/, minImageFps: 8 },
  { name: 'straighten (geometry)', slider: /^Straighten/, minImageFps: 4 },
];

/** Runs in the page before any app code, so the app itself needs no instrumentation. */
function instrument() {
  const log = {
    frames: [] as number[],
    longTasks: [] as number[],
    inputLatency: [] as number[],
    renders: [] as { rtt: number; workerMs: number; width: number; height: number }[],
    paints: 0,
  };
  (window as unknown as { __perf: typeof log }).__perf = log;

  const frame = (t: number) => {
    log.frames.push(t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) log.longTasks.push(e.duration);
  }).observe({ type: 'longtask', buffered: false });

  // Worker round trips.
  const NativeWorker = window.Worker;
  const sent = new Map<number, number>();
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (e: MessageEvent) => {
        if (e.data?.type !== 'rendered') return;
        const t0 = sent.get(e.data.id);
        if (t0 !== undefined)
          log.renders.push({
            rtt: performance.now() - t0,
            workerMs: e.data.ms,
            width: e.data.width,
            height: e.data.height,
          });
        sent.delete(e.data.id);
      });
    }
    override postMessage(message: unknown, options?: unknown) {
      const m = message as { type?: string; id: number };
      if (m?.type === 'render') sent.set(m.id, performance.now());
      super.postMessage(message, options as Transferable[]);
    }
  };

  // Image updates reaching the canvas (not the scope's, which follows each of them).
  const count = <T extends object>(proto: T, name: keyof T) => {
    const original = proto[name] as (...args: unknown[]) => unknown;
    (proto[name] as unknown) = function (this: { canvas?: unknown }, ...args: unknown[]) {
      if (!(this.canvas instanceof HTMLCanvasElement && 'scopeView' in this.canvas.dataset)) log.paints++;
      return original.apply(this, args);
    };
  };
  count(CanvasRenderingContext2D.prototype, 'putImageData');
  count(CanvasRenderingContext2D.prototype, 'drawImage');
  count(ImageBitmapRenderingContext.prototype, 'transferFromImageBitmap');

  // Pointer event → the slider's DOM shows the new value, up to the next frame.
  let pending: number | null = null;
  window.addEventListener('pointermove', (e) => (pending ??= e.timeStamp), { capture: true, passive: true });
  new MutationObserver(() => {
    const start = pending;
    if (start === null) return;
    pending = null;
    requestAnimationFrame(() => log.inputLatency.push(performance.now() - start));
  }).observe(document, { subtree: true, characterData: true, childList: true, attributeFilter: ['style'] });
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const round = (v: number) => Math.round(v * 10) / 10;

/** Main-thread task time so far, in ms. */
async function taskTime(cdp: CDPSession) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m: { name: string }) => m.name === 'TaskDuration')!.value * 1000;
}

async function drag(page: Page, cdp: CDPSession, scenario: Scenario) {
  const slider = page.locator('[data-scope="slider"][data-part="root"]').filter({ hasText: scenario.slider }).first();
  await slider.scrollIntoViewIfNeeded();
  const control = slider.locator('[data-part="control"]');
  const box = (await control.boundingBox())!;
  const y = box.y + box.height / 2;
  const at = (x: number) => box.x + box.width * (0.25 + 0.5 * x);

  await page.mouse.move(at(0), y);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const p = (window as never as { __perf: Record<string, unknown[] | number> }).__perf;
    p.frames = [];
    p.longTasks = [];
    p.inputLatency = [];
    p.renders = [];
    p.paints = 0;
  });

  const busyBefore = await taskTime(cdp);
  // Fire on a fixed schedule without waiting for the page, as a real mouse does.
  const started = performance.now();
  const sends: Promise<void>[] = [];
  for (;;) {
    const t = performance.now() - started;
    if (t >= DRAG_MS) break;
    const phase = (t / DRAG_MS) * 4; // two sweeps there and back
    const x = Math.abs(((phase + 1) % 2) - 1);
    sends.push(page.mouse.move(at(1 - x), y));
    await new Promise((r) => setTimeout(r, MOUSE_INTERVAL_MS));
  }
  await Promise.all(sends);
  const busy = (await taskTime(cdp)) - busyBefore;
  const elapsed = performance.now() - started;

  const log = (await page.evaluate(() => (window as never as { __perf: unknown }).__perf)) as {
    frames: number[];
    longTasks: number[];
    inputLatency: number[];
    renders: { rtt: number; workerMs: number; width: number; height: number }[];
    paints: number;
  };
  await page.mouse.up();
  await page.waitForTimeout(800);

  const intervals = log.frames.slice(1).map((t, i) => t - log.frames[i]!);
  const span = (log.frames.at(-1)! - log.frames[0]!) / 1000;
  return {
    name: scenario.name,
    uiFps: round(intervals.length / span),
    frameP50: round(quantile(intervals, 0.5)),
    frameP95: round(quantile(intervals, 0.95)),
    frameMax: round(Math.max(...intervals)),
    mainBusy: round((busy / elapsed) * 100),
    longTasks: log.longTasks.length,
    inputP50: round(quantile(log.inputLatency, 0.5)),
    inputP95: round(quantile(log.inputLatency, 0.95)),
    imageFps: round(log.paints / span),
    workerP50: round(
      quantile(
        log.renders.map((r) => r.workerMs),
        0.5,
      ),
    ),
    rttP50: round(
      quantile(
        log.renders.map((r) => r.rtt),
        0.5,
      ),
    ),
    rttP95: round(
      quantile(
        log.renders.map((r) => r.rtt),
        0.95,
      ),
    ),
    minImageFps: scenario.minImageFps,
    renderSize: log.renders[0] ? `${log.renders[0].width}×${log.renders[0].height}` : '-',
  };
}

if (!existsSync(raw)) {
  console.error(`No RAW file at ${raw}: run ./scripts/fetch-golden-raws.sh or set PERF_RAW.`);
  process.exit(1);
}

await build({ root, logLevel: 'warn' });
const server = await preview({ root, logLevel: 'warn', preview: { port: 4179, strictPort: true } });
const browser = await chromium.launch({ channel: 'chromium' });
let results: Awaited<ReturnType<typeof drag>>[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: { error: 'unauthenticated' } }));
  await page.addInitScript(instrument);
  await page.goto('http://localhost:4179/develop');
  await page.locator('input[type="file"]').setInputFiles(raw);
  await page.locator('canvas').first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  for (const s of SCENARIOS) results.push(await drag(page, cdp, s));
} finally {
  await browser.close();
  await server.close();
}

console.table(results);
if (process.env.PERF_JSON) writeFileSync(process.env.PERF_JSON, JSON.stringify(results, null, 2));

if (throttle === 1 && !process.env.PERF_NO_BUDGETS) {
  const failures = results.flatMap((r) => {
    const checks: [string, boolean][] = [
      [`UI ${r.uiFps} fps < ${BUDGET.minUiFps}`, r.uiFps < BUDGET.minUiFps],
      [`frame p95 ${r.frameP95} ms > ${BUDGET.maxFrameP95}`, r.frameP95 > BUDGET.maxFrameP95],
      [`input p95 ${r.inputP95} ms > ${BUDGET.maxInputP95}`, r.inputP95 > BUDGET.maxInputP95],
      [`main thread ${r.mainBusy} % busy > ${BUDGET.maxMainBusy}`, r.mainBusy > BUDGET.maxMainBusy],
      [`image ${r.imageFps} fps < ${r.minImageFps}`, r.imageFps < r.minImageFps],
    ];
    return checks.filter(([, failed]) => failed).map(([message]) => `${r.name}: ${message}`);
  });
  for (const f of failures) console.error(`over budget: ${f}`);
  if (failures.length) process.exit(1);
  console.log('All within budget.');
}
