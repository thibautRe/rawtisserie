/**
 * Worker thread: develops RAW files with the WebAssembly pipeline and writes AVIF
 * renders (encoded natively by sharp: rav1e in wasm was twice as slow, see roadmap
 * 7.11). Runs off the main thread because decoding a 60MP file takes a while.
 */
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';
import {
  defaultRecipe as recipeFor,
  developerMeasures,
  type EditParams,
  hasPendingAutoTune,
  importEdits,
  lutIds,
  resolveAutoTunes,
} from '@rawtisserie/pipeline';
import { Developer, initPipeline, lensfun, readMetadata } from '@rawtisserie/pipeline/node';
import { readLut } from '../luts/files.ts';
import { storage } from '../storage/index.ts';
import { loadExposures } from './exposures.ts';
import type { RenderJob, RenderResult } from './types.ts';

initPipeline();

parentPort!.on('message', async (job: RenderJob) => {
  let result: RenderResult;
  try {
    const bytes = await storage.read(job.sourceKey);
    if (!bytes) throw new Error(`Original not found: ${job.sourceKey}`);
    const metadata = job.extractMetadata || job.autoDefaults ? JSON.parse(readMetadata(bytes)) : null;
    let defaultRecipe: EditParams | null = null;
    let imported: { label: string; recipe: EditParams } | null = null;
    const dev = new Developer(bytes);
    let resolvedRecipe: EditParams | null = null;
    try {
      for (const id of job.luts) {
        const lut = await readLut(id);
        if (lut) dev.loadLut(lut);
      }
      await loadExposures(dev, job.exposures);
      // Auto-tunes the default recipe or a preset or style asked for (roadmap 8.7):
      // measured first, at the preview's size, so the renders below reuse the cached base.
      if (job.autoDefaults) {
        defaultRecipe = await resolveAutoTunes(recipeFor(metadata, lensfun()), developerMeasures(dev));
        // Edits from another application: the entry after the default recipe, on top of it.
        if (job.importedEdits) {
          const edits = await importEdits(job.importedEdits, {
            base: defaultRecipe,
            metadata,
            luts: job.userLuts,
          }).catch(() => null);
          if (edits) imported = { label: edits.label, recipe: edits.recipe };
          // The user's LUTs it found by name.
          for (const id of imported ? lutIds(imported.recipe) : []) {
            const lut = job.luts.includes(id) ? null : await readLut(id);
            if (lut) dev.loadLut(lut);
          }
        }
      } else if (hasPendingAutoTune(job.params)) {
        resolvedRecipe = await resolveAutoTunes(job.params!, developerMeasures(dev));
      }
      const params = JSON.stringify(imported?.recipe ?? defaultRecipe ?? resolvedRecipe ?? job.params ?? {});
      // Largest first, so the smaller renders can reuse the cached base image.
      for (const output of [...job.outputs].sort((a, b) => b.maxSize - a.maxSize)) {
        const img = dev.renderFinal(params, output.maxSize, output.maxSize);
        const { width, height } = img;
        const pixels = img.takeData();
        img.free();
        const avif = await sharp(pixels, { raw: { width, height, channels: 4 } })
          .removeAlpha()
          // Effort 2: ~1.4 s for a 2048 px preview on one core; 4 takes ten times longer
          // for a file barely smaller. 4:2:0 like the JPEGs it replaces.
          .avif({ quality: output.quality, effort: 2, chromaSubsampling: '4:2:0' })
          .toBuffer();
        await storage.put(output.key, avif);
      }
    } finally {
      dev.free();
    }
    result = {
      jobId: job.jobId,
      ok: true,
      metadata: job.extractMetadata ? metadata : null,
      defaultRecipe,
      imported,
      resolvedRecipe,
    };
  } catch (err) {
    result = { jobId: job.jobId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(result);
});
