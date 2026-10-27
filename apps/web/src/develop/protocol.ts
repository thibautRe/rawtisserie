import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export type WorkerRequest =
  | { type: 'load'; id: number; bytes: ArrayBuffer }
  | {
      type: 'render';
      id: number;
      params: EditParams;
      maxWidth: number;
      maxHeight: number;
      /** Bounds of the full-size render, when this one is a reduced draft. */
      fullWidth: number;
      fullHeight: number;
      overlays: Overlays;
    }
  | { type: 'export'; id: number; params: EditParams; maxSize: number; quality: number }
  | { type: 'autoTuneFilmic'; id: number; params: EditParams; maxWidth: number; maxHeight: number };

export type WorkerResponse =
  | { type: 'loaded'; id: number; metadata: PhotoMetadata; ms: number }
  | {
      type: 'rendered';
      id: number;
      width: number;
      height: number;
      /** Size of the full-size render: what a draft stands in for. */
      fullWidth: number;
      fullHeight: number;
      data: ArrayBuffer;
      ms: number;
    }
  | { type: 'exported'; id: number; jpeg: ArrayBuffer; ms: number }
  | { type: 'autoTunedFilmic'; id: number; white: number | null; black: number | null; ms: number }
  | { type: 'error'; id: number; message: string };

/** Clipping indicators painted over interactive renders (`ops/clipping.rs`). */
export interface Overlays {
  display?: { mode: ClipMode; upper?: number; lowerEv?: number } | null;
  sensor?: boolean;
  /** Diagonal stripes of this width (output pixels, fractional for drafts); 0 = solid colour. */
  stripes?: number;
}

export type ClipMode = 'anyChannel' | 'luminance' | 'saturation';
