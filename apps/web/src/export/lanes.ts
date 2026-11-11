/** How a library export is spread over workers. */

/**
 * How many photos are exported at once, each on its own worker. An export is
 * single-threaded, so more lanes use more cores, but each holds a decoded photo and its
 * full-size render (about 1 GB at 24 MP, 2.5 GB at 61 MP): a few at most.
 */
export function exportLanes(threads = navigator.hardwareConcurrency || 4): number {
  return Math.max(1, Math.min(3, Math.floor(threads / 4)));
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
