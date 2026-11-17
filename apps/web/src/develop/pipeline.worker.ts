/// <reference lib="webworker" />
/**
 * Runs the WebAssembly pixel pipeline off the main thread. Holds at most one
 * decoded RAW file; the pipeline caches its demosaiced base image between renders.
 * When only the point operations need to run (colour edits), they are split across
 * a pool of workers, at full size even while dragging.
 */
import {
  type EditParams,
  type SensorMapping,
  activeDenoise,
  denoiseKeyName,
  denoiseModelId,
  lutIds,
  toSensor,
} from '@rawtisserie/pipeline';
import init, { Developer, parseLut } from '@rawtisserie/pipeline/wasm';
import wasmUrl from '@rawtisserie/pipeline/wasm/pipeline_bg.wasm?url';
import { DenoisePool, type TileResult, denoiseWorkers } from './denoisePool.ts';
import { PointPool } from './pointPool.ts';
import { announceAlive } from './startWorker.ts';
import type {
  DenoiseEvent,
  DenoiseStatus,
  GuideLine,
  Overlays,
  PerspectiveCorrection,
  Placement,
  Region,
  WorkerRequest,
  WorkerResponse,
} from './protocol.ts';
import { computeScope } from './scopes.ts';

declare const self: DedicatedWorkerGlobalScope;

// Fetched and compiled once here: the pool's workers get the compiled module.
const wasm = WebAssembly.compileStreaming(fetch(wasmUrl));
const ready = wasm.then((module) => init({ module_or_path: module }));
let developer: Developer | null = null;
// Export workers (`LocalRenderBackend({ pool: false })`) render one photo each, several
// at once: they don't need a pool of their own.
const pool = self.name === 'export' ? null : PointPool.create(wasm);
/** The pool, once its workers are up (until then, this worker renders alone). */
const livePool = () => (pool?.ready ? pool : null);

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

/** RGBA8 pixels as an image the page can show without copying them on its thread. */
const toBitmap = (data: Uint8Array, width: number, height: number) =>
  createImageBitmap(
    new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.length), width, height),
  );

/**
 * Before a render, have the pool diffuse the channels of its uncached diffuse steps in
 * parallel (the developer would do them one after the other): the render then uses them.
 */
async function offloadDiffuse(
  dev: Developer,
  params: string,
  maxWidth: number,
  maxHeight: number,
  region?: Uint32Array,
) {
  const pool = livePool();
  if (!pool) return;
  // Each job is one diffuse step; a recipe rarely has more than a couple.
  for (let i = 0; i < 16; i++) {
    const job = dev.nextDiffuseJob(params, maxWidth, maxHeight, region);
    if (!job) return;
    try {
      const [red, green, blue] = await pool.diffuse(job);
      dev.provideDiffuse(job.key, job.width, job.height, red, green, blue);
    } catch (err) {
      // The render computes what's missing itself.
      console.warn('Diffusing on the pool failed', err);
      return;
    } finally {
      job.free();
    }
  }
}

/** A region as the wasm module takes it. */
const regionArg = (r: Region | null) => (r ? new Uint32Array([r.x, r.y, r.width, r.height]) : undefined);

/** The LUTs the page sent, packed, by id. */
const lutBytes = new Map<string, Uint8Array>();
/**
 * The LUTs loaded into the developer and the pool, least recently used first. A
 * 144³ table takes 9 MB in each of them, so those that recent recipes don't use go
 * (hovering the LUT menu goes through many).
 */
let loadedLuts: string[] = [];
/** How many LUTs that the recipe doesn't use stay loaded. */
const SPARE_LUTS = 2;

/** Load the LUTs `params` uses (those the page sent), and unload the oldest others. */
function prepareLuts(dev: Developer, params: EditParams) {
  const needed = lutIds(params).filter((id) => lutBytes.has(id));
  for (const id of needed) {
    if (!loadedLuts.includes(id)) {
      dev.loadLut(lutBytes.get(id)!);
      pool?.loadLut(id, lutBytes.get(id)!);
    }
    loadedLuts = [...loadedLuts.filter((x) => x !== id), id];
  }
  while (loadedLuts.length > needed.length + SPARE_LUTS) {
    const id = loadedLuts.find((x) => !needed.includes(x))!;
    dev.unloadLut(id);
    pool?.unloadLut(id);
    loadedLuts = loadedLuts.filter((x) => x !== id);
  }
}

/** The LUTs loaded for thumbnails only, least recently used first (the LUT menu's go through all). */
let thumbnailLuts: string[] = [];

/**
 * Load the LUTs a thumbnail of `params` uses that the developer doesn't have, for
 * thumbnails only: they don't go to the pool, and few stay.
 */
function prepareThumbnailLuts(dev: Developer, params: EditParams) {
  const needed = lutIds(params).filter((id) => lutBytes.has(id) && !dev.hasLut(id));
  for (const id of needed) {
    if (!thumbnailLuts.includes(id)) dev.loadThumbnailLut(lutBytes.get(id)!);
    thumbnailLuts = [...thumbnailLuts.filter((x) => x !== id), id];
  }
  while (thumbnailLuts.length > needed.length + SPARE_LUTS) {
    const id = thumbnailLuts.find((x) => !needed.includes(x))!;
    dev.unloadThumbnailLut(id);
    thumbnailLuts = thumbnailLuts.filter((x) => x !== id);
  }
}

/** The last sensor mapping, by the lens and geometry instances it comes from. */
let mapping: { key: string; value: SensorMapping } | null = null;
function sensorMapping(dev: Developer, params: EditParams, json: string): SensorMapping {
  const key = JSON.stringify(params.modules.filter((m) => m.kind === 'lens' || m.kind === 'geometry'));
  if (mapping?.key !== key) mapping = { key, value: JSON.parse(dev.sensorMapping(json)) as SensorMapping };
  return mapping.value;
}

// ── Raw denoise (roadmap 3.5) ──────────────────────────────────────────────────
// Tiles are denoised beside renders, on workers of their own (an export worker, which
// has none, denoises in place before exporting). Results are taken in between
// messages only, so a render never sees its photo change halfway.

const denoisePool = self.name === 'export' ? null : new DenoisePool(wasm);
const denoise = {
  /** The latest recipe rendered or exported, and its JSON. */
  params: null as EditParams | null,
  json: null as string | null,
  /** Where the view is on the sensor (normalised): those tiles first. */
  focus: [0.5, 0.5] as [number, number],
  /** Models the page sent, by id: for the developer and the pool. */
  models: new Map<string, Uint8Array>(),
  /** Models it couldn't send. */
  unavailable: new Set<string>(),
  asked: new Set<string>(),
  askedOriginal: false,
  /** Bumped by every photo loaded: results for an earlier one are dropped. */
  generation: 0,
  inFlight: 0,
  results: [] as (TileResult & { generation: number })[],
  /** The last status told, as JSON. */
  told: '',
  /** The key of the last denoised photo handed to the page to keep. */
  kept: null as string | null,
  timer: null as ReturnType<typeof setTimeout> | null,
  /** No new tile before then (`performance.now()`): a slider is being dragged. */
  pausedUntil: 0,
};

/** How long after a draft render (a drag) tiles wait, so the drag keeps the cores. */
const DRAG_PAUSE_MS = 400;

const tell = (event: DenoiseEvent, transfer: Transferable[] = []) => post({ type: 'denoise', id: 0, event }, transfer);

function resetDenoise() {
  denoise.generation++;
  denoise.results = [];
  denoise.asked.clear();
  denoise.askedOriginal = false;
  denoise.told = '';
  denoise.kept = null;
}

/** Follow `params`' raw denoise (after a render or for an export). */
function watchDenoise(params: EditParams, json: string, focus?: [number, number]) {
  denoise.params = params;
  denoise.json = json;
  if (focus) denoise.focus = focus;
  scheduleDenoise(150);
}

function scheduleDenoise(delay: number) {
  if (denoise.timer) clearTimeout(denoise.timer);
  denoise.timer = setTimeout(() => {
    denoise.timer = null;
    // Mid-message: `run` pumps once it's done.
    if (!running) pumpDenoise();
  }, delay);
}

/** Take results in, hand tiles out, and tell the page what changed. Between messages only. */
function pumpDenoise(): DenoiseStatus | null {
  const dev = developer;
  const { json, params } = denoise;
  if (!dev || !json || !params) return null;
  for (const r of denoise.results.splice(0)) {
    if (r.generation === denoise.generation) dev.provideDenoiseTile(r.key, r.core, r.values ?? undefined);
  }
  let status = JSON.parse(dev.denoiseStatus(json)) as DenoiseStatus;
  if (status.state === 'needsModel' && status.model) {
    const bytes = denoise.models.get(status.model);
    if (bytes) {
      dev.loadDenoiseModel(status.model, bytes);
      status = JSON.parse(dev.denoiseStatus(json)) as DenoiseStatus;
    } else if (denoise.unavailable.has(status.model)) {
      status = { ...status, error: 'The denoising model could not be downloaded.' };
    } else if (!denoise.asked.has(status.model)) {
      denoise.asked.add(status.model);
      tell({ kind: 'needModel', model: status.model });
    }
  }
  if (status.state === 'needsOriginal' && !denoise.askedOriginal) {
    denoise.askedOriginal = true;
    tell({ kind: 'needOriginal' });
  }
  const paused = denoise.pausedUntil - performance.now();
  if (status.state === 'pending' && denoisePool && paused > 0) scheduleDenoise(paused);
  else if (status.state === 'pending' && denoisePool) {
    const active = activeDenoise(params);
    const limit = active ? denoiseWorkers(denoiseModelId(active.params.model)) : 1;
    while (denoise.inFlight < limit) {
      const tile = dev.nextDenoiseTile(json, denoise.focus[0], denoise.focus[1]);
      if (!tile) break;
      const bytes = denoise.models.get(tile.model);
      if (!bytes) {
        tile.free();
        break;
      }
      const generation = denoise.generation;
      denoise.inFlight++;
      void denoisePool.run(tile, tile.model, bytes).then((r) => {
        denoise.inFlight--;
        denoise.results.push({ ...r, generation });
        scheduleDenoise(0);
      });
    }
  }
  const told = JSON.stringify(status);
  if (told !== denoise.told) {
    denoise.told = told;
    tell({ kind: 'status', status });
  }
  // Computed here (not opened from a kept file): the page keeps it.
  if (status.state === 'ready' && dev.hasOriginal()) {
    const key = denoiseKeyName(params);
    if (key && key !== denoise.kept) {
      const file = dev.denoisedFile(json);
      if (file) {
        denoise.kept = key;
        tell({ kind: 'denoised', key, file: file.buffer as ArrayBuffer }, [file.buffer as ArrayBuffer]);
      }
    }
  }
  return status;
}

/** Before an export: the recipe's raw denoise done, or an error. */
async function finishDenoise(dev: Developer, params: EditParams, json: string) {
  watchDenoise(params, json);
  for (;;) {
    const status = pumpDenoise();
    if (!status || status.state === 'off' || status.state === 'unsupported' || status.state === 'ready') return;
    if (status.error) throw new Error(status.error);
    if (status.state === 'pending' && !denoisePool) {
      dev.denoiseNow(json);
      continue;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// One message at a time: pool renders await their workers, and nothing else may touch
// the developer meanwhile. Thumbnails (menu previews) wait until nothing else does, so
// that a menu's worth of them doesn't hold up the render of the highlighted item.
const urgent: WorkerRequest[] = [];
const idle: WorkerRequest[] = [];
let running = false;
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  // Answers to what the worker asked for, which a message in progress (an export) may
  // be waiting on: taken in at once.
  if (msg.type === 'denoiseModel' || msg.type === 'setOriginal') return void receive(msg);
  (msg.type === 'thumbnail' ? idle : urgent).push(msg);
  void run();
};

async function receive(msg: Extract<WorkerRequest, { type: 'denoiseModel' | 'setOriginal' }>) {
  try {
    await ready;
    if (msg.type === 'denoiseModel') {
      if (msg.bytes) denoise.models.set(msg.model, new Uint8Array(msg.bytes));
      else denoise.unavailable.add(msg.model);
    } else {
      developer?.setOriginal(new Uint8Array(msg.bytes));
      denoise.askedOriginal = false;
    }
    post({ type: 'done', id: msg.id });
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
  scheduleDenoise(0);
}

async function run() {
  if (running) return;
  running = true;
  try {
    for (let msg = urgent.shift() ?? idle.shift(); msg; msg = urgent.shift() ?? idle.shift()) await handle(msg);
  } finally {
    running = false;
  }
  pumpDenoise();
}

async function handle(msg: WorkerRequest) {
  if (msg.type === 'denoiseModel' || msg.type === 'setOriginal') return receive(msg);
  const started = performance.now();
  try {
    await ready;
    if (msg.type === 'lut') {
      lutBytes.set(msg.lutId, new Uint8Array(msg.bytes));
      post({ type: 'lutLoaded', id: msg.id });
      return;
    }
    if (msg.type === 'parseLut') {
      const parsed = parseLut(new Uint8Array(msg.bytes));
      const packed = parsed.takePacked().buffer as ArrayBuffer;
      const { id: lutId, size, bitDepth } = parsed;
      parsed.free();
      post({ type: 'parsedLut', id: msg.id, lutId, size, bitDepth, packed }, [packed]);
      return;
    }
    if (msg.type === 'load' || msg.type === 'loadDenoised') {
      developer?.free();
      developer = null;
      resetDenoise();
      // The new developer has none: the pool's go too, and come back as recipes use them.
      for (const id of loadedLuts) pool?.unloadLut(id);
      loadedLuts = [];
      thumbnailLuts = [];
      const bytes = new Uint8Array(msg.bytes);
      developer = msg.type === 'load' ? new Developer(bytes) : Developer.fromDenoisedFile(bytes);
      // Its models are loaded again as recipes ask for them (from `denoise.models`).
      mapping = null;
      pool?.invalidate();
      post({ type: 'loaded', id: msg.id, metadata: JSON.parse(developer.metadata()), ms: performance.now() - started });
      return;
    }
    if (!developer) throw new Error('No RAW file loaded');
    if (msg.type === 'thumbnail') prepareThumbnailLuts(developer, msg.params);
    else if (msg.type !== 'fitPerspective') prepareLuts(developer, msg.params);
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
      const focus = toSensor(sensor, (x! + fullWidth! / 2) / frameWidth!, (y! + fullHeight! / 2) / frameHeight!);
      if (isDraft) denoise.pausedUntil = performance.now() + DRAG_PAUSE_MS;
      watchDenoise(msg.params, params, [focus[0], focus[1]]);
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
      const pool = livePool();
      const upgrade = isDraft && !!pool && developer.isSpatialCached(params, full.width, full.height, full.region);
      if (pool && (!isDraft || upgrade)) {
        await offloadDiffuse(developer, params, full.width, full.height, full.region);
        const { width, height, data } = await pool.render(developer, params, full.width, full.height, full.region);
        let overlays: Overlays = msg.overlays;
        if (upgrade && overlays.stripes) {
          // Stripe widths were scaled for the draft.
          const [draftWidth] = developer.outputSize(params, msg.maxWidth, msg.maxHeight);
          overlays = { ...overlays, stripes: (overlays.stripes * frameWidth!) / draftWidth! };
        }
        const scope = drawScope(data, width, height);
        if (overlays.display || overlays.sensor || overlays.mask || overlays.toneCurve || overlays.toneRange) {
          const json = JSON.stringify(overlays);
          developer.paintOverlays(params, full.width, full.height, data, width, height, json, full.region);
        }
        await rendered(data, width, height, scope);
        return;
      }
      const region = regionArg(msg.region);
      const o = msg.overlays;
      const painted = !!(o.display || o.sensor || o.mask || o.toneCurve || o.toneRange);
      // With a scope, the overlays are painted after it is drawn (as `render` would).
      const split = painted && !!msg.scope;
      const overlays = split ? '{}' : JSON.stringify(msg.overlays);
      await offloadDiffuse(developer, params, msg.maxWidth, msg.maxHeight, region);
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
    } else if (msg.type === 'thumbnail') {
      const img = developer.renderThumbnail(params, msg.maxWidth, msg.maxHeight);
      const { width, height } = img;
      const bitmap = await toBitmap(img.takeData(), width, height);
      img.free();
      post({ type: 'thumbnail', id: msg.id, bitmap, ms: performance.now() - started }, [bitmap]);
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
    } else if (msg.type === 'detectLines') {
      const lines = JSON.parse(developer.detectLines(params, msg.maxWidth, msg.maxHeight)) as GuideLine[];
      post({ type: 'detectedLines', id: msg.id, lines, ms: performance.now() - started });
    } else if (msg.type === 'fitPerspective') {
      const fit = JSON.parse(
        developer.fitPerspective(params, JSON.stringify(msg.lines), msg.mode),
      ) as PerspectiveCorrection | null;
      post({ type: 'fittedPerspective', id: msg.id, fit, ms: performance.now() - started });
    } else if (msg.type === 'export') {
      await finishDenoise(developer, msg.params, params);
      const file = developer.renderExport(params, JSON.stringify(msg.options), JSON.stringify(msg.metadata));
      // Full-resolution renders are large: drop the cache so the next preview rebuilds a small one.
      developer.releaseCache();
      post({ type: 'exported', id: msg.id, file: file.buffer as ArrayBuffer, ms: performance.now() - started }, [
        file.buffer as ArrayBuffer,
      ]);
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
}

announceAlive();
