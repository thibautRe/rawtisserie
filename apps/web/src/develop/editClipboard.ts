/**
 * Copy and paste edits (roadmap 8.6): a copy is a style that isn't saved, kept in the
 * tab's session storage so that it goes between the library and the developer. Pasting
 * applies it like a style (`applyStyle`): each instance by its mode, or all appended.
 */
import {
  type EditParams,
  type ModuleKind,
  type StyleMode,
  type StylePayload,
  normalizeStyle,
  styleFromRecipe,
} from '@rawtisserie/pipeline';
import { useSyncExternalStore } from 'react';
import { type BatchEdit, styleEdit } from '../library/batchEdit.ts';
import type { StyleSelection } from './presets.tsx';

export interface EditClipboard {
  payload: StylePayload;
  /** The file it was copied from, for the history entry ("Paste from DSC01234"). */
  source: string;
  /** When it was copied (ms): tells copies apart, e.g. for cached previews. */
  copiedAt: number;
}

const KEY = 'edit.clipboard';
const PICK_KEY = 'edit.copyPick';

/** Kinds not copied unless picked: they belong to the image they were made for. */
export const COPY_EXCLUDED: readonly ModuleKind[] = ['geometry', 'retouch', 'lens'];

const listeners = new Set<() => void>();
let cached: { raw: string | null; value: EditClipboard | null } = { raw: null, value: null };

function read(): EditClipboard | null {
  const raw = sessionStorage.getItem(KEY);
  if (raw === cached.raw) return cached.value;
  let value: EditClipboard | null = null;
  try {
    const parsed = JSON.parse(raw ?? 'null') as Partial<EditClipboard> | null;
    if (parsed && typeof parsed.source === 'string' && typeof parsed.copiedAt === 'number') {
      value = { payload: normalizeStyle(parsed.payload), source: parsed.source, copiedAt: parsed.copiedAt };
    }
  } catch {
    // Unreadable: nothing to paste.
  }
  cached = { raw, value };
  return value;
}

export function readClipboard(): EditClipboard | null {
  return read();
}

/** The current copy, re-rendering when it changes. */
export function useClipboard(): EditClipboard | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => null,
  );
}

/** Put some of a recipe's instances on the clipboard. Returns how many. */
export function copyEdits(recipe: EditParams, selection: StyleSelection, source: string): number {
  const payload = styleFromRecipe(recipe, selection.ids, selection);
  const clip: EditClipboard = { payload, source, copiedAt: Date.now() };
  sessionStorage.setItem(KEY, JSON.stringify(clip));
  for (const listener of listeners) listener();
  return payload.modules.length;
}

/**
 * What was picked the last time the copy dialog was used, by instance id (ids follow the
 * kind, so they mostly match between photos): instances it didn't see get the default.
 */
interface LastPick {
  picked: string[];
  unpicked: string[];
  modes: Record<string, StyleMode>;
  groups: Record<string, string[]>;
  autoTune?: Record<string, boolean>;
}

export function rememberPick(recipe: EditParams, selection: StyleSelection) {
  const pick: LastPick = {
    picked: [...selection.ids],
    unpicked: recipe.modules.map((m) => m.id).filter((id) => !selection.ids.includes(id)),
    modes: { ...selection.modes },
    groups: Object.fromEntries(Object.entries(selection.groups).map(([id, g]) => [id, [...g]])),
    autoTune: { ...selection.autoTune },
  };
  localStorage.setItem(PICK_KEY, JSON.stringify(pick));
}

/** The default picks (enabled instances, without `COPY_EXCLUDED`), with what was picked last time. */
export function lastSelection(recipe: EditParams): StyleSelection {
  let last: Partial<LastPick> = {};
  try {
    last = (JSON.parse(localStorage.getItem(PICK_KEY) ?? '{}') as Partial<LastPick> | null) ?? {};
  } catch {
    // Unreadable: the defaults.
  }
  const ids = recipe.modules
    .filter((m) =>
      last.picked?.includes(m.id)
        ? true
        : last.unpicked?.includes(m.id)
          ? false
          : m.enabled && !COPY_EXCLUDED.includes(m.kind),
    )
    .map((m) => m.id);
  const only = <T>(record: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => ids.includes(id)));
  return { ids, modes: only(last.modes), groups: only(last.groups), autoTune: only(last.autoTune) };
}

/** Pasting the clipboard, each instance by its mode or, with `appendAll`, all appended. */
export function pasteEdit(clip: EditClipboard, appendAll = false): BatchEdit {
  const edit = styleEdit({ id: `paste:${clip.copiedAt}`, name: '', payload: clip.payload }, appendAll);
  return { ...edit, label: `Paste from ${clip.source}${appendAll ? ' (appended)' : ''}` };
}

/** The file name without its extension, as history entries show it. */
export const sourceName = (filename: string) => filename.replace(/\.[^.]+$/, '');
