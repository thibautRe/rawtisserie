/**
 * The spotlight's matching (roadmap 2.6, a prototype). Everything it can reach is an
 * entry: a module, one of its tabs, or a control on it (a slider, a button, a select),
 * named by words (the module's title, the tabs on the way, the control's label). A query
 * abbreviates an entry as prefixes of its words in order, any of them skipped: "filcon"
 * is Filmic › Contrast, "cbmb" Color balance › Mixer › Blue hue, "temp" any Temperature.
 *
 * Modules, tabs and sliders are known up front (`SPOTLIGHT_VIEWS`, `SPOTLIGHT_SLIDERS`);
 * other controls (buttons, selects) only as the panel has shown them (`ControlIndex`,
 * from the page).
 */
import { fold } from '../lib/fuzzy.ts';

/** A module instance (or a kind's future one: `id` is the kind). */
export interface SpotlightModule {
  id: string;
  kind: string;
  title: string;
}

/** A tab or view of a module kind: what it sets in the instance's view. */
export interface SpotlightView {
  field: string;
  value: string;
  /** Names to match, the first one shown (and the tab's text or name, to find it). */
  labels: readonly string[];
  /** What the field is unless set: a tie goes to another view (`cbm` is the mixer, not the master tab). */
  isDefault?: boolean;
  /** Only shown on this other view (the mixer's views, on the Mixer tab). */
  under?: { field: string; value: string };
}

export type ControlKind = 'slider' | 'button' | 'select';

/** A control of a module, as the page showed it: the `nth` with that label. */
export interface SpotlightControl {
  kind: ControlKind;
  label: string;
  nth: number;
}

/** A slider of a module kind, as the panel has it (`SPOTLIGHT_SLIDERS`). */
export interface SpotlightSlider {
  label: string;
  /** The title of the group it's in, when its label repeats in the module. */
  group?: string;
  /** Which of the sliders with that label it is, as the panel shows them. */
  nth?: number;
  /** The views it's shown on (fields of `SPOTLIGHT_VIEWS`). */
  views?: Readonly<Record<string, string>>;
  /** It also depends on the module's settings: when, in words. */
  conditional?: string;
}

/** The controls an instance showed, with the views it showed them on. */
export interface ShownControls {
  views: Readonly<Record<string, string>>;
  controls: readonly SpotlightControl[];
}

/** Controls seen, by instance id, then by its views (JSON). */
export type ControlIndex = ReadonlyMap<string, ReadonlyMap<string, ShownControls>>;

export interface SpotlightEntry {
  module: SpotlightModule;
  /** The views it shows, in order (a parent before what's under it). */
  views: readonly SpotlightView[];
  /** What it's about: a control, or the last view's tab, or (neither) the module. */
  control: SpotlightControl | null;
  /** The control's group, when its label repeats in the module. */
  group?: string;
  words: readonly string[];
}

export interface SpotlightMatch {
  entry: SpotlightEntry;
  score: number;
}

/** A label's words, folded: "Mid-tones range" → mid, tones, range. */
export const wordsOf = (label: string) =>
  fold(label)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Each word skipped costs this; each word left after the last part, `TRAILING`. */
const SKIP = 1;
const TRAILING = 0.25;

/**
 * How well `query` abbreviates `words` as a whole: each part of it is a prefix of a later
 * word than the one before. A letter is worth 1; each part costs 1, given back when it's
 * on the next word (or the first) and once more when it's the whole word, so cutting the
 * query into more parts never pays ("primaries brightness" is Brightness, not "primarie"
 * + "s" + "brightnes" + "s" of Brightness smoothing). Words skipped and words left after
 * cost. Null when it doesn't abbreviate them.
 */
export function abbreviationScore(query: string, words: readonly string[]): number | null {
  let best: number | null = null;
  const walk = (at: number, word: number, score: number) => {
    for (let k = word; k < words.length; k++) {
      const w = words[k]!;
      const placed = k === word ? 0 : -SKIP * (k - word) - 1;
      for (let l = 1; l <= w.length && at + l <= query.length; l++) {
        if (w[l - 1] !== query[at + l - 1]) break;
        const s = score + l + placed + (l === w.length ? 1 : 0);
        if (at + l === query.length) {
          const total = s - TRAILING * (words.length - k - 1);
          if (best === null || total > best) best = total;
        } else walk(at + l, k + 1, s);
      }
    }
  };
  if (query) walk(0, 0, 0);
  return best;
}

/** What an entry shows and focuses, as a key: one entry per key. */
export const entryKey = (e: SpotlightEntry) =>
  [
    e.module.id,
    ...e.views.map((v) => `${v.field}=${v.value}`),
    e.control ? `${e.control.label}#${e.control.nth}` : '',
  ].join('|');

/**
 * The entries for `modules`: each module, its tabs, its sliders (known up front), and the
 * other controls `index` has seen on it (buttons, selects).
 */
export function buildEntries(
  modules: readonly SpotlightModule[],
  views: Readonly<Record<string, readonly SpotlightView[]>>,
  sliders: Readonly<Record<string, readonly SpotlightSlider[]>>,
  index: ControlIndex,
): SpotlightEntry[] {
  const out: SpotlightEntry[] = [];
  for (const module of modules) {
    const own = views[module.kind] ?? [];
    const title = wordsOf(module.title);
    const parentOf = (v: SpotlightView) =>
      v.under ? own.find((p) => p.field === v.under!.field && p.value === v.under!.value) : undefined;
    out.push({ module, views: [], control: null, words: title });
    for (const view of own) {
      const parent = parentOf(view);
      const path = parent ? [parent, view] : [view];
      // One entry per name of the view (CAT is also White balance).
      for (const label of view.labels) {
        const words = [...title, ...(parent ? wordsOf(parent.labels[0]!) : []), ...wordsOf(label)];
        out.push({ module, views: path, control: null, words });
      }
    }
    // The views a control is on: those that aren't shown anyway are named on the way.
    const pathOf = (on: Readonly<Record<string, string>>) =>
      own.filter((v) => on[v.field] === v.value && (!v.under || on[v.under.field] === v.under.value));
    const named = (path: readonly SpotlightView[]) =>
      path.filter((v) => !v.isDefault).flatMap((v) => wordsOf(v.labels[0]!));
    for (const slider of sliders[module.kind] ?? []) {
      const path = pathOf(slider.views ?? {});
      const control = { kind: 'slider' as const, label: slider.label, nth: slider.nth ?? 0 };
      const words = [...title, ...named(path), ...wordsOf(slider.group ?? ''), ...wordsOf(slider.label)];
      out.push({ module, views: path, control, group: slider.group, words });
    }
    for (const shown of index.get(module.id)?.values() ?? []) {
      const path = pathOf(shown.views);
      for (const control of shown.controls) {
        if (control.kind === 'slider') continue;
        // "Reset Exposure", "Exposure presets": the module is named already.
        const own = wordsOf(control.label).filter((w) => !title.includes(w));
        out.push({ module, views: path, control, words: [...title, ...named(path), ...own] });
      }
    }
  }
  return out;
}

/** The entries `query` names, best first, one per key. */
export function rankEntries(query: string, entries: readonly SpotlightEntry[]): SpotlightMatch[] {
  const q = fold(query).replace(/\s+/g, '');
  if (!q) return [];
  const best = new Map<string, SpotlightMatch & { order: number }>();
  entries.forEach((entry, order) => {
    const score = abbreviationScore(q, entry.words);
    if (score === null) return;
    const key = entryKey(entry);
    const old = best.get(key);
    if (!old || old.score < score) best.set(key, { entry, score, order });
  });
  const defaults = (e: SpotlightEntry) => e.views.filter((v) => v.isDefault).length;
  // Ties: views that are shown anyway last, then fewer words (Exposure before
  // Multiple exposure), then the panel's order.
  return [...best.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        defaults(a.entry) - defaults(b.entry) ||
        a.entry.words.length - b.entry.words.length ||
        a.order - b.order,
    )
    .map(({ entry, score }) => ({ entry, score }));
}
