/**
 * Collections (roadmap 8.14): where photos come from, in a tree like folders. The server
 * keeps them (`apps/server/src/photos/collections.ts`): names are unique among siblings,
 * so a path of names finds one. The library filters by them (`collection`: ids, each
 * with those under it, or `none`).
 */
import { fold } from './fuzzy.ts';

/** `collection`'s value for photos in no collection. */
export const NO_COLLECTION = 'none';

/** A collection, as `/api/collections` lists them. */
export interface Collection {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  /** Its own photos in the library (not those under it). */
  photos: number;
  /** Its newest photo's capture time, else when it was made. */
  latest: string;
}

export interface CollectionNode extends Collection {
  children: CollectionNode[];
  /** Its photos and those under it. */
  total: number;
  /** Its newest photo's or newest under it's. */
  newest: string;
}

/** Newest first (the recent ones are the ones looked for), then by name. */
const byRecent = (a: CollectionNode, b: CollectionNode) =>
  b.newest.localeCompare(a.newest) || a.name.localeCompare(b.name, undefined, { numeric: true });

/**
 * The tree of `list`, siblings newest first. `counts` (a collection's own photos, as the
 * filters' facets give them) replaces `photos` when given: totals add up what's under.
 */
export function collectionTree(list: readonly Collection[], counts?: ReadonlyMap<string, number>): CollectionNode[] {
  const nodes = new Map<string, CollectionNode>(
    list.map((c) => [
      c.id,
      { ...c, photos: counts ? (counts.get(c.id) ?? 0) : c.photos, children: [], total: 0, newest: c.latest },
    ]),
  );
  const roots: CollectionNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const finish = (n: CollectionNode) => {
    for (const c of n.children) finish(c);
    n.total = n.photos + n.children.reduce((s, c) => s + c.total, 0);
    n.newest = n.children.reduce((m, c) => (c.newest > m ? c.newest : m), n.latest);
    n.children.sort(byRecent);
  };
  for (const r of roots) finish(r);
  return roots.sort(byRecent);
}

/** The collections in `nodes` by id, those under them too. */
export function collectionIndex(nodes: readonly CollectionNode[]): Map<string, CollectionNode> {
  const out = new Map<string, CollectionNode>();
  const add = (n: CollectionNode) => {
    out.set(n.id, n);
    n.children.forEach(add);
  };
  nodes.forEach(add);
  return out;
}

/** The names from the top down to collection `id`. */
export function collectionPath(byId: ReadonlyMap<string, Pick<Collection, 'parentId' | 'name'>>, id: string): string[] {
  const path: string[] = [];
  for (let c = byId.get(id); c; c = c.parentId ? byId.get(c.parentId) : undefined) path.unshift(c.name);
  return path;
}

export const displayCollection = (path: readonly string[]) => path.join(' › ');

/** Whether collection `id` is `ancestor` or under it. */
export function isWithin(byId: ReadonlyMap<string, Pick<Collection, 'parentId'>>, id: string, ancestor: string) {
  for (let c: string | null | undefined = id; c; c = byId.get(c)?.parentId) if (c === ancestor) return true;
  return false;
}

/** The collections whose name has every word of `query`, with the way to them (the others under a match left out). */
export function filterCollectionTree(nodes: readonly CollectionNode[], query: string): CollectionNode[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...nodes];
  return nodes.flatMap((n) => {
    if (words.every((w) => fold(n.name).includes(w))) return [n];
    const children = filterCollectionTree(n.children, query);
    return children.length ? [{ ...n, children }] : [];
  });
}

/** A name as the server keeps it: one line, trimmed. */
export const normalizeCollectionName = (name: string) => name.replace(/\s+/g, ' ').trim();
