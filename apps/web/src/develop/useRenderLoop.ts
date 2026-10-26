import type { EditParams } from '@rawtisserie/pipeline';
import { useEffect, useRef, useState } from 'react';
import type { Frame, PipelineClient } from './pipelineClient.ts';

interface Job {
  params: EditParams;
  width: number;
  height: number;
  /** Fraction of the display resolution being rendered (< 1 for drafts). */
  scale: number;
}

export interface ScaledFrame extends Frame {
  scale: number;
}

/**
 * Re-render whenever the parameters or the viewport change. At most one render is
 * in flight; changes made meanwhile are coalesced into a single follow-up render,
 * so dragging a slider never builds up a backlog.
 */
export function useRenderLoop(client: PipelineClient | null, job: Job | null) {
  const [frame, setFrame] = useState<ScaledFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = useRef<{ busy: boolean; next: Job | null }>({ busy: false, next: null });

  useEffect(() => {
    if (!client || !job || job.width < 1 || job.height < 1) return;
    const s = state.current;
    const run = async (j: Job) => {
      s.busy = true;
      try {
        setFrame({ ...(await client.render(j.params, j.width, j.height)), scale: j.scale });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        s.busy = false;
        const next = s.next;
        s.next = null;
        if (next) void run(next);
      }
    };
    if (s.busy) s.next = job;
    else void run(job);
  }, [client, job]);

  return { frame, error };
}
