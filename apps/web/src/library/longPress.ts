/**
 * Long presses on the grid's cards (phones, roadmap 10.1: a tap opens the loupe, a long
 * press selects). One press at a time, so module state: the cards are many and memoised.
 * Scrolling cancels a press (the browser sends `pointercancel`), as does moving the finger.
 */
export const LONG_PRESS_MS = 450;
/** Finger travel (CSS px) that makes it a drag rather than a press. */
const SLOP = 10;

let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
/** The press that just fired: the click that follows it is swallowed. */
let fired = false;

export function pressStart(e: React.PointerEvent, onLongPress: () => void) {
  pressCancel();
  fired = false;
  if (e.button !== 0) return;
  const timer = setTimeout(() => {
    press = null;
    fired = true;
    navigator.vibrate?.(10);
    onLongPress();
  }, LONG_PRESS_MS);
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer };
}

export function pressMove(e: React.PointerEvent) {
  if (press?.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) pressCancel();
}

export function pressCancel() {
  if (press) clearTimeout(press.timer);
  press = null;
}

/** Whether a long press is under way or just fired (its context menu, its click). */
export const pressing = () => press !== null || fired;

/** For the click after a press: true (once) when it was a long press. */
export function consumeLongPress(): boolean {
  const was = fired;
  fired = false;
  return was;
}
