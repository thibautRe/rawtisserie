/**
 * Tags are paths: levels separated by `|` (`People|Alice`), as XMP's
 * `lr:hierarchicalSubject` has them, shown as People › Alice. Mirrors the server's
 * `photos/tags.ts`. A tag counts under each of its ancestors (filters, counts).
 */

import { fold } from './fuzzy.ts';

export const SEPARATOR = '|';

/** As typed: levels trimmed, empty ones dropped (`People | Alice|` → `People|Alice`). */
export const normalizeTag = (tag: string) =>
  tag
    .split(SEPARATOR)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(SEPARATOR);

export const tagLevels = (tag: string) => tag.split(SEPARATOR);
/** Its last level: `Alice`. */
export const tagName = (tag: string) => tagLevels(tag).at(-1)!;
/** Its parent (`People`), or null at the top. */
export const tagParent = (tag: string) => {
  const at = tag.lastIndexOf(SEPARATOR);
  return at < 0 ? null : tag.slice(0, at);
};
/** For people: `People › Alice`. */
export const displayTag = (tag: string) => tagLevels(tag).join(' › ');
/** `tag` is `parent` or under it. */
export const isUnder = (tag: string, parent: string) => tag === parent || tag.startsWith(parent + SEPARATOR);
/** `tag` moved from under `from` to under `to` (`isUnder(tag, from)`). */
export const retag = (tag: string, from: string, to: string) => to + tag.slice(from.length);

export interface TagNode {
  path: string;
  name: string;
  /** Photos with it or a tag under it. */
  count: number;
  children: TagNode[];
}

/**
 * A tree of `values` (each level with its count, as the server lists them), sorted by
 * name. A level missing from the list (cut by a limit) is added, its count unknown (0).
 */
export function tagTree(values: readonly { value: string; count: number }[]): TagNode[] {
  const nodes = new Map<string, TagNode>();
  const node = (path: string): TagNode => {
    let n = nodes.get(path);
    if (!n) {
      n = { path, name: tagName(path), count: 0, children: [] };
      nodes.set(path, n);
      const parent = tagParent(path);
      (parent === null ? roots : node(parent).children).push(n);
    }
    return n;
  };
  const roots: TagNode[] = [];
  for (const { value, count } of values) node(value).count = count;
  const sort = (list: TagNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/**
 * The tags of `nodes` whose path has `query` (folded: case and accents aside), with the
 * way to them: their ancestors, and what's under them. All of them for an empty query.
 */
export function filterTagTree(nodes: readonly TagNode[], query: string): TagNode[] {
  const q = fold(query);
  if (!q) return [...nodes];
  return nodes.flatMap((n) => {
    if (fold(n.path).includes(q)) return [n];
    const children = filterTagTree(n.children, q);
    return children.length ? [{ ...n, children }] : [];
  });
}
