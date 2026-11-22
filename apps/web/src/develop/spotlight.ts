/**
 * The spotlight's matching (roadmap 2.6, a prototype): a short query abbreviates a
 * module, optionally some of its tabs, then one of its sliders, as prefixes of their
 * words in order: "filcon" is Filmic › Contrast, "cbmb" Color balance › Mixer › Blue hue,
 * "exp" Exposure. Modules and tabs are known up front; sliders only once the module is
 * shown, so the query is matched in two steps (`parseQuery`, then `matchSlider` on
 * what's left).
 */
import { fold } from '../lib/fuzzy.ts';

/** A module instance the spotlight can show (or a kind's future one: `id` is the kind). */
export interface SpotlightModule {
  id: string;
  kind: string;
  title: string;
}

/** A tab or view of a module kind: `patch` is what it sets in the instance's view. */
export interface SpotlightView {
  /** The view's field it sets: a target sets each field once. */
  field: string;
  value: string;
  /** Names to match, the first one shown. */
  labels: readonly string[];
  /** What the field is unless set: a tie goes to another view (`cbm` is the mixer, not the master tab). */
  isDefault?: boolean;
}

export interface SpotlightTarget {
  module: SpotlightModule;
  views: readonly SpotlightView[];
  /** The query left for the sliders. */
  rest: string;
  score: number;
}

/** A label's words, folded: "Mid-tones range" → mid, tones, range. */
export const wordsOf = (label: string) =>
  fold(label)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * How much of `query` (from its start) abbreviates `words`: each part of the query is a
 * prefix of a later word than the one before. For each length that can, the best score:
 * a letter is worth 1, a part starting the label or following its previous word 2 more,
 * and each word skipped costs 1.
 */
export function prefixMatches(query: string, words: readonly string[]): Map<number, number> {
  const best = new Map<number, number>();
  const walk = (at: number, word: number, score: number) => {
    for (let k = word; k < words.length; k++) {
      const w = words[k]!;
      const skipped = k - word;
      for (let l = 1; l <= w.length && at + l <= query.length; l++) {
        if (w[l - 1] !== query[at + l - 1]) break;
        const s = score + l + (skipped === 0 ? 2 : -skipped);
        const n = at + l;
        if ((best.get(n) ?? -Infinity) < s) best.set(n, s);
        walk(n, k + 1, s);
      }
    }
  };
  walk(0, 0, 0);
  return best;
}

/** Each letter left for the sliders costs this much: matching them to a module or tab is better. */
const REST_COST = 0.5;
/** How many tabs a target may name (colour balance › mixer › shadows). */
const MAX_VIEWS = 2;

/**
 * The targets `query` can mean, best first: a module (by its title or kind's title), the
 * tabs it names, and what's left for its sliders. One per module and tabs.
 */
export function parseQuery(
  query: string,
  modules: readonly SpotlightModule[],
  views: Readonly<Record<string, readonly SpotlightView[]>>,
): SpotlightTarget[] {
  const q = fold(query).replace(/\s+/g, '');
  if (!q) return [];
  const found = new Map<string, SpotlightTarget>();
  const keep = (t: SpotlightTarget) => {
    const key = [t.module.id, ...t.views.map((v) => `${v.field}=${v.value}`)].join('|');
    const old = found.get(key);
    if (!old || old.score < t.score) found.set(key, t);
  };
  const extend = (module: SpotlightModule, chosen: SpotlightView[], at: number, score: number) => {
    keep({ module, views: chosen, rest: q.slice(at), score: score - REST_COST * (q.length - at) });
    if (chosen.length >= MAX_VIEWS || at >= q.length) return;
    for (const view of views[module.kind] ?? []) {
      if (chosen.some((c) => c.field === view.field)) continue;
      for (const label of view.labels) {
        for (const [n, s] of prefixMatches(q.slice(at), wordsOf(label)))
          extend(module, [...chosen, view], at + n, score + s);
      }
    }
  };
  for (const module of modules) {
    for (const [n, s] of prefixMatches(q, wordsOf(module.title))) extend(module, [], n, s);
  }
  const defaults = (t: SpotlightTarget) => t.views.filter((v) => v.isDefault).length;
  // Ties: views that aren't shown anyway, the shorter title (Exposure before Multiple exposure), then the module's order.
  const order = new Map(modules.map((m, i) => [m.id, i]));
  return [...found.values()].sort(
    (a, b) =>
      b.score - a.score ||
      defaults(a) - defaults(b) ||
      a.module.title.length - b.module.title.length ||
      order.get(a.module.id)! - order.get(b.module.id)! ||
      a.views.length - b.views.length,
  );
}

/**
 * The slider `rest` names among `labels` (in the panel's order): the best one whose words
 * it abbreviates whole. Nothing left: the first (the module's main slider). Null when
 * none matches.
 */
export function matchSlider(rest: string, labels: readonly string[]): number | null {
  if (!labels.length) return null;
  if (!rest) return 0;
  let best: { i: number; score: number } | null = null;
  labels.forEach((label, i) => {
    const score = prefixMatches(rest, wordsOf(label)).get(rest.length);
    if (score !== undefined && (!best || score > best.score)) best = { i, score };
  });
  return (best as { i: number } | null)?.i ?? null;
}
