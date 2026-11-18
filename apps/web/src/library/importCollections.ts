/**
 * Which collection each imported photo goes to (roadmap 8.14), as the user picks in the
 * review, whatever the files' folders: the folders as they are, one per day, one per
 * shoot (a new one after hours without photos, so a night out stays together), all in
 * one, or none. Each photo's collection is a path of names, sent with its upload; the
 * server makes what isn't there and reuses what is (names are unique among siblings).
 */
import { fileCollectionName } from '../lib/collections.ts';
import type { CaptureTime } from './captureTime.ts';
import type { PickedFile } from './pickedFiles.ts';

export type SortMode = 'day' | 'gap' | 'folders' | 'one' | 'none';

export interface Sorting {
  mode: SortMode;
  /** Days and shoots inside a collection per year. */
  byYear: boolean;
  /** `gap`: hours without photos that start a new collection. */
  gapHours: number;
  /** `one`: the collection's path. */
  one: string[];
  /** Names given in the review, by group key (`day` and `gap`). */
  names: Record<string, string>;
}

export const DEFAULT_GAP_HOURS = 4;

export interface PlannedGroup {
  /** Stable across changes of the other options: names given to it stay. */
  key: string;
  /** Where it goes: names from the top. */
  path: string[];
  /** The name it has without one given. */
  defaultName: string;
  files: number;
  /** Its first and last capture times. */
  from: CaptureTime;
  to: CaptureTime;
}

export interface Plan {
  groups: PlannedGroup[];
  /** Each photo's collection; photos in none aren't in it. */
  of: Map<PickedFile, string[]>;
}

const day = (t: CaptureTime) => t.slice(0, 10);
const ms = (t: CaptureTime) => Date.parse(`${t}Z`);
/** A folder's levels (`DCIM/100MSDCF/A.ARW` → DCIM, 100MSDCF). */
const foldersOf = (path: string) => path.split('/').slice(0, -1).map(fileCollectionName).filter(Boolean);

/** Whether files picked have folders to keep. */
export const hasFolders = (files: readonly PickedFile[]) => files.some((f) => f.path.includes('/'));

/**
 * A card (DCIM, the cameras' `100MSDCF` folders) is sorted by day; folders that someone
 * arranged are kept; files without folders by day too.
 */
export function defaultSorting(files: readonly PickedFile[]): Sorting {
  const camera = files.some((f) => /(^|\/)DCIM\//i.test(f.path) || /(^|\/)\d{3}[A-Z0-9_]{5}\//.test(f.path));
  return {
    mode: !camera && hasFolders(files) ? 'folders' : 'day',
    byYear: false,
    gapHours: DEFAULT_GAP_HOURS,
    one: [],
    names: {},
  };
}

/** Where each photo of `files` goes, with `times` (`readCaptureTime`; a missing one: no day, no collection). */
export function planCollections(
  files: readonly PickedFile[],
  times: ReadonlyMap<PickedFile, CaptureTime>,
  sorting: Sorting,
): Plan {
  const groups = new Map<string, { group: PlannedGroup; members: PickedFile[] }>();
  const add = (key: string, defaultName: string, path: (name: string) => string[], f: PickedFile) => {
    const time = times.get(f) ?? '';
    let g = groups.get(key);
    if (!g) {
      // Names given in the review: `|` becomes `-`, as in folders' names.
      const name = fileCollectionName(sorting.names[key] ?? '') || defaultName;
      g = {
        group: { key, path: path(name), defaultName, files: 0, from: time, to: time },
        members: [],
      };
      groups.set(key, g);
    }
    g.members.push(f);
    g.group.files++;
    if (time && (!g.group.from || time < g.group.from)) g.group.from = time;
    if (time > g.group.to) g.group.to = time;
  };
  const dated = (name: string, first: CaptureTime) => (sorting.byYear ? [first.slice(0, 4), name] : [name]);

  if (sorting.mode === 'folders')
    for (const f of files) {
      const folders = foldersOf(f.path);
      if (folders.length) add(`folder:${folders.join('/')}`, folders.at(-1)!, () => folders, f);
    }
  else if (sorting.mode === 'one') {
    const one = sorting.one.map(fileCollectionName).filter(Boolean);
    if (one.length) for (const f of files) add('one', one.at(-1)!, () => one, f);
  } else if (sorting.mode === 'day')
    for (const f of files) {
      const t = times.get(f);
      if (t) add(`day:${day(t)}`, day(t), (name) => dated(name, t), f);
    }
  else if (sorting.mode === 'gap') {
    const sorted = files.filter((f) => times.has(f)).sort((a, b) => times.get(a)!.localeCompare(times.get(b)!));
    const gap = Math.max(0.25, sorting.gapHours) * 3600_000;
    // Shoots starting the same day: the second is "2026-11-09 (2)".
    const perDay = new Map<string, number>();
    let key = '';
    let last = -Infinity;
    for (const f of sorted) {
      const t = times.get(f)!;
      if (ms(t) - last > gap) {
        key = `gap:${t}`;
        const n = (perDay.get(day(t)) ?? 0) + 1;
        perDay.set(day(t), n);
        const name = n > 1 ? `${day(t)} (${n})` : day(t);
        const first = t;
        add(key, name, (given) => dated(given, first), f);
      } else add(key, '', () => [], f);
      last = ms(t);
    }
  }

  const of = new Map<PickedFile, string[]>();
  for (const { group, members } of groups.values()) for (const f of members) of.set(f, group.path);
  const list = [...groups.values()].map((g) => g.group);
  // Newest first, as the library shows them; folders by path.
  list.sort((a, b) =>
    sorting.mode === 'folders' ? a.path.join('/').localeCompare(b.path.join('/')) : b.from.localeCompare(a.from),
  );
  return { groups: list, of };
}

/** How the user sorted their last import of this kind (a card, or folders of their own). */
const sortingKey = (files: readonly PickedFile[]) =>
  `library.import.sorting.${defaultSorting(files).mode === 'folders' ? 'folders' : 'card'}`;

/** `fallback`, with the choices made for the last import of the same kind (not its names). */
export function rememberedSorting(fallback: Sorting, files: readonly PickedFile[]): Sorting {
  try {
    const saved = JSON.parse(localStorage.getItem(sortingKey(files)) ?? 'null') as Partial<Sorting> | null;
    if (!saved) return fallback;
    const mode =
      saved.mode === 'folders' && !hasFolders(files)
        ? fallback.mode
        : saved.mode === 'one'
          ? fallback.mode
          : saved.mode;
    return {
      ...fallback,
      mode: mode ?? fallback.mode,
      byYear: saved.byYear ?? fallback.byYear,
      gapHours: saved.gapHours ?? fallback.gapHours,
    };
  } catch {
    return fallback;
  }
}

export function rememberSorting(sorting: Sorting, files: readonly PickedFile[]) {
  try {
    const { mode, byYear, gapHours } = sorting;
    localStorage.setItem(sortingKey(files), JSON.stringify({ mode, byYear, gapHours }));
  } catch {
    // Not remembered: the next import starts from the defaults.
  }
}
