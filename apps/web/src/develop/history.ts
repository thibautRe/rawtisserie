import type { EditParams, ModuleInstance } from '@rawtisserie/pipeline';
import { describeChange } from './changes.ts';

/** Successive changes to the same module instance within this window share one history entry. */
const COALESCE_MS = 30_000;

export interface HistoryEntry {
  label: string;
  /** The full recipe after this change. */
  recipe: EditParams;
  createdAt: string;
}

/**
 * A change to the history, as sent to the server (`POST /api/versions/:id/history`).
 * Entries are numbered from 1 and `end` is the new `history_end`.
 */
export type HistoryOp =
  { type: 'splice'; from: number; entries: HistoryEntry[]; end: number } | { type: 'goto'; end: number };

export interface HistorySnapshot {
  entries: readonly HistoryEntry[];
  /** Entries 1…end are applied; 0 is the original. */
  end: number;
}

export interface HistoryState extends HistorySnapshot {
  /** What is shown: the recipe at `end`, or a live (uncommitted) change on top of it. */
  live: EditParams;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A version's linear history (Ansel/darktable semantics): committing from an earlier
 * point drops the later entries. Every change is reported to `onOp` so it can be
 * mirrored on the server. Live changes (slider drags) are only shown until committed.
 */
export class HistoryStore {
  readonly original: EditParams;
  #state: HistoryState;
  #listeners = new Set<() => void>();
  /** The entry this session wrote last, which a change to the same module may replace. */
  #last: { seq: number; moduleId: string; before: EditParams } | null = null;
  onOp: ((op: HistoryOp) => void) | null = null;

  constructor(original: EditParams, { entries, end }: HistorySnapshot) {
    this.original = original;
    this.#state = { entries, end, live: entries[end - 1]?.recipe ?? original };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = () => this.#state;

  recipeAt(seq: number): EditParams {
    return seq === 0 ? this.original : this.#state.entries[seq - 1]!.recipe;
  }

  /** The recipe at `end`. */
  get committed() {
    return this.recipeAt(this.#state.end);
  }

  #set(state: Partial<HistoryState>, op?: HistoryOp) {
    this.#state = { ...this.#state, ...state };
    if (op) this.onOp?.(op);
    for (const l of this.#listeners) l();
  }

  setLive(live: EditParams) {
    this.#set({ live });
  }

  /**
   * Record `recipe` (by default the live one) as the next entry. Returns how many
   * later entries this dropped (0 unless committing from an earlier point). A `label`
   * (e.g. "Style: B&W") replaces the description of the change, which then always gets
   * its own entry.
   */
  commit(recipe = this.#state.live, now = Date.now(), label?: string): number {
    const { entries, end } = this.#state;
    const base = this.committed;
    if (same(recipe, base)) {
      this.#set({ live: base });
      return 0;
    }
    const change = label ? { label, moduleId: null, structural: true } : describeChange(base, recipe);
    const last = this.#last;
    const previous = entries[end - 1];
    const replace =
      !change.structural &&
      !!last &&
      !!previous &&
      last.seq === end &&
      last.moduleId === change.moduleId &&
      now - Date.parse(previous.createdAt) < COALESCE_MS;
    const entry: HistoryEntry = replace
      ? { label: describeChange(last.before, recipe).label, recipe, createdAt: previous.createdAt }
      : { label: change.label, recipe, createdAt: new Date(now).toISOString() };
    const from = replace ? end : end + 1;
    if (!replace)
      this.#last =
        change.moduleId && !change.structural ? { seq: from, moduleId: change.moduleId, before: base } : null;
    this.#set(
      { entries: [...entries.slice(0, from - 1), entry], end: from, live: recipe },
      { type: 'splice', from, entries: [entry], end: from },
    );
    return entries.length - end;
  }

  /**
   * Replace the recipe of the current entry, keeping its label and date (an automatic
   * entry, once its auto-tunes have run). A live change is dropped.
   */
  amend(recipe: EditParams) {
    const { entries, end } = this.#state;
    const current = entries[end - 1];
    if (!current) return;
    const entry = { ...current, recipe };
    this.#last = null;
    this.#set(
      { entries: entries.with(end - 1, entry), live: recipe },
      { type: 'splice', from: end, entries: [entry, ...entries.slice(end)], end },
    );
  }

  /** Show the state after entry `seq` (0 = the original), keeping the later entries. */
  goto(seq: number) {
    const { entries, end, live } = this.#state;
    const target = Math.max(0, Math.min(entries.length, seq));
    if (target === end && live === this.committed) return;
    this.#set({ end: target, live: this.recipeAt(target) }, { type: 'goto', end: target });
  }

  undo = () => this.goto(this.#state.end - 1);
  redo = () => this.goto(this.#state.end + 1);

  snapshot(): HistorySnapshot {
    const { entries, end } = this.#state;
    return { entries, end };
  }

  /** Go back to an earlier snapshot (to undo a truncation or a compression). */
  restore(snapshot: HistorySnapshot) {
    const { entries } = this.#state;
    let common = 0;
    while (common < entries.length && entries[common] === snapshot.entries[common]) common++;
    this.#last = null;
    this.#set(
      {
        entries: snapshot.entries,
        end: snapshot.end,
        live: snapshot.entries[snapshot.end - 1]?.recipe ?? this.original,
      },
      { type: 'splice', from: common + 1, entries: snapshot.entries.slice(common), end: snapshot.end },
    );
  }

  /** Collapse the history up to `end` into one entry per module instance (later entries are dropped). */
  compress() {
    const entries = compressHistory(this.original, this.#state.entries.slice(0, this.#state.end));
    this.#last = null;
    this.#set(
      { entries, end: entries.length, live: entries.at(-1)?.recipe ?? this.original },
      { type: 'splice', from: 1, entries, end: entries.length },
    );
  }
}

/**
 * One entry per module instance that differs from `original`, in the order of each
 * instance's last change. Each entry applies that instance's final state; the last
 * entry is the final recipe.
 */
export function compressHistory(original: EditParams, entries: readonly HistoryEntry[]): HistoryEntry[] {
  const final = entries.at(-1)?.recipe;
  if (!final) return [];
  const byId = (r: EditParams) => new Map(r.modules.map((m) => [m.id, m]));
  const initial = byId(original);
  const target = byId(final);

  // When each instance last changed (index of the entry).
  const lastChange = new Map<string, number>();
  let prev = initial;
  entries.forEach((e, i) => {
    const next = byId(e.recipe);
    for (const id of new Set([...prev.keys(), ...next.keys()])) {
      if (!same(prev.get(id), next.get(id))) lastChange.set(id, i);
    }
    prev = next;
  });
  const changed = [...lastChange].filter(([id]) => !same(initial.get(id), target.get(id))).sort((a, b) => a[1] - b[1]);

  const order = new Map(final.modules.map((m, i) => [m.id, i]));
  let modules: ModuleInstance[] = original.modules;
  const out: HistoryEntry[] = [];
  for (const [id, i] of changed) {
    const before: EditParams = { ...final, modules };
    const instance = target.get(id);
    modules = modules.filter((m) => m.id !== id);
    if (instance) {
      // Insert before the first instance that comes after it in the final recipe.
      const at = modules.findIndex((m) => (order.get(m.id) ?? Infinity) > order.get(id)!);
      modules = at < 0 ? [...modules, instance] : [...modules.slice(0, at), instance, ...modules.slice(at)];
    }
    const recipe = { ...final, modules };
    out.push({ label: describeChange(before, recipe).label, recipe, createdAt: entries[i]!.createdAt });
  }
  if (out.length) out[out.length - 1]!.recipe = final;
  // Only the order of instances changed: no instance differs, but the result does.
  else if (!same(original, final))
    out.push({ label: describeChange(original, final).label, recipe: final, createdAt: entries.at(-1)!.createdAt });
  return out;
}
