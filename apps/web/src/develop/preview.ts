import type { EditParams } from '@rawtisserie/pipeline';
import { useEffect, useRef } from 'react';
import { useStableCallback } from './useStableCallback.ts';

/** How long a preview stays after its menu item loses the highlight, ms. */
const PREVIEW_REVERT_MS = 150;

/**
 * Previews of menu items (presets, styles, LUTs): while one is highlighted, the image
 * shows it as a live change on top of the recipe from before the previews, which comes
 * back when the menu closes (`end`). `current` reads the recipe; `show` sets a live one.
 */
export function useRecipePreview(current: () => EditParams, show: (p: EditParams) => void) {
  const base = useRef<EditParams | null>(null);
  // Going from one item to the next un-highlights the first before highlighting the
  // next (and gaps or group labels can be in between): the recipe only comes back if
  // nothing else is highlighted for a moment, so previews follow each other directly.
  const revertTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(revertTimer.current), []);

  /** Show `change` applied to the recipe from before the previews; null: that recipe, shortly. */
  const preview = useStableCallback((change: ((p: EditParams) => EditParams) | null) => {
    clearTimeout(revertTimer.current);
    if (!change) {
      revertTimer.current = setTimeout(() => {
        if (base.current) show(base.current);
      }, PREVIEW_REVERT_MS);
      return;
    }
    base.current ??= current();
    show(change(base.current));
  });

  /** Ends the previews and returns the recipe from before them. */
  const end = useStableCallback(() => {
    clearTimeout(revertTimer.current);
    const before = base.current;
    base.current = null;
    if (before) show(before);
    return before ?? current();
  });

  return { preview, end };
}
