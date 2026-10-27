import type { EditParams } from '@rawtisserie/pipeline';
import { useEffect, useRef, useState } from 'react';
import type { Frame, PipelineClient } from './pipelineClient.ts';
import type { Overlays } from './protocol.ts';

interface Job {
  params: EditParams;
  /** Bounds of the full-size render, in device pixels. */
  width: number;
  height: number;
  /** Fraction of the full size actually rendered (< 1 for drafts). */
  scale: number;
  overlays: Overlays;
}

/**
 * Re-render whenever the parameters or the viewport change. At most one render is
 * in flight; changes made meanwhile are coalesced into a single follow-up render,
 * so dragging a slider never builds up a backlog.
 */
export function useRenderLoop(client: PipelineClient | null, job: Job | null) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = useRef<{ busy: boolean; next: Job | null }>({ busy: false, next: null });

  useEffect(() => {
    if (!client || !job || job.width < 1 || job.height < 1) return;
    const s = state.current;
    const run = async (j: Job) => {
      s.busy = true;
      try {
        const full = { width: j.width, height: j.height };
        setFrame(await client.render(j.params, Math.floor(j.width * j.scale), Math.floor(j.height * j.scale), j.overlays, full));
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
