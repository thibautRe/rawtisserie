/** A page of a list cached on its own (`usePagedVersions`), when it came in. */
export interface LoadedPage<T> {
  /** Its number: it holds positions `page * pageSize` onwards. */
  page: number;
  versions: readonly T[];
  total: number;
  updatedAt: number;
}

/**
 * One slot per position of a list whose pages were fetched at different times. The list
 * may have changed in between (an import adds versions, a new upload moves once its
 * date is read): the latest page knows the total, and a version found on two pages
 * keeps the newer page's slot, so no version is listed twice (the grid keys cards by
 * id: twice, React leaves stray cards behind). `stale` lists the pages that disagree
 * with the latest, to fetch again.
 */
export function mergePages<T extends { id: string }>(pages: readonly LoadedPage<T>[], pageSize: number) {
  const newest = [...pages].sort((a, b) => b.updatedAt - a.updatedAt);
  const total = newest[0]?.total ?? 0;
  const items: (T | undefined)[] = new Array(total).fill(undefined);
  const seen = new Set<string>();
  const stale = new Set<number>();
  for (const p of newest) {
    if (p.total !== total) stale.add(p.page);
    p.versions.forEach((v, k) => {
      const at = p.page * pageSize + k;
      if (at >= total) return;
      if (seen.has(v.id)) {
        stale.add(p.page);
        return;
      }
      seen.add(v.id);
      items[at] = v;
    });
  }
  return { items, total, latest: newest[0], stale: [...stale].sort((a, b) => a - b) };
}
