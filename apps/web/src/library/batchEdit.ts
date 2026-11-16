/**
 * Edit several versions' recipes from the library (roadmap 8.1): a preset or style
 * applied to a selection. Each version gets a history entry, so it can be undone there
 * (or all at once, with `undoBatchEdit`). The server re-renders their previews.
 */
import {
  type EditParams,
  type ModuleKind,
  type ModulePreset,
  type Style,
  applyModulePreset,
  applyStyle,
  findModule,
  forPhoto,
} from '@rawtisserie/pipeline';
import type { HistoryOp } from '../develop/history.ts';
import { MODULE_TITLES } from '../develop/changes.ts';
import { api } from '../api/client.ts';

/** A change to make to each recipe, and the label of its history entry. */
export interface BatchEdit {
  /** Identifies the edit (for caching its previews). */
  key: string;
  label: string;
  apply: (recipe: EditParams) => EditParams;
}

/** A style, each instance by its mode, or with `appendAll` all appended (Shift). */
export function styleEdit(style: Pick<Style, 'id' | 'name' | 'payload'>, appendAll = false): BatchEdit {
  return {
    key: `style:${style.id}:${appendAll ? 'append' : 'apply'}`,
    label: `Style: ${style.name}${appendAll ? ' (appended)' : ''}`,
    apply: (recipe) => applyStyle(recipe, style.payload, appendAll),
  };
}

/** A module preset, applied to the first instance of its kind (added if there's none, like in the developer). */
export function presetEdit(preset: ModulePreset): BatchEdit {
  const kind: ModuleKind = preset.moduleKind;
  return {
    key: `preset:${preset.id}`,
    label: `${MODULE_TITLES[kind]}: preset ${preset.name}`,
    apply: (recipe) => applyModulePreset(recipe, kind, findModule(recipe, kind)?.id ?? kind, preset.payload),
  };
}

interface CurrentRecipe {
  id: string;
  historyEnd: number;
  revision: number;
  recipe: EditParams;
  /** The photo's, if it isn't a RAW file: what its recipe may hold (`forPhoto`). */
  imageFormat?: string | null;
}

interface HistoryChange {
  id: string;
  baseRevision: number;
  ops: HistoryOp[];
}

interface BatchResult {
  applied: { id: string; historyEnd: number; revision: number }[];
  conflicts: string[];
}

/** What a batch edit did: the versions it changed (to undo it), and how many it couldn't. */
export interface BatchOutcome {
  edited: BatchResult['applied'];
  unchanged: number;
  /** New uploads not read yet (their starting recipe isn't known). */
  notReady: number;
  failed: number;
}

/** Versions per request: recipes with many retouch spots or masks are a few tens of KB. */
const CHUNK = 25;
/** Tries per version when it keeps changing elsewhere (e.g. open in a developer). */
const ATTEMPTS = 3;

/**
 * The change appending `edit` to a version's history, after its current entry (undone
 * entries are dropped, as in the developer). Null when it doesn't change the recipe.
 */
export function appendChange(current: CurrentRecipe, edit: BatchEdit): HistoryChange | null {
  // A style from a RAW file's recipe leaves out what a JPEG doesn't have.
  const recipe = forPhoto(edit.apply(current.recipe), current);
  if (JSON.stringify(recipe) === JSON.stringify(current.recipe)) return null;
  const end = current.historyEnd + 1;
  return {
    id: current.id,
    baseRevision: current.revision,
    ops: [
      { type: 'splice', from: end, entries: [{ label: edit.label, recipe, createdAt: new Date().toISOString() }], end },
    ],
  };
}

/** A version's current recipe, or null while it's being imported (its starting recipe isn't known). */
export async function fetchRecipe(id: string): Promise<EditParams | null> {
  const { versions } = await api.post<{ versions: CurrentRecipe[]; notReady: string[] }>('/api/versions/recipes', {
    ids: [id],
  });
  return versions[0]?.recipe ?? null;
}

const chunks = <T>(items: readonly T[]) =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

/** Apply `edit` to the versions `ids`, reporting progress as the number of versions done. */
export async function runBatchEdit(
  ids: readonly string[],
  edit: BatchEdit,
  onProgress?: (done: number) => void,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { edited: [], unchanged: 0, notReady: 0, failed: 0 };
  let done = 0;
  for (const chunk of chunks(ids)) {
    let pending: readonly string[] = chunk;
    for (let attempt = 0; attempt < ATTEMPTS && pending.length; attempt++) {
      const { versions, notReady } = await api.post<{ versions: CurrentRecipe[]; notReady: string[] }>(
        '/api/versions/recipes',
        { ids: pending },
      );
      outcome.notReady += notReady.length;
      const changes: HistoryChange[] = [];
      for (const v of versions) {
        const change = appendChange(v, edit);
        if (change) changes.push(change);
        else outcome.unchanged++;
      }
      // Gone since they were listed (deleted elsewhere).
      outcome.failed += pending.length - versions.length - notReady.length;
      if (!changes.length) {
        pending = [];
        break;
      }
      const result = await api.post<BatchResult>('/api/versions/history', { changes });
      outcome.edited.push(...result.applied);
      pending = result.conflicts;
    }
    outcome.failed += pending.length;
    done += chunk.length;
    onProgress?.(done);
  }
  return outcome;
}

/**
 * Undo a batch edit: step each version back over its entry (it stays, as a redo).
 * Versions edited since are left alone. Resolves to how many were undone.
 */
export async function undoBatchEdit(edited: BatchOutcome['edited']): Promise<number> {
  let undone = 0;
  for (const chunk of chunks(edited)) {
    const changes: HistoryChange[] = chunk.map((v) => ({
      id: v.id,
      baseRevision: v.revision,
      ops: [{ type: 'goto', end: v.historyEnd - 1 }],
    }));
    undone += (await api.post<BatchResult>('/api/versions/history', { changes })).applied.length;
  }
  return undone;
}
