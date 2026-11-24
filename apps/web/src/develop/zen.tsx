/**
 * The developer's distraction-free view: everything but the image is hidden, without
 * moving or resizing it (nothing renders again). Hidden things keep their place
 * (`visibility`, for all under them): mark them with `ZEN_HIDE`, anywhere on the page
 * (the film roll is outside the developer). `useZen` marks the page (`html[data-zen]`),
 * which `ZEN_CSS` (global) reads.
 *
 * Pressed (H, or the status bar's button), everything goes, the button too; released
 * after a hold (`HOLD_MS`), it all comes back. Released sooner, a click: the view stays
 * ("sticky"), with the button back alone to end it (or H, or Esc).
 */
import { IconButton } from '@chakra-ui/react';
import { Eye, EyeOff } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { isTyping } from '../lib/keys.ts';

/** `pressed`: held down (all hidden), `sticky`: hidden after a click, the button left. */
export type ZenState = 'off' | 'pressed' | 'sticky';

/** Past this, a press is a hold: the view comes back on release. */
export const HOLD_MS = 300;

/** Put on what the view hides. */
export const ZEN_HIDE = { 'data-zen-hide': '' } as const;

/**
 * Global CSS (theme): what's marked hides, all under it too (some parts set their own
 * visibility, as sliders' thumbs do), but the button while it shows (`data-zen-keep`);
 * the page takes the image's background.
 */
export const ZEN_CSS = {
  'html[data-zen] body': { bg: 'canvas' },
  'html[data-zen] [data-zen-hide]': { visibility: 'hidden' },
  'html[data-zen] [data-zen-hide] *': { visibility: 'hidden !important' },
  'html[data-zen] [data-zen-hide] [data-zen-keep]': { visibility: 'visible !important' },
  'html[data-zen] [data-zen-hide] [data-zen-keep] *': { visibility: 'visible !important' },
};

/** The view's state, and the press handlers of its button. Listens to H (and Esc while it sticks). */
export function useZen() {
  const [state, setState] = useState<ZenState>('off');
  const current = useRef(state);
  current.current = state;
  const press = useRef<{ at: number; from: ZenState } | null>(null);

  const start = useCallback(() => {
    if (press.current) return;
    press.current = { at: performance.now(), from: current.current };
    setState('pressed');
  }, []);
  const end = useCallback(() => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    // A click ends a sticky view, or starts one; a hold was a peek.
    setState(p.from === 'off' && performance.now() - p.at < HOLD_MS ? 'sticky' : 'off');
  }, []);
  const off = useCallback(() => {
    press.current = null;
    setState('off');
  }, []);

  useEffect(() => {
    // First (capture), so that Esc ending the view doesn't also leave the developer.
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        if (!e.repeat) start();
      } else if (e.key === 'Escape' && current.current === 'sticky') {
        e.preventDefault();
        off();
      }
    };
    const up = (e: KeyboardEvent) => e.key.toLowerCase() === 'h' && end();
    // A key released elsewhere never comes back.
    const blur = () => press.current && off();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [start, end, off]);

  useEffect(() => {
    if (state === 'off') delete document.documentElement.dataset.zen;
    else document.documentElement.dataset.zen = state;
  }, [state]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.zen;
    },
    [],
  );

  return { state, start, end };
}

/** The status bar's button. It stays when the view sticks, to end it. */
export const ZenButton = memo(function ZenButton({
  state,
  onStart,
  onEnd,
}: {
  state: ZenState;
  onStart: () => void;
  onEnd: () => void;
}) {
  return (
    <IconButton
      size="2xs"
      variant={state === 'sticky' ? 'subtle' : 'ghost'}
      aria-label={state === 'sticky' ? 'Show the interface (H)' : 'Hide the interface (H)'}
      aria-pressed={state !== 'off'}
      title="Distraction-free: press to hide everything but the image, hold to peek (H)"
      data-zen-keep={state === 'sticky' ? '' : undefined}
      boxShadow={state === 'sticky' ? 'md' : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        onStart();
        // On the window: the button may be hidden meanwhile.
        const release = () => {
          window.removeEventListener('pointerup', release);
          window.removeEventListener('pointercancel', release);
          onEnd();
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
      }}
      onKeyDown={(e) => {
        // Keyboard users: Enter or Space toggles it (H holds it).
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onStart();
        onEnd();
      }}
    >
      {state === 'sticky' ? <Eye /> : <EyeOff />}
    </IconButton>
  );
});
