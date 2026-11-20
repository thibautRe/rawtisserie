/**
 * Worker thread for the culling loupe's zoomed-in views: renders tiles of a version at
 * 100 % (or a power of two below). Keeps the last file decoded, since a zoomed-in view
 * asks for many tiles of the same photo.
 */
import { parentPort } from 'node:worker_threads';
import {
  defaultRecipe,
  developerMeasures,
  hasPendingAutoTune,
  importEdits,
  lutIds,
  resolveAutoTunes,
} from '@rawtisserie/pipeline';
import { Developer, initPipeline, lensfun } from '@rawtisserie/pipeline/node';
import { readLut } from '../luts/files.ts';
import { storage } from '../storage/index.ts';
import { loadExposures } from './exposures.ts';
import { ZOOM_TILE, type ZoomLevels, type ZoomRequest, type ZoomResponse, type ZoomSource } from './zoomTypes.ts';

initPipeline();

/** Only levels finer than the stored preview (2048 px) are worth tiles. */
const PREVIEW_EDGE = 2048;

let current: { key: string; dev: Developer } | null = null;
/**
 * Recipes with pending auto-tunes (roadmap 8.7), resolved: the loupe can ask for tiles
 * before the preview's render has written them into the history.
 */
const resolved = new Map<string, string>();

async function developer(key: string): Promise<Developer> {
  if (current?.key === key) return current.dev;
  current?.dev.free();
  current = null;
  resolved.clear();
  const bytes = await storage.read(key);
  if (!bytes) throw new Error(`Original not found: ${key}`);
  const dev = new Developer(bytes);
  current = { key, dev };
  return dev;
}

async function prepare(source: ZoomSource) {
  const dev = await developer(source.sourceKey);
  for (const id of source.luts) {
    if (dev.hasLut(id)) continue;
    const lut = await readLut(id);
    if (lut) dev.loadLut(lut);
  }
  await loadExposures(dev, source.exposures);
  const recipe = source.autoDefaults ? await startingRecipe(dev, source.importedEdits, source.userLuts) : source.params;
  const params = JSON.stringify(recipe ?? {});
  if (recipe && hasPendingAutoTune(recipe)) {
    if (!resolved.has(params)) {
      resolved.set(params, JSON.stringify(await resolveAutoTunes(recipe, developerMeasures(dev))));
    }
    return { dev, params: resolved.get(params)! };
  }
  return { dev, params };
}

/** What a version without history shows: the default recipe, or the edits it was imported with on top. */
async function startingRecipe(dev: Developer, importedEdits: string | null, luts: ZoomSource['userLuts']) {
  const metadata = JSON.parse(dev.metadata());
  const base = defaultRecipe(metadata, lensfun());
  if (!importedEdits) return base;
  const recipe = (await importEdits(importedEdits, { base, metadata, luts }).catch(() => null))?.recipe ?? base;
  // The user's LUTs it found by name.
  for (const id of lutIds(recipe)) {
    if (dev.hasLut(id)) continue;
    const lut = await readLut(id);
    if (lut) dev.loadLut(lut);
  }
  return recipe;
}

function levels(dev: Developer, params: string): ZoomLevels {
  const [width = 0, height = 0] = dev.outputSize(params, 0, 0);
  const out: ZoomLevels = [{ width, height }];
  for (let n = 1; Math.max(width, height) / 2 ** n > PREVIEW_EDGE; n++) {
    const [w, h] = dev.outputSize(params, Math.ceil(width / 2 ** n), Math.ceil(height / 2 ** n));
    out.push({ width: w!, height: h! });
  }
  return out;
}

parentPort!.on('message', async (req: ZoomRequest) => {
  let res: ZoomResponse;
  try {
    const { dev, params } = await prepare(req.source);
    const all = levels(dev, params);
    if (req.kind === 'levels') res = { jobId: req.jobId, ok: true, levels: all };
    else {
      const level = all[req.level];
      const x = req.col * ZOOM_TILE;
      const y = req.row * ZOOM_TILE;
      if (!level || x >= level.width || y >= level.height) {
        res = { jobId: req.jobId, ok: false, error: 'No such tile', notFound: true };
      } else {
        const region = [x, y, Math.min(ZOOM_TILE, level.width - x), Math.min(ZOOM_TILE, level.height - y)];
        const jpeg = dev.renderJpeg(params, level.width, level.height, req.quality, Uint32Array.from(region));
        res = { jobId: req.jobId, ok: true, jpeg };
      }
    }
  } catch (err) {
    res = { jobId: req.jobId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(res, 'jpeg' in res ? [res.jpeg.buffer as ArrayBuffer] : []);
});
