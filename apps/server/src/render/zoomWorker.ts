/**
 * Worker thread for the culling loupe's zoomed-in views: renders tiles of a version at
 * 100 % (or a power of two below). Keeps the last file decoded, since a zoomed-in view
 * asks for many tiles of the same photo.
 */
import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { defaultRecipe } from '@rawtisserie/pipeline';
import { Developer, initPipeline } from '@rawtisserie/pipeline/node';
import { ZOOM_TILE, type ZoomLevels, type ZoomRequest, type ZoomResponse, type ZoomSource } from './zoomTypes.ts';

initPipeline();

/** Only levels finer than the stored preview (2048 px) are worth tiles. */
const PREVIEW_EDGE = 2048;

let current: { path: string; dev: Developer } | null = null;

async function developer(path: string): Promise<Developer> {
  if (current?.path === path) return current.dev;
  current?.dev.free();
  current = null;
  const dev = new Developer(await readFile(path));
  current = { path, dev };
  return dev;
}

async function prepare(source: ZoomSource) {
  const dev = await developer(source.sourcePath);
  for (const [id, file] of source.luts) if (!dev.hasLut(id)) dev.loadLut(await readFile(file));
  const recipe = source.autoDefaults ? defaultRecipe(JSON.parse(dev.metadata())) : (source.params ?? {});
  return { dev, params: JSON.stringify(recipe) };
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
