/**
 * Worker thread: develops RAW files with the WebAssembly pipeline and writes JPEG
 * previews. Runs off the main thread because decoding a 60MP file takes a while.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { defaultEditParams, defaultRecipe as recipeFor, type EditParams } from '@rawtisserie/pipeline';
import { Developer, initPipeline, readMetadata } from '@rawtisserie/pipeline/node';
import type { RenderJob, RenderResult } from './types.ts';

initPipeline();

parentPort!.on('message', async (job: RenderJob) => {
  let result: RenderResult;
  try {
    const bytes = await readFile(job.sourcePath);
    const metadata = job.extractMetadata || job.autoDefaults ? JSON.parse(readMetadata(bytes)) : null;
    let defaultRecipe: EditParams | null = null;
    if (job.autoDefaults) {
      const recipe = recipeFor(metadata);
      if (recipe !== defaultEditParams) defaultRecipe = recipe;
    }
    const dev = new Developer(bytes);
    try {
      const params = JSON.stringify(defaultRecipe ?? job.params ?? {});
      // Largest first, so the smaller renders can reuse the cached base image.
      for (const output of [...job.outputs].sort((a, b) => b.maxSize - a.maxSize)) {
        const jpeg = dev.renderJpeg(params, output.maxSize, output.maxSize, output.quality);
        await mkdir(path.dirname(output.path), { recursive: true });
        await writeFile(output.path, jpeg);
      }
    } finally {
      dev.free();
    }
    result = { jobId: job.jobId, ok: true, metadata: job.extractMetadata ? metadata : null, defaultRecipe };
  } catch (err) {
    result = { jobId: job.jobId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(result);
});
