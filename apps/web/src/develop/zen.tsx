/**
 * The developer's distraction-free view: everything but the image is hidden, without
 * moving or resizing it (nothing renders again). Hidden things keep their place
 * (`visibility`, for all under them): mark them with `ZEN_HIDE`, under the element
 * `zenRoot` styles.
 *
 * Held (H, or the status bar's button): hidden while pressed, back on release. A short
 * press keeps it hidden ("sticky"), with the button still there to bring it back (or H,
 * or Esc). While a press is short, the button stays; held past `HOLD_MS`, it goes too.
 */
import { IconButton } from '@chakra-ui/react';
import { Eye, EyeOff } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { isTyping } from '../lib/keys.ts';

export type ZenState = 'off' | 'pressing' | 'peek' | 'sticky';

/** Past this, a press is a hold: the view comes back on release. */
export const HOLD_MS = 300;

/** Put on what the view hides. */
export const ZEN_HIDE = { 'data-zen-hide': '' } as const;

/** Props for the element holding everything the view hides: it hides them, on the image's background. */
export const zenRoot = (state: ZenState) => ({
  'data-zen': state,
  bg: state === 'off' ? undefined : 'canvas',
  // Everything under them: some parts set their own visibility (sliders' thumbs). But the
  // button, while it shows (`data-zen-keep`).
  css: {
    '&:not([data-zen="off"]) [data-zen-hide]': { visibility: 'hidden' },
    '&:not([data-zen="off"]) [data-zen-hide] *': { visibility: 'hidden !important' },
    '&:not([data-zen="off"]) [data-zen-hide] [data-zen-keep]': { visibility: 'visible !important' },
    '&:not([data-zen="off"]) [data-zen-hide] [data-zen-keep] *': { visibility: 'visible !important' },
  },
});

/** The view's state, and the press handlers of its button. Listens to H (and Esc while it sticks). */
export function useZen() {
  const [state, setState] = useState<ZenState>('off');
  const current = useRef(state);
  current.current = state;
  const press = useRef<{ at: number; from: ZenState; timer: number } | null>(null);

  const start = useCallback(() => {
    if (press.current) return;
    const from = current.current;
    // Sticking: this press ends it.
    const timer =
      from === 'sticky' ? 0 : window.setTimeout(() => setState((s) => (s === 'pressing' ? 'peek' : s)), HOLD_MS);
    press.current = { at: performance.now(), from, timer };
    if (from !== 'sticky') setState('pressing');
  }, []);
  const end = useCallback(() => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    clearTimeout(p.timer);
    setState(p.from === 'sticky' || performance.now() - p.at >= HOLD_MS ? 'off' : 'sticky');
  }, []);
  const off = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
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

  return { state, start, end };
}

/**
 * The status bar's button. It stays visible while the view hides the rest (but when held
 * past `HOLD_MS`), to bring it back.
 */
export const ZenButton = memo(function ZenButton({
  state,
  onStart,
  onEnd,
}: {
  state: ZenState;
  onStart: () => void;
  onEnd: () => void;
}) {
  const shown = state === 'pressing' || state === 'sticky';
  return (
    <IconButton
      size="2xs"
      variant={state === 'sticky' ? 'subtle' : 'ghost'}
      aria-label={state === 'sticky' ? 'Show the interface (H)' : 'Hide the interface (H)'}
      aria-pressed={state !== 'off'}
      title="Distraction-free: press to hide everything but the image, hold to peek (H)"
      data-zen-keep={shown ? '' : undefined}
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
