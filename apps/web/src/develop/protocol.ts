import type { EditParams, PhotoMetadata, SensorMapping } from '@rawtisserie/pipeline';
import type { ScopeMode, ScopeRequest } from './scopes.ts';

/** A part of a render, in its output pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a render sits in the whole image fitted within its bounds. */
export interface Placement extends Region {
  /** Size of the whole fitted image. */
  frameWidth: number;
  frameHeight: number;
}

export type WorkerRequest =
  | { type: 'load'; id: number; bytes: ArrayBuffer }
  | {
      type: 'render';
      id: number;
      params: EditParams;
      maxWidth: number;
      maxHeight: number;
      /** Render only this part of the image fitted within the bounds (a zoomed-in view). */
      region: Region | null;
      /** Bounds and region of the full-size render, when this one is a reduced draft. */
      fullWidth: number;
      fullHeight: number;
      fullRegion: Region | null;
      overlays: Overlays;
      /** Also draw this scope of the render (`scopes.ts`), without the overlays. */
      scope: ScopeRequest | null;
    }
  | { type: 'export'; id: number; params: EditParams; maxSize: number; quality: number }
  | { type: 'autoTuneFilmic'; id: number; params: EditParams; maxWidth: number; maxHeight: number }
  | {
      type: 'detectIlluminant';
      id: number;
      params: EditParams;
      instance: string;
      method: IlluminantDetection;
      maxWidth: number;
      maxHeight: number;
    };

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
      /** Where the full-size render sits in its image. */
      placement: Placement;
      /** Size of the (cropped) image at full resolution. */
      sourceWidth: number;
      sourceHeight: number;
      /** How the rendered image maps to the sensor frame, where shapes live. */
      mapping: SensorMapping;
      /** Ready to hand to the canvas without touching the pixels on the main thread. */
      bitmap: ImageBitmap;
      /** The scope asked for, if any. */
      scope: { mode: ScopeMode; bitmap: ImageBitmap } | null;
      ms: number;
    }
  | { type: 'exported'; id: number; jpeg: ArrayBuffer; ms: number }
  | { type: 'autoTunedFilmic'; id: number; white: number | null; black: number | null; ms: number }
  | { type: 'detectedIlluminant'; id: number; xy: [number, number] | null; ms: number }
  | { type: 'error'; id: number; message: string };

/** From the pipeline worker to a worker of its pool (`pointPool.ts`). */
export type PointRequest =
  /**
   * Rows of the spatial image (interleaved linear RGB f32); `asShot`: xy, or empty;
   * `masks`: the drawn planes of the masks over the same rows, one after the other, for
   * the instances `maskIds` (JSON array).
   */
  | {
      type: 'strip';
      width: number;
      height: number;
      pixels: ArrayBuffer;
      asShot: number[];
      maskIds: string;
      masks: ArrayBuffer;
    }
  /** Render the strip; `params` is the recipe as JSON. */
  | { type: 'render'; id: number; params: string };

export type PointResponse =
  { type: 'rendered'; id: number; data: ArrayBuffer } | { type: 'error'; id: number; message: string };

/** Clipping indicators painted over interactive renders (`ops/clipping.rs`). */
export interface Overlays {
  display?: { mode: ClipMode; upper?: number; lowerEv?: number } | null;
  sensor?: boolean;
  /** Diagonal stripes of this width (output pixels, fractional for drafts); 0 = solid colour. */
  stripes?: number;
  /** Show where the instance with this id applies (its mask), in yellow, or what `maskView` says. */
  mask?: string | null;
  maskView?: MaskView;
}

/** What the mask overlay shows of a mask (`clipping::MaskView`). */
export interface MaskView {
  /** The whole mask, or one of its ranges alone. */
  part: 'mask' | 'luminance' | 'saturation' | 'hue' | 'red' | 'green' | 'blue';
  /** The values the part measures on the module's input, in its slider's colours, instead of where it applies. */
  values: boolean;
}

export type ClipMode = 'anyChannel' | 'luminance' | 'saturation';
