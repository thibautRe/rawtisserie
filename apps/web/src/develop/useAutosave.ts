import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryWrite } from '../api/hooks.ts';
import { toaster } from '../components/toaster.tsx';
import type { HistoryOp, HistoryStore } from './history.ts';

/** Save this long after the last change. */
const DEBOUNCE_MS = 750;

export type SaveFn = (write: HistoryWrite, options?: { keepalive?: boolean }) => Promise<number>;

/**
 * - `saved`: nothing to save.
 * - `saving`: a change is waiting for the debounce or being sent.
 * - `error`: the last save failed; the next change (or `retry`) tries again.
 * - `conflict`: the version changed elsewhere; saving stops until a reload.
 */
export type SaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

/** Add `op` to the queue, merging it with the previous one when possible. */
function enqueue(queue: HistoryOp[], op: HistoryOp) {
  const tail = queue.at(-1);
  if (tail?.type === 'goto') {
    // A splice or goto sets `end` itself, and a goto changes nothing else.
    queue.pop();
    return enqueue(queue, op);
  }
  if (tail?.type === 'splice') {
    const count = tail.from - 1 + tail.entries.length;
    if (op.type === 'goto' && op.end <= count) {
      queue[queue.length - 1] = { ...tail, end: op.end };
      return;
    }
    if (op.type === 'splice' && op.from >= tail.from && op.from <= count + 1) {
      const entries = [...tail.entries.slice(0, op.from - tail.from), ...op.entries];
      queue[queue.length - 1] = { type: 'splice', from: tail.from, entries, end: op.end };
      return;
    }
  }
  queue.push(op);
}

/**
 * Mirror the history's changes on the server: debounced, merged, and sent as one
 * batch at a time. Pending changes are flushed on unmount and with `keepalive` when
 * the page is hidden or unloaded.
 */
export function useAutosave(store: HistoryStore, initialRevision: number, save: SaveFn | undefined) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const s = useRef({
    queue: [] as HistoryOp[],
    revision: initialRevision,
    inFlight: false,
    /** The in-flight save (it settles after its success or error handling). */
    request: null as Promise<void> | null,
    timer: 0,
    conflict: false,
    /** The developer was closed: saves carry on, but only a toast can report a failure. */
    left: false,
  }).current;

  const flush = useCallback(
    (keepalive = false) => {
      clearTimeout(s.timer);
      if (!save || s.conflict || s.inFlight) return;
      if (!s.queue.length) return setStatus('saved');
      setStatus('saving');
      const ops = s.queue;
      s.queue = [];
      s.inFlight = true;
      s.request = save({ ops, baseRevision: s.revision }, { keepalive }).then(
        (revision) => {
          s.inFlight = false;
          s.revision = revision;
          flush();
        },
        (err: unknown) => {
          s.inFlight = false;
          const rest = s.queue;
          s.queue = [];
          for (const op of [...ops, ...rest]) enqueue(s.queue, op);
          // Toasts are raised here rather than from an effect on `status`: the toaster's
          // state machine uses flushSync, which React refuses during a commit.
          if ((err as { status?: number }).status === 409) {
            s.conflict = true;
            setStatus('conflict');
            toaster.create({
              type: 'error',
              title: 'This version changed elsewhere',
              description: 'Reload to keep editing; your last change was not saved.',
              duration: Infinity,
              action: { label: 'Reload', onClick: () => location.reload() },
            });
          } else {
            setStatus('error');
            toaster.create({
              type: 'error',
              title: 'Could not save your last change',
              description: err instanceof Error ? err.message : undefined,
              duration: s.left ? Infinity : undefined,
              action: { label: 'Retry', onClick: () => flush() },
            });
          }
        },
      );
    },
    [s, save],
  );

  // Queue each change and debounce.
  useEffect(() => {
    if (!save) return;
    store.onOp = (op) => {
      enqueue(s.queue, op);
      if (s.conflict) return;
      setStatus('saving');
      clearTimeout(s.timer);
      s.timer = window.setTimeout(flush, DEBOUNCE_MS);
    };
    return () => {
      store.onOp = null;
    };
  }, [store, s, save, flush]);

  // Flush when leaving: hidden tab, page unload, or navigating away in the app.
  useEffect(() => {
    if (!save) return;
    s.left = false;
    const hidden = () => document.visibilityState === 'hidden' && flush(true);
    const unload = () => {
      if (s.conflict || !s.inFlight) return flush(true);
      // A save is in flight and the page is going away: send the rest now, assuming
      // the in-flight one succeeds (otherwise the server rejects this one with a 409).
      if (s.queue.length) save({ ops: s.queue, baseRevision: s.revision + 1 }, { keepalive: true }).catch(() => {});
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', unload);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', unload);
      s.left = true;
      flush();
    };
  }, [s, save, flush]);

  // Warn before leaving while changes aren't saved yet. Not after a conflict: they
  // can't be saved anyway, and the way out is the reload the toast offers.
  useEffect(() => {
    if (status === 'saved' || status === 'conflict') return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [status]);

  /** Save now and wait until everything is saved; rejects if something couldn't be. */
  const whenSaved = useCallback(async () => {
    flush();
    while (s.inFlight) await s.request;
    if (s.conflict || s.queue.length) throw new Error('Your last changes could not be saved');
  }, [s, flush]);

  return { status, flush: () => flush(), whenSaved };
}
