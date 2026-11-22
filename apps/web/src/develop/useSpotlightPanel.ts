import { useLayoutEffect, useRef, useState } from 'react';
import type { PanelFocus } from './ModulePanel.tsx';
import { type SpotlightResult, findTarget } from './Spotlight.tsx';
import { useStableCallback } from './useStableCallback.ts';

/**
 * The spotlight in the right panel (roadmap 2.6): open or not, what the panel shows
 * meanwhile, and closing it without moving anything. Closed on a module, the whole panel
 * comes back with that module where it was on screen, and what was named takes the
 * focus. Where the panel can't scroll that far (the first module, the last), empty space
 * is added above or below, and taken away once it's scrolled out of sight. Closed on
 * nothing, the panel goes back to where it was scrolled.
 */
export function useSpotlightPanel() {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<PanelFocus | null>(null);
  const aside = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const above = useRef<HTMLDivElement>(null);
  const below = useRef<HTMLDivElement>(null);
  const scrolled = useRef(0);
  const closing = useRef<{ result: SpotlightResult | null } | null>(null);

  const show = useStableCallback(() => {
    if (open) return;
    scrolled.current = aside.current?.scrollTop ?? 0;
    setOpen(true);
  });
  const onClose = useStableCallback((result: SpotlightResult | null) => {
    closing.current = { result };
    setOpen(false);
  });

  const space = (el: HTMLDivElement | null) => (el ? Number.parseFloat(el.style.height) || 0 : 0);

  // Before the whole panel is painted again.
  useLayoutEffect(() => {
    const done = closing.current;
    const box = aside.current;
    if (open || !done || !box) return;
    closing.current = null;
    const result = done.result;
    const block = result && box.querySelector<HTMLElement>(`[data-instance="${CSS.escape(result.id)}"]`);
    if (!result || !block) {
      box.scrollTop = scrolled.current;
      return;
    }
    let top = box.scrollTop + block.getBoundingClientRect().top - result.top;
    if (top < 0) {
      above.current!.style.height = `${space(above.current) - top}px`;
      top = 0;
    }
    const most = box.scrollHeight - box.clientHeight;
    if (top > most) below.current!.style.height = `${space(below.current) + top - most}px`;
    box.scrollTop = top;
    findTarget(block, result.target)?.focus.focus({ preventScroll: true });
  }, [open]);

  /** Empty space scrolled out of sight goes, without moving what's shown. */
  const onScroll = useStableCallback(() => {
    const box = aside.current;
    if (!box || open) return;
    const a = space(above.current);
    if (a && box.scrollTop >= a) {
      above.current!.style.height = '';
      box.scrollTop -= a;
    }
    const b = space(below.current);
    if (b && box.scrollTop + box.clientHeight <= box.scrollHeight - b) below.current!.style.height = '';
  });

  return { open, show, onClose, focus, setFocus, aside, panel, above, below, onScroll };
}
