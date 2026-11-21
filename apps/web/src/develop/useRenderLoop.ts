import type { EditParams } from '@rawtisserie/pipeline';
import { useEffect, useRef, useState } from 'react';
import type { Frame, RenderBackend } from './renderBackend.ts';
import type { Overlays, Region } from './protocol.ts';
import type { ScopeRequest } from './scopes.ts';

export interface Job {
  params: EditParams;
  /** Bounds of the full-size render, in device pixels. */
  width: number;
  height: number;
  /** Only this part of the full-size render (a zoomed-in view). */
  region?: Region | null;
  /** Fraction of the full size actually rendered (< 1 for drafts). */
  scale: number;
  overlays: Overlays;
  /** A scope to draw from the render. */
  scope?: ScopeRequest | null;
  /** A compared recipe (`RenderBackend.render`'s `compare`). */
  compare?: boolean;
}

/**
 * Re-render whenever the parameters or the viewport change. At most one render is
 * in flight; changes made meanwhile are coalesced into a single follow-up render,
 * so dragging a slider never builds up a backlog.
 */
export function useRenderLoop(backend: RenderBackend | null, job: Job | null) {
  /** The last frame, and the job it was rendered for. */
  const [shown, setShown] = useState<{ frame: Frame; job: Job } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = useRef<{ busy: boolean; next: Job | null }>({ busy: false, next: null });

  useEffect(() => {
    if (!backend || !job || job.width < 1 || job.height < 1) return;
    const s = state.current;
    const run = async (j: Job) => {
      s.busy = true;
      try {
        const full = { width: j.width, height: j.height, region: j.region };
        const frame = await backend.render(
          j.params,
          Math.floor(j.width * j.scale),
          Math.floor(j.height * j.scale),
          j.overlays,
          full,
          j.region && scaleRegion(j.region, j.scale),
          j.scope,
          j.compare,
        );
        setShown({ frame, job: j });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // Nothing more is coming for this job.
        setShown((prev) => prev && { frame: prev.frame, job: j });
      } finally {
        s.busy = false;
        const next = s.next;
        s.next = null;
        if (next) void run(next);
      }
    };
    if (s.busy) s.next = job;
    else void run(job);
  }, [backend, job]);

  // Whether the frame doesn't show the latest job yet (rendering, or queued).
  const pending = !!job && shown?.job !== job;
  return { frame: shown?.frame ?? null, error, pending };
}

/** `r` of a render, in a render `scale` times its size (rounded outwards). */
function scaleRegion(r: Region, scale: number): Region {
  if (scale === 1) return r;
  const x = Math.floor(r.x * scale);
  const y = Math.floor(r.y * scale);
  return { x, y, width: Math.ceil((r.x + r.width) * scale) - x, height: Math.ceil((r.y + r.height) * scale) - y };
}
