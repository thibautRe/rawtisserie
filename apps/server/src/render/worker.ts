/**
 * Worker thread: develops RAW files with the WebAssembly pipeline and writes JPEG
 * previews. Runs off the main thread because decoding a 60MP file takes a while.
 */
import { parentPort } from 'node:worker_threads';
import {
  defaultEditParams,
  defaultRecipe as recipeFor,
  developerMeasures,
  type EditParams,
  hasPendingAutoTune,
  resolveAutoTunes,
} from '@rawtisserie/pipeline';
import { Developer, initPipeline, readMetadata } from '@rawtisserie/pipeline/node';
import { readLut } from '../luts/files.ts';
import { storage } from '../storage/index.ts';
import type { RenderJob, RenderResult } from './types.ts';

initPipeline();

parentPort!.on('message', async (job: RenderJob) => {
  let result: RenderResult;
  try {
    const bytes = await storage.read(job.sourceKey);
    if (!bytes) throw new Error(`Original not found: ${job.sourceKey}`);
    const metadata = job.extractMetadata || job.autoDefaults ? JSON.parse(readMetadata(bytes)) : null;
    let defaultRecipe: EditParams | null = null;
    if (job.autoDefaults) {
      const recipe = recipeFor(metadata);
      if (recipe !== defaultEditParams) defaultRecipe = recipe;
    }
    const dev = new Developer(bytes);
    let resolvedRecipe: EditParams | null = null;
    try {
      for (const id of job.luts) {
        const lut = await readLut(id);
        if (lut) dev.loadLut(lut);
      }
      // Auto-tunes a preset or style asked for (roadmap 8.7): measured first, at the
      // preview's size, so the renders below reuse the cached base.
      if (!defaultRecipe && hasPendingAutoTune(job.params)) {
        resolvedRecipe = await resolveAutoTunes(job.params!, developerMeasures(dev));
      }
      const params = JSON.stringify(defaultRecipe ?? resolvedRecipe ?? job.params ?? {});
      // Largest first, so the smaller renders can reuse the cached base image.
      for (const output of [...job.outputs].sort((a, b) => b.maxSize - a.maxSize)) {
        const jpeg = dev.renderJpeg(params, output.maxSize, output.maxSize, output.quality);
        await storage.put(output.key, jpeg);
      }
    } finally {
      dev.free();
    }
    result = {
      jobId: job.jobId,
      ok: true,
      metadata: job.extractMetadata ? metadata : null,
      defaultRecipe,
      resolvedRecipe,
    };
  } catch (err) {
    result = { jobId: job.jobId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(result);
});
