/** Keyboard shortcuts: what counts as typing (shortcuts stay out of it). */

const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** Whether keys pressed in `target` are typed text (a text field, not a checkbox). */
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    (target instanceof HTMLInputElement && !NOT_TYPED.has(target.type)));
