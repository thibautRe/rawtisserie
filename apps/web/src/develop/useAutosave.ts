import type { EditParams } from '@rawtisserie/pipeline';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryWrite } from '../api/hooks.ts';
import { toaster } from '../components/toaster.tsx';
import { describeChange } from './changes.ts';

/** Save this long after the last committed change. */
const DEBOUNCE_MS = 750;
/** Successive changes to the same module instance within this window share one history entry. */
const COALESCE_MS = 30_000;

export type SaveFn = (write: HistoryWrite, options?: { keepalive?: boolean }) => Promise<number>;

/**
 * - `saved`: nothing to save.
 * - `saving`: a change is waiting for the debounce or being sent.
 * - `error`: the last save failed; the next change (or `retry`) tries again.
 * - `conflict`: the version changed elsewhere; saving stops until a reload.
 */
export type SaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

interface LastEntry {
  moduleId: string;
  /** The recipe before this entry, to label it when a later change replaces it. */
  before: EditParams;
  createdAt: number;
}

const same = (a: EditParams, b: EditParams) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Save each committed recipe as a history entry, debounced, one request at a time.
 * Changes to the same module instance within `COALESCE_MS` replace the entry this
 * hook last wrote instead of appending. Pending changes are flushed on unmount and
 * with `keepalive` when the page is hidden or unloaded.
 */
export function useAutosave(recipe: EditParams, initialRevision: number, save: SaveFn | undefined) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const s = useRef({
    latest: recipe,
    saved: recipe,
    revision: initialRevision,
    last: null as LastEntry | null,
    inFlight: null as EditParams | null,
    timer: 0,
    conflict: false,
  }).current;

  const write = useCallback(
    (target: EditParams, base: EditParams, baseRevision: number, keepalive: boolean, coalesce = true) => {
      const change = describeChange(base, target);
      const now = Date.now();
      const last = coalesce ? s.last : null;
      const replace = !!last && change.moduleId === last.moduleId && now - last.createdAt < COALESCE_MS;
      const label = replace ? describeChange(last.before, target).label : change.label;
      const entry = replace ? last : change.moduleId ? { moduleId: change.moduleId, before: base, createdAt: now } : null;
      return { request: save!({ recipe: target, label, baseRevision, replace }, { keepalive }), entry };
    },
    [s, save],
  );

  const flush = useCallback(
    (keepalive = false) => {
      clearTimeout(s.timer);
      if (!save || s.conflict || s.inFlight) return;
      const target = s.latest;
      if (same(target, s.saved)) return setStatus('saved');
      setStatus('saving');
      s.inFlight = target;
      const { request, entry } = write(target, s.saved, s.revision, keepalive);
      request.then(
        (revision) => {
          s.inFlight = null;
          s.revision = revision;
          s.saved = target;
          s.last = entry;
          flush();
        },
        (err: unknown) => {
          s.inFlight = null;
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
              action: { label: 'Retry', onClick: () => flush() },
            });
          }
        },
      );
    },
    [s, save, write],
  );

  // Debounce committed changes.
  useEffect(() => {
    s.latest = recipe;
    if (!save || s.conflict) return;
    if (same(recipe, s.saved) && !s.inFlight) {
      clearTimeout(s.timer);
      setStatus('saved');
      return;
    }
    setStatus('saving');
    clearTimeout(s.timer);
    s.timer = window.setTimeout(flush, DEBOUNCE_MS);
  }, [recipe, s, save, flush]);

  // Flush when leaving: hidden tab, page unload, or navigating away in the app.
  useEffect(() => {
    if (!save) return;
    const hidden = () => document.visibilityState === 'hidden' && flush(true);
    const unload = () => {
      if (s.conflict || !s.inFlight) return flush(true);
      // A save is in flight and the page is going away: send the rest now, assuming
      // the in-flight one succeeds (otherwise the server rejects this one with a 409).
      if (!same(s.latest, s.inFlight)) write(s.latest, s.inFlight, s.revision + 1, true, false).request.catch(() => {});
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', unload);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', unload);
      flush();
    };
  }, [s, save, flush, write]);

  // Warn before leaving while changes aren't saved yet. Not after a conflict: they
  // can't be saved anyway, and the way out is the reload the toast offers.
  useEffect(() => {
    if (status === 'saved' || status === 'conflict') return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [status]);

  return { status, flush: () => flush() };
}
