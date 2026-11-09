import { useEffect, useRef, useState } from 'react';

/**
 * Whether Shift is held, while `active` (e.g. a menu is open), for menus whose items do
 * something else with Shift: their `onSelect` doesn't get the event. The ref is current
 * in event handlers; the state re-renders (to update a preview).
 */
export function useShiftKey(active: boolean) {
  const [held, setHeld] = useState(false);
  const ref = useRef(false);
  useEffect(() => {
    if (!active) return;
    const update = (e: KeyboardEvent | PointerEvent) => {
      ref.current = e.shiftKey;
      setHeld(e.shiftKey);
    };
    const events = ['keydown', 'keyup', 'pointerdown', 'pointermove'] as const;
    for (const type of events) window.addEventListener(type, update, true);
    return () => {
      for (const type of events) window.removeEventListener(type, update, true);
      ref.current = false;
      setHeld(false);
    };
  }, [active]);
  return { held, ref };
}
