/**
 * The library's tag and rating filters (roadmap 8.12), as the URL holds them; the
 * server reads them the same way (`PhotoFilters` in `apps/server/src/photos/query.ts`).
 *
 * Tags: `tag` the tags a photo must have (or one under each), in groups by parent: all
 * of a group's, unless its parent is in `tagAny` (any of them; `TOP_LEVEL` for the
 * top-level tags). `notTag` the tags it must not have, nor any under them, except under
 * the tags it must have: `tag=People|Alice&notTag=People` is Alice and nobody else.
 *
 * Ratings: `ratingMin` (at least) or `rating` (any of these).
 */
import { SEPARATOR, displayTag, isUnder, tagParent } from '../lib/tags.ts';

/** `tagAny`'s name for the group of top-level tags. */
export const TOP_LEVEL = SEPARATOR;
export const groupOf = (tag: string) => tagParent(tag) ?? TOP_LEVEL;

export type TagState = 'include' | 'exclude' | null;

export function tagState(params: URLSearchParams, tag: string): TagState {
  if (params.getAll('tag').includes(tag)) return 'include';
  if (params.getAll('notTag').includes(tag)) return 'exclude';
  return null;
}

/** The included tags of each group, groups in order of their first tag. */
export function tagGroups(params: URLSearchParams): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const tag of params.getAll('tag')) groups.set(groupOf(tag), [...(groups.get(groupOf(tag)) ?? []), tag]);
  return groups;
}

export const isAny = (params: URLSearchParams, group: string) => params.getAll('tagAny').includes(group);

const replaceAll = (params: URLSearchParams, key: string, values: string[]) => {
  params.delete(key);
  for (const v of new Set(values)) params.append(key, v);
};

/**
 * Click on a tag: not used → must have it → must not have it → not used. Having a tag
 * goes with no "No tags"; a group that's down to one tag forgets its any/all.
 */
export function cycleTag(params: URLSearchParams, tag: string): void {
  const state = tagState(params, tag);
  const tags = params.getAll('tag').filter((t) => t !== tag);
  const notTags = params.getAll('notTag').filter((t) => t !== tag);
  if (state === null) {
    tags.push(tag);
    params.delete('untagged');
  } else if (state === 'include') notTags.push(tag);
  replaceAll(params, 'tag', tags);
  replaceAll(params, 'notTag', notTags);
  const groups = tagGroups(params);
  replaceAll(
    params,
    'tagAny',
    params.getAll('tagAny').filter((g) => (groups.get(g)?.length ?? 0) > 1),
  );
}

/** Switch `group` between all of its tags and any of them. */
export function toggleAny(params: URLSearchParams, group: string): void {
  const any = params.getAll('tagAny');
  replaceAll(params, 'tagAny', any.includes(group) ? any.filter((g) => g !== group) : [...any, group]);
}

/** "No tags" leaves the tags a photo must have (nothing would match both), not the others. */
export function setUntagged(params: URLSearchParams, on: boolean): void {
  if (on) {
    params.set('untagged', 'true');
    params.delete('tag');
    params.delete('tagAny');
  } else params.delete('untagged');
}

/** The tag filters in a few words: `sunset`, `People › Alice or People › Bob`, `not Places`, `no other People`. */
export function describeTags(params: URLSearchParams): string[] {
  const parts: string[] = [];
  for (const [group, tags] of tagGroups(params)) {
    if (isAny(params, group) && tags.length > 1) parts.push(tags.map(displayTag).join(' or '));
    else parts.push(...tags.map(displayTag));
  }
  for (const tag of params.getAll('notTag')) {
    const except = params.getAll('tag').filter((t) => t !== tag && isUnder(t, tag));
    parts.push(except.length ? `no other ${displayTag(tag)}` : `not ${displayTag(tag)}`);
  }
  return parts;
}

// ── Ratings ──────────────────────────────────────────────────────────────────

const STARS = [1, 2, 3, 4, 5];

/** The star counts the filter shows (none: any). */
export function ratingSet(params: URLSearchParams): number[] {
  const exact = params
    .getAll('rating')
    .map(Number)
    .filter((n) => STARS.includes(n));
  if (exact.length) return [...new Set(exact)].sort();
  const min = Number(params.get('ratingMin') ?? 0);
  return min > 0 ? STARS.filter((n) => n >= min) : [];
}

/**
 * Write a set of star counts: "at least" when it runs up to 5 (1–5 is "rated": unrated
 * photos are left out), any rating when it's empty.
 */
export function setRatings(params: URLSearchParams, set: readonly number[]): void {
  params.delete('rating');
  params.delete('ratingMin');
  const sorted = [...new Set(set)].filter((n) => STARS.includes(n)).sort();
  if (!sorted.length) return;
  const min = sorted[0]!;
  if (sorted.length === 6 - min && sorted.every((n, i) => n === min + i)) {
    params.set('ratingMin', String(min));
    return;
  }
  for (const n of sorted) params.append('rating', String(n));
}

/**
 * A click on star `n`: "at least n" (again: any rating); with `toggle` (Ctrl/⌘), that
 * star in or out of the set; with `range` (Shift), the stars from `anchor` (the last
 * one clicked) to `n`.
 */
export function clickStar(
  params: URLSearchParams,
  n: number,
  { toggle = false, range = false }: { toggle?: boolean; range?: boolean },
  anchor: number | null,
): void {
  const set = ratingSet(params);
  if (range) {
    const from = anchor ?? n;
    setRatings(
      params,
      STARS.filter((s) => s >= Math.min(from, n) && s <= Math.max(from, n)),
    );
  } else if (toggle) setRatings(params, set.includes(n) ? set.filter((s) => s !== n) : [...set, n]);
  else {
    const atLeast = !params.has('rating') && Number(params.get('ratingMin') ?? 0) === n;
    setRatings(params, atLeast ? [] : STARS.filter((s) => s >= n));
  }
}

/** The rating filter in a few words: `★ 3+`, `★ 2`, `★ 2–3`, `★ 1, 3, 5`. */
export function describeRating(params: URLSearchParams): string | null {
  const set = ratingSet(params);
  if (!set.length) return null;
  const [min, max] = [set[0]!, set.at(-1)!];
  if (max === 5 && set.length === 6 - min) return `★ ${min}+`;
  if (set.length === 1) return `★ ${min}`;
  if (set.length === max - min + 1) return `★ ${min}–${max}`;
  return `★ ${set.join(', ')}`;
}
