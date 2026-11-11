/** How a library export is spread over workers. */

/**
 * Memory an export lane needs per pixel of the photo: the decoded photo and its
 * full-size render (measured natively: 0.9 GB for a 24 MP JPEG export, ~37 bytes per
 * pixel; heavy recipes need more). A worker's memory doesn't shrink once grown.
 */
const BYTES_PER_PIXEL = 40;
/** What the lanes may use together. */
const MEMORY_BUDGET = 4 * 2 ** 30;
/** A photo whose size isn't known is counted as this many pixels. */
const UNKNOWN_PIXELS = 50e6;

/**
 * How many photos are exported at once, each on its own worker. An export is
 * single-threaded, so more lanes use more cores: one per four hardware threads, up to
 * three, and fewer for large photos (`pixels`, the largest), so that together they stay
 * within the memory budget: three at 24 MP, two at 45 MP, one at 61 MP.
 */
export function exportLanes(threads: number, pixels: number | null): number {
  const byCores = Math.min(3, Math.floor(threads / 4));
  const byMemory = Math.floor(MEMORY_BUDGET / ((pixels ?? UNKNOWN_PIXELS) * BYTES_PER_PIXEL));
  return Math.max(1, Math.min(byCores, byMemory));
}

/** Runs of consecutive photos sharing an original (versions of one file), as indices. */
export function originalGroups(urls: readonly string[]): number[][] {
  const groups: number[][] = [];
  urls.forEach((url, i) => {
    if (i > 0 && urls[i - 1] === url) groups.at(-1)!.push(i);
    else groups.push([i]);
  });
  return groups;
}
