/** Keyboard shortcuts: what counts as typing (shortcuts stay out of it). */

const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** Whether keys pressed in `target` are typed text (a text field, not a checkbox). */
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    (target instanceof HTMLInputElement && !NOT_TYPED.has(target.type)));

/** One key press of a shortcut: the physical key (`code`, whatever the layout) and what it showed. */
export interface KeyPress {
  code: string;
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** A shortcut: one key press, or a sequence of them (Ctrl+Alt+O, Ctrl+Alt+A). */
export type Shortcut = KeyPress[];

const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

/** A key press as it's written: `Ctrl+Alt+O` (`⌘` on a Mac). */
export function formatKeyPress(k: KeyPress): string {
  const name = k.code.startsWith('Key')
    ? k.key.length === 1 && /\p{L}/u.test(k.key)
      ? k.key.toUpperCase()
      : k.code.slice(3)
    : k.code.startsWith('Digit')
      ? k.code.slice(5)
      : k.key.length === 1 && k.key !== ' '
        ? k.key.toUpperCase()
        : k.code;
  return [k.ctrl && 'Ctrl', k.alt && (MAC ? 'Option' : 'Alt'), k.shift && 'Shift', k.meta && (MAC ? '⌘' : 'Meta'), name]
    .filter(Boolean)
    .join('+');
}

/** A shortcut as it's written: `Ctrl+Alt+O, Ctrl+Alt+A`. */
export const formatShortcut = (s: Shortcut) => s.map(formatKeyPress).join(', ');
