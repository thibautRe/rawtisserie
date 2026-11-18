/** The tags as their management sees them (the Tags filter's menus, `TagEditor`), and what changes will do, in words. */
import type { TagChange, TagManagerData } from '../api/hooks.ts';
import { type Shortcut, formatShortcut, samePress, shortcutConflict } from './keys.ts';
import {
  SEPARATOR,
  type TagNode,
  displayTag,
  isUnder,
  normalizeTag,
  tagLevels,
  tagName,
  tagParent,
  tagTree,
} from './tags.ts';

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

/** What the tag editor has: a new tag (`tag` null) or an existing one, as edited. */
export interface TagEdit {
  /** The tag edited, or null for a new one. */
  tag: string | null;
  /** Its whole path as typed, levels separated by `|`: missing ones are created with it. */
  path: string;
  shortcut: Shortcut | null;
}

/** The levels of `path` as typed (`People|Family|Alice`), each with whether it's new: not a tag yet. */
export function pathLevels(path: string, info: ReadonlyMap<string, TagInfo>) {
  const normal = normalizeTag(path);
  if (!normal) return [];
  const levels = tagLevels(normal);
  return levels.map((name, i) => {
    const at = levels.slice(0, i + 1).join(SEPARATOR);
    return { path: at, name, isNew: !info.has(at) };
  });
}

const sameShortcut = (a: Shortcut | null, b: Shortcut | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((k, i) => samePress(k, b[i]!)));

/**
 * What saving `edit` will do: why it can't (`problem`; '' when there's just nothing to
 * save yet), in words (`effects`), its button (`action`), and the changes to make, in
 * order (a rename first, then the shortcut on the tag's new path).
 */
export function planEdit(edit: TagEdit, info: ReadonlyMap<string, TagInfo>) {
  const path = normalizeTag(edit.path);
  const current = edit.tag === null ? undefined : info.get(edit.tag);
  const plan = (problem: string | null, effects: string[], changes: TagChange[], action: string) => ({
    problem,
    effects,
    changes,
    action,
  });
  const action = edit.tag === null ? 'Create' : 'Save';
  if (!path) return plan('', [], [], action);
  // Renamed or deleted since the editor opened (here, or in another tab).
  if (edit.tag !== null && !current) return plan(`${displayTag(edit.tag)} doesn’t exist anymore.`, [], [], action);
  const effects: string[] = [];
  const changes: TagChange[] = [];
  let button = action;

  if (edit.tag === null) {
    if (info.has(path)) return plan(`${displayTag(path)} exists already.`, [], [], action);
    effects.push(`Creates ${displayTag(path)}. No photo has it yet: it’s suggested when tagging.`);
    changes.push({ type: 'create', tag: path });
  } else if (path !== edit.tag) {
    if (isUnder(path, edit.tag)) return plan('A tag can’t go inside itself.', [], [], action);
    effects.push(describeRename(edit.tag, path, info).text);
    changes.push({ type: 'rename', from: edit.tag, to: path });
    if (info.has(path)) button = 'Merge';
  }

  if (!sameShortcut(edit.shortcut, current?.shortcut ?? null)) {
    if (edit.shortcut) {
      const others = [...info].flatMap(([tag, i]) =>
        tag !== edit.tag && tag !== path ? [{ tag, shortcut: i.shortcut }] : [],
      );
      const conflict = shortcutConflict(edit.shortcut, others, displayTag);
      if (conflict) return plan(conflict, effects, [], button);
      effects.push(
        `${formatShortcut(edit.shortcut)} will add or remove ${displayTag(path)}: on the selected photos in the library, on the photo shown when culling.`,
      );
    } else effects.push('Its shortcut is removed.');
    changes.push({ type: 'shortcut', tag: path, shortcut: edit.shortcut });
  }
  // An existing tag as it was: nothing to save.
  return plan(changes.length ? null : '', effects, changes, button);
}
