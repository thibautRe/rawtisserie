/**
 * The web app's built files (`/assets/…`), this build's and the ones before it. A page
 * loaded before a deploy still asks for its own files afterwards (routes and workers are
 * loaded when first needed), named by the hash of their content: they must still be
 * there, or that page breaks until it's reloaded.
 *
 * So the server serves them from a directory that outlives the image (`STORAGE_DIR`),
 * where each start adds the current build's. A file goes `KEEP_DAYS` after it was last
 * part of a build that started.
 */
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

export const KEEP_DAYS = 30;
const DAY = 24 * 3600_000;

/** Add the files of `build` to `kept`, and remove those of builds gone `KEEP_DAYS` ago. */
export async function keepAssets(build: string, kept: string, now = Date.now()) {
  await mkdir(kept, { recursive: true });
  const current = (await readdir(build, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  const existing = new Set(await readdir(kept));
  let added = 0;
  for (const name of current) {
    const target = path.join(kept, name);
    if (!existing.has(name)) {
      // Whole or not at all: a start cut short mustn't leave a truncated file to serve.
      const partial = `${target}.partial`;
      await copyFile(path.join(build, name), partial);
      await rename(partial, target);
      added++;
    }
    // When it was last current: what its age counts from.
    await utimes(target, new Date(now), new Date(now));
  }
  const inBuild = new Set(current);
  let removed = 0;
  for (const name of existing) {
    if (inBuild.has(name)) continue;
    const file = path.join(kept, name);
    if (name.endsWith('.partial') || (await stat(file)).mtimeMs < now - KEEP_DAYS * DAY) {
      await rm(file, { force: true });
      removed++;
    }
  }
  return { added, removed, total: current.length };
}
