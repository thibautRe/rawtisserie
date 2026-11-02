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
  | { type: 'autoTuneFilmic'; id: number; params: EditParams; maxWidth: number; maxHeight: number }
  | { type: 'detectIlluminant'; id: number; params: EditParams; instance: string; method: IlluminantDetection; maxWidth: number; maxHeight: number };

/** Colour calibration's auto-detection: grey world (textured surfaces) or grey edges. */
export type IlluminantDetection = 'surfaces' | 'edges';

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
      /** Ready to hand to the canvas without touching the pixels on the main thread. */
      bitmap: ImageBitmap;
      ms: number;
    }
  | { type: 'exported'; id: number; jpeg: ArrayBuffer; ms: number }
  | { type: 'autoTunedFilmic'; id: number; white: number | null; black: number | null; ms: number }
  | { type: 'detectedIlluminant'; id: number; xy: [number, number] | null; ms: number }
  | { type: 'error'; id: number; message: string };

/** From the pipeline worker to a worker of its pool (`pointPool.ts`). */
export type PointRequest =
  /** Rows of the spatial image (interleaved linear RGB f32); `asShot`: xy, or empty. */
  | { type: 'strip'; width: number; height: number; pixels: ArrayBuffer; asShot: number[] }
  /** Render the strip; `params` is the recipe as JSON. */
  | { type: 'render'; id: number; params: string };

export type PointResponse = { type: 'rendered'; id: number; data: ArrayBuffer } | { type: 'error'; id: number; message: string };

/** Clipping indicators painted over interactive renders (`ops/clipping.rs`). */
export interface Overlays {
  display?: { mode: ClipMode; upper?: number; lowerEv?: number } | null;
  sensor?: boolean;
  /** Diagonal stripes of this width (output pixels, fractional for drafts); 0 = solid colour. */
  stripes?: number;
}

export type ClipMode = 'anyChannel' | 'luminance' | 'saturation';
