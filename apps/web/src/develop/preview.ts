import type { EditParams } from '@rawtisserie/pipeline';
import { useEffect, useRef } from 'react';
import { useStableCallback } from './useStableCallback.ts';

/** How long a preview stays after its menu item loses the highlight, ms. */
const PREVIEW_REVERT_MS = 150;

/**
 * Previews of menu items (presets, styles, LUTs): while one is highlighted, the image
 * shows it as a live change on top of the recipe from before the previews, which comes
 * back when the menu closes (`end`). `current` reads the recipe; `show` sets a live one.
 *
 * Showing a recipe re-renders the panels that depend on it, which takes a while: it
 * waits until the highlighted item has been painted, so the menu answers the pointer at
 * once, and only the last of several quick highlights is shown.
 */
export function useRecipePreview(current: () => EditParams, show: (p: EditParams) => void) {
  const base = useRef<EditParams | null>(null);
  // Going from one item to the next un-highlights the first before highlighting the
  // next (and gaps or group labels can be in between): the recipe only comes back if
  // nothing else is highlighted for a moment, so previews follow each other directly.
  const revertTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The preview waiting for the next frame to be painted.
  const frame = useRef<number>(undefined);
  const paintedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = () => {
    clearTimeout(revertTimer.current);
    clearTimeout(paintedTimer.current);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  };
  useEffect(() => cancel, []);

  /** Show `change` applied to the recipe from before the previews; null: that recipe, shortly. */
  const preview = useStableCallback((change: ((p: EditParams) => EditParams) | null) => {
    cancel();
    if (!change) {
      revertTimer.current = setTimeout(() => {
        if (base.current) show(base.current);
      }, PREVIEW_REVERT_MS);
      return;
    }
    base.current ??= current();
    // The callback runs before the next paint, the timeout after it.
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      paintedTimer.current = setTimeout(() => {
        if (base.current) show(change(base.current));
      });
    });
  });

  /** Ends the previews and returns the recipe from before them. */
  const end = useStableCallback(() => {
    cancel();
    const before = base.current;
    base.current = null;
    if (before) show(before);
    return before ?? current();
  });

  /** The recipe previews are applied to: the one from before them. */
  const before = useStableCallback(() => base.current ?? current());

  return { preview, end, before };
}
