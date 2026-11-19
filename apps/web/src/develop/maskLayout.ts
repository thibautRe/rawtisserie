/**
 * Where the mask editor goes (roadmap 4.13, a prototype): four layouts to try side by
 * side before one is kept. `?masks=push` (or `overlay`, `accordion`, `inline`) picks one
 * for a tab, so several windows can show different ones; otherwise the last one picked
 * in the status bar, remembered.
 *
 * - `inline`: the editor under the module's settings, opened from its header (as 4.5 built it).
 * - `push`: a sidebar right of the modules, which move left (over the image on narrow windows).
 * - `overlay`: a sidebar over the modules, with a way back.
 * - `accordion`: a fold at the bottom of each maskable module, which opens under it.
 */
import { useSyncExternalStore } from 'react';

export type MaskLayout = 'inline' | 'push' | 'overlay' | 'accordion';

export const MASK_LAYOUTS: { value: MaskLayout; label: string; hint: string }[] = [
  { value: 'inline', label: 'Inline', hint: 'Under the module’s settings, opened from its header (as now)' },
  { value: 'push', label: 'Push', hint: 'A sidebar right of the modules, which move left' },
  { value: 'overlay', label: 'Overlay', hint: 'A sidebar over the modules' },
  { value: 'accordion', label: 'Accordion', hint: 'A fold at the bottom of each module' },
];

const KEY = 'developer.maskLayout';
const PARAM = 'masks';

const isLayout = (v: string | null): v is MaskLayout => MASK_LAYOUTS.some((l) => l.value === v);

function initial(): MaskLayout {
  try {
    const param = new URLSearchParams(window.location.search).get(PARAM);
    if (isLayout(param)) return param;
    const stored = localStorage.getItem(KEY);
    if (isLayout(stored)) return stored;
  } catch {
    // No storage: the default.
  }
  return 'inline';
}

let layout: MaskLayout | null = null;
const listeners = new Set<() => void>();

export function getMaskLayout(): MaskLayout {
  return (layout ??= initial());
}

/** Pick a layout: remembered, and in the tab's address if it named one. */
export function setMaskLayout(next: MaskLayout) {
  layout = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not remembered.
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has(PARAM)) {
    url.searchParams.set(PARAM, next);
    window.history.replaceState(window.history.state, '', url);
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useMaskLayout(): MaskLayout {
  return useSyncExternalStore(subscribe, getMaskLayout);
}
