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

/**
 * One of the app's own shortcuts (written `Ctrl+Shift+D`, where Ctrl means Ctrl or ⌘:
 * both work everywhere) as the platform writes it: `⇧⌘D` on a Mac.
 */
export function commandLabel(keys: string, mac = MAC): string {
  if (!mac) return keys;
  const parts = keys.split('+');
  const key = parts.pop()!;
  const symbols = ['Alt', 'Shift', 'Ctrl'].filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]);
  return symbols.join('') + key;
}
const MAC_SYMBOLS: Record<string, string> = { Alt: '⌥', Shift: '⇧', Ctrl: '⌘' };

/** A shortcut as it's written: `Ctrl+Alt+O, Ctrl+Alt+A`. */
export const formatShortcut = (s: Shortcut) => s.map(formatKeyPress).join(', ');

// ── Matching ────────────────────────────────────────────────────────────────

const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'OS',
  'CapsLock',
  'Fn',
  'Hyper',
  'Super',
]);

/** The key press `e` is, or null for a modifier pressed alone. `key` is what it shows (filled in better when recording). */
export function pressOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>) {
  if (MODIFIER_KEYS.has(e.key) || !e.code) return null;
  return { code: e.code, key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

/** The same key with the same modifiers (whatever it shows: the layout doesn't matter). */
export const samePress = (a: KeyPress, b: KeyPress) =>
  a.code === b.code && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;

/** `s` starts with `prefix` (or is it). */
export const startsWith = (s: Shortcut, prefix: Shortcut) =>
  prefix.length <= s.length && prefix.every((p, i) => samePress(p, s[i]!));

/** How long a sequence waits for its next key. */
export const SEQUENCE_TIMEOUT = 1500;

export type MatchResult<T> =
  /** Not a shortcut's: the key does what it does. */
  | { type: 'none' }
  /** A sequence started or went on: nothing else happens, the next key is awaited. */
  | { type: 'pending'; sofar: Shortcut }
  | { type: 'match'; value: T }
  /** A sequence was going on and this key doesn't continue it: it does nothing. */
  | { type: 'cancelled' };

/**
 * Follows key presses through shortcuts that may be sequences (Ctrl+Alt+O, Ctrl+Alt+A).
 * A press starting one waits (`SEQUENCE_TIMEOUT`) for the next; while it waits, keys are
 * the sequence's, so a shortcut that's a single one of them doesn't fire.
 */
export class ShortcutMatcher<T> {
  #bindings: { shortcut: Shortcut; value: T }[];
  #sofar: Shortcut = [];
  #at = 0;
  constructor(bindings: { shortcut: Shortcut; value: T }[]) {
    this.#bindings = bindings;
  }

  get pending(): Shortcut | null {
    return this.#sofar.length ? this.#sofar : null;
  }

  reset() {
    this.#sofar = [];
  }

  feed(press: KeyPress, now = Date.now()): MatchResult<T> {
    const waited = this.#sofar.length > 0 && now - this.#at <= SEQUENCE_TIMEOUT;
    const sofar = [...(waited ? this.#sofar : []), press];
    const candidates = this.#bindings.filter((b) => startsWith(b.shortcut, sofar));
    const match = candidates.find((b) => b.shortcut.length === sofar.length);
    if (match) {
      this.#sofar = [];
      return { type: 'match', value: match.value };
    }
    if (candidates.length) {
      this.#sofar = sofar;
      this.#at = now;
      return { type: 'pending', sofar };
    }
    this.#sofar = [];
    return waited ? { type: 'cancelled' } : { type: 'none' };
  }
}

// ── Conflicts ───────────────────────────────────────────────────────────────

/** Keys the library and the loupe use alone (Shift too: `P` flags as `p` does), by what they show. */
const APP_KEYS = new Set([
  ...'0123456789pxutdeazi'.split(''),
  ' ',
  'enter',
  'escape',
  'delete',
  'backspace',
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'home',
  'end',
  'pageup',
  'pagedown',
  'tab',
]);
/** With Ctrl (⌘ on a Mac): select all, copy, paste, export, duplicate. */
const APP_CTRL_KEYS = new Set(['a', 'c', 'v', 'e', 'd']);
/** What browsers keep for themselves: a page never sees them. */
const BROWSER_CTRL_KEYS = new Set(['t', 'w', 'n', 'q', 'tab', 'l', 'r', 'f']);

/** The key, as the app's own shortcuts know it (by what it shows, lowercased). */
const keyName = (k: KeyPress) =>
  (k.code.startsWith('Key') && !/^[a-z]$/i.test(k.key) ? k.code.slice(3) : k.key).toLowerCase();

/** Why `first`, as a shortcut's first press, can't be used: the app or the browser has it. */
export function reservedPress(first: KeyPress): string | null {
  const name = keyName(first);
  const command = first.ctrl || first.meta;
  if (!command && !first.alt && APP_KEYS.has(name)) return `${formatKeyPress(first)} is one of the library’s keys`;
  if (command && !first.alt && APP_CTRL_KEYS.has(name)) return `${formatKeyPress(first)} is one of the library’s keys`;
  if (command && !first.alt && BROWSER_CTRL_KEYS.has(name)) return `The browser keeps ${formatKeyPress(first)}`;
  return null;
}

/**
 * Why `shortcut` can't be given to a tag, or null: the app's keys, or another tag's
 * shortcut being the same, starting it, or starting with it (one would never fire).
 */
export function shortcutConflict(
  shortcut: Shortcut,
  others: readonly { tag: string; shortcut: Shortcut | null }[],
  display: (tag: string) => string = (t) => t,
): string | null {
  const reserved = reservedPress(shortcut[0]!);
  if (reserved) return reserved;
  for (const o of others) {
    if (!o.shortcut) continue;
    if (startsWith(shortcut, o.shortcut) || startsWith(o.shortcut, shortcut))
      return `${display(o.tag)} has ${formatShortcut(o.shortcut)}${
        o.shortcut.length === shortcut.length ? '' : ': one would hide the other'
      }`;
  }
  return null;
}
