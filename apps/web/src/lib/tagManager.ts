/** The tag manager's view of the tags (`pages/TagsPage.tsx`), and what its changes will do, in words. */
import type { TagManagerData } from '../api/hooks.ts';
import type { Shortcut } from './keys.ts';
import { type TagNode, displayTag, tagName, tagParent, tagTree } from './tags.ts';

/** What the manager knows of a tag, besides the tree. */
export interface TagInfo {
  /** Photos in the library with it or a tag under it. */
  photos: number;
  /** Only in the trash. */
  trashed: number;
  shortcut: Shortcut | null;
  /** Tags under it, at any depth. */
  descendants: number;
}

/** The manager's tree and what it knows of each tag, from the server's lists. */
export function managedTags(data: TagManagerData) {
  const tree = tagTree([
    ...data.levels.map((l) => ({ value: l.value, count: l.photos })),
    ...data.own.filter((o) => !data.levels.some((l) => l.value === o.tag)).map((o) => ({ value: o.tag, count: 0 })),
  ]);
  const info = new Map<string, TagInfo>();
  const walk = (nodes: TagNode[]): number =>
    nodes.reduce((total, n) => {
      const level = data.levels.find((l) => l.value === n.path);
      const descendants = walk(n.children);
      info.set(n.path, {
        photos: level?.photos ?? 0,
        trashed: level?.trashed ?? 0,
        shortcut: data.own.find((o) => o.tag === n.path)?.shortcut ?? null,
        descendants,
      });
      return total + 1 + descendants;
    }, 0);
  walk(tree);
  return { tree, info };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const onPhotos = (i: TagInfo) =>
  `${plural(i.photos, 'photo')}${i.trashed ? ` (and ${plural(i.trashed, 'version')} in the trash)` : ''}`;

/**
 * What a rename (or move, or merge) will do, in words, and what its button says. `to`
 * may exist: they become one tag.
 */
export function describeRename(from: string, to: string, info: ReadonlyMap<string, TagInfo>) {
  const i = info.get(from)!;
  const target = info.get(to);
  const moving = tagParent(from) !== tagParent(to) && tagName(from) === tagName(to);
  const parts = [`${displayTag(from)} becomes ${displayTag(to)}${i.photos + i.trashed ? ` on ${onPhotos(i)}` : ''}.`];
  if (i.descendants)
    parts.push(
      i.descendants === 1 ? 'The tag under it follows.' : `The ${plural(i.descendants, 'tag')} under it follow.`,
    );
  if (target)
    parts.push(
      `${displayTag(to)} exists already: they’ll be one tag${
        target.shortcut && i.shortcut ? `, with ${displayTag(to)}’s shortcut` : ''
      }.`,
    );
  return { text: parts.join(' '), action: target ? 'Merge' : moving ? 'Move' : 'Rename' };
}

/** What deleting `tag` will do, in words. */
export function describeDelete(tag: string, info: ReadonlyMap<string, TagInfo>) {
  const i = info.get(tag)!;
  const parts = [
    i.photos + i.trashed
      ? `${displayTag(tag)} will be removed from ${onPhotos(i)}`
      : `${displayTag(tag)} will be removed`,
  ];
  if (i.descendants)
    parts[0] += i.descendants === 1 ? ', with the tag under it' : `, with the ${plural(i.descendants, 'tag')} under it`;
  parts[0] += '.';
  if (i.shortcut) parts.push('Its shortcut goes with it.');
  parts.push('The photos stay; this can’t be undone.');
  return parts.join(' ');
}
