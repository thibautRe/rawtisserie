/// <reference lib="webworker" />
/**
 * Runs the WebAssembly pixel pipeline off the main thread. Holds at most one
 * decoded RAW file; the pipeline caches its demosaiced base image between renders.
 * When only the point operations need to run (colour edits), they are split across
 * a pool of workers, at full size even while dragging.
 */
import { type EditParams, type SensorMapping, lutIds } from '@rawtisserie/pipeline';
import init, { Developer, parseLut } from '@rawtisserie/pipeline/wasm';
import wasmUrl from '@rawtisserie/pipeline/wasm/pipeline_bg.wasm?url';
import { PointPool } from './pointPool.ts';
import type {
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

const ready = init({ module_or_path: wasmUrl });
let developer: Developer | null = null;
// Export workers (`LocalRenderBackend({ pool: false })`) render one photo each, several
// at once: they don't need a pool of their own.
const pool = self.name === 'export' ? null : PointPool.create();

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

// One message at a time: pool renders await their workers, and nothing else may touch
// the developer meanwhile. Thumbnails (menu previews) wait until nothing else does, so
// that a menu's worth of them doesn't hold up the render of the highlighted item.
const urgent: WorkerRequest[] = [];
const idle: WorkerRequest[] = [];
let running = false;
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  (event.data.type === 'thumbnail' ? idle : urgent).push(event.data);
  void run();
};

async function run() {
  if (running) return;
  running = true;
  try {
    for (let msg = urgent.shift() ?? idle.shift(); msg; msg = urgent.shift() ?? idle.shift()) await handle(msg);
  } finally {
    running = false;
  }
}

async function handle(msg: WorkerRequest) {
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
    if (msg.type === 'load') {
      developer?.free();
      developer = null;
      // The new developer has none: the pool's go too, and come back as recipes use them.
      for (const id of loadedLuts) pool?.unloadLut(id);
      loadedLuts = [];
      thumbnailLuts = [];
      developer = new Developer(new Uint8Array(msg.bytes));
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
