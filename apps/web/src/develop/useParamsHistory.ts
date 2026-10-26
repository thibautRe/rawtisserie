import type { EditParams } from '@rawtisserie/pipeline';
import { useCallback, useState } from 'react';

interface History {
  past: EditParams[];
  present: EditParams;
  future: EditParams[];
  /** The value at the last commit; `present` may be a live (uncommitted) change. */
  committed: EditParams;
}

/**
 * Edit parameters with undo/redo. Live changes (slider drags) update `params`
 * immediately but only become an undo step once committed.
 */
export function useParamsHistory(initial: EditParams) {
  const [h, setH] = useState<History>({ past: [], present: initial, future: [], committed: initial });

  const setLive = useCallback((p: EditParams) => setH((h) => ({ ...h, present: p })), []);

  const commit = useCallback(
    (p?: EditParams) =>
      setH((h) => {
        const present = p ?? h.present;
        if (JSON.stringify(present) === JSON.stringify(h.committed)) return { ...h, present };
        return { past: [...h.past, h.committed].slice(-200), present, future: [], committed: present };
      }),
    [],
  );

  const undo = useCallback(
    () =>
      setH((h) => {
        const prev = h.past.at(-1);
        if (!prev) return h;
        return { past: h.past.slice(0, -1), present: prev, future: [h.committed, ...h.future], committed: prev };
      }),
    [],
  );

  const redo = useCallback(
    () =>
      setH((h) => {
        const [next, ...future] = h.future;
        if (!next) return h;
        return { past: [...h.past, h.committed], present: next, future, committed: next };
      }),
    [],
  );

  const reset = useCallback((p: EditParams) => setH({ past: [], present: p, future: [], committed: p }), []);

  return {
    params: h.present,
    setLive,
    commit,
    undo,
    redo,
    reset,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    /** A live change (e.g. a slider being dragged) has not been committed yet. */
    live: h.present !== h.committed,
  };
}
