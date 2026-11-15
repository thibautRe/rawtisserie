import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type KeyPress, SEQUENCE_TIMEOUT, ShortcutMatcher, formatShortcut, pressOf, shortcutConflict } from './keys.ts';

const k = (spec: string): KeyPress => {
  const parts = spec.split('+');
  const key = parts.at(-1)!;
  return {
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key,
    key: key.toLowerCase(),
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta: parts.includes('Meta'),
  };
};
const s = (...specs: string[]) => specs.map(k);

test('a sequence waits for its next key, and keys meanwhile are its own', () => {
  const m = new ShortcutMatcher([
    { shortcut: s('Ctrl+Alt+O', 'Ctrl+Alt+A'), value: 'People|Atlas' },
    { shortcut: s('Ctrl+Alt+O', 'Ctrl+Alt+N'), value: 'People|Nova' },
    { shortcut: s('Ctrl+Alt+G'), value: 'People|Gwen' },
  ]);
  assert.deepEqual(m.feed(k('Ctrl+Alt+O'), 0), { type: 'pending', sofar: s('Ctrl+Alt+O') });
  // Ctrl+Alt+G would be Gwen's, but a sequence is going on and it doesn't continue it.
  assert.deepEqual(m.feed(k('Ctrl+Alt+G'), 100), { type: 'cancelled' });
  assert.deepEqual(m.feed(k('Ctrl+Alt+G'), 200), { type: 'match', value: 'People|Gwen' });
  m.feed(k('Ctrl+Alt+O'), 1000);
  assert.deepEqual(m.feed(k('Ctrl+Alt+N'), 1500), { type: 'match', value: 'People|Nova' });
  // Too late: the sequence was forgotten, and the key alone isn't a shortcut.
  m.feed(k('Ctrl+Alt+O'), 5000);
  assert.deepEqual(m.feed(k('Ctrl+Alt+A'), 5001 + SEQUENCE_TIMEOUT), { type: 'none' });
  assert.deepEqual(m.feed(k('p'), 9000), { type: 'none' });
});

test('the physical key counts, whatever the layout shows', () => {
  const m = new ShortcutMatcher([{ shortcut: s('Ctrl+Alt+O'), value: 1 }]);
  // Ctrl+Alt is AltGr on Windows: the key shows `œ`, it's still KeyO.
  const press = pressOf({ key: 'œ', code: 'KeyO', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })!;
  assert.deepEqual(m.feed(press), { type: 'match', value: 1 });
  assert.equal(
    pressOf({ key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }),
    null,
  );
});

test("a shortcut can't take the app's keys, or hide another tag's", () => {
  const others = [{ tag: 'People|Nova', shortcut: s('Ctrl+Alt+O', 'Ctrl+Alt+N') }];
  assert.equal(shortcutConflict(s('Ctrl+Alt+O', 'Ctrl+Alt+A'), others), null);
  assert.equal(
    shortcutConflict(s('Ctrl+Alt+O'), others),
    'People|Nova has Ctrl+Alt+O, Ctrl+Alt+N: one would hide the other',
  );
  assert.equal(shortcutConflict(s('Ctrl+Alt+O', 'Ctrl+Alt+N'), others), 'People|Nova has Ctrl+Alt+O, Ctrl+Alt+N');
  assert.equal(shortcutConflict(s('p'), []), 'P is one of the library’s keys');
  assert.equal(shortcutConflict(s('Shift+p'), []), 'Shift+P is one of the library’s keys');
  assert.equal(shortcutConflict(s('Ctrl+c'), []), 'Ctrl+C is one of the library’s keys');
  assert.equal(shortcutConflict(s('Ctrl+t'), []), 'The browser keeps Ctrl+T');
  // Keys the app doesn't use alone are fine, and so is anything with Alt.
  assert.equal(shortcutConflict(s('g'), []), null);
  assert.equal(shortcutConflict(s('Alt+p'), []), null);
  assert.equal(formatShortcut(s('Ctrl+Alt+O', 'Ctrl+Alt+A')), 'Ctrl+Alt+O, Ctrl+Alt+A');
});
