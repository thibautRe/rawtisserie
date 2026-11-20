/** The other photos a recipe blends in (multiple exposure), for the render workers. */
import type { Developer } from '@rawtisserie/pipeline/node';
import { storage } from '../storage/index.ts';
import type { ExposureSource } from './source.ts';

/**
 * Load the photos `dev` doesn't have yet. One that can't be read or decoded is left
 * out: the render goes on without it, as the developer's does.
 */
export async function loadExposures(dev: Developer, exposures: readonly ExposureSource[]) {
  for (const { sha256, key } of exposures) {
    if (dev.hasExposure(sha256)) continue;
    const bytes = await storage.read(key).catch(() => null);
    if (!bytes) continue;
    try {
      dev.loadExposure(sha256, bytes);
    } catch {
      // Not a photo the pipeline reads: rendered without it.
    }
  }
}
