import type { EditParams } from '@rawtisserie/pipeline';
import type { IlluminantDetection, Overlays, Placement, Region } from './protocol.ts';

export interface Frame {
  /** Transferred to the canvas when shown (`transferFromImageBitmap`), so shown once. */
  image: ImageBitmap;
  /** Size of the full-size render, in device pixels; drafts are stretched to it. */
  fullWidth: number;
  fullHeight: number;
  /** Where the full-size render sits in the fitted image: all of it, or a region. */
  placement: Placement;
  /** Size of the (cropped) image at full resolution, i.e. at 100 % zoom. */
  sourceWidth: number;
  sourceHeight: number;
  ms: number;
}

/**
 * Renders recipes for one loaded photo. The developer only talks to this, so the
 * pipeline can run locally (wasm worker) or, later, on a render service. Loading the
 * photo is backend-specific and happens before the backend is handed to the developer.
 */
export interface RenderBackend {
  /**
   * Render within `maxWidth × maxHeight` (only `region` of that if given), as a draft
   * of the render within `full` if given.
   */
  render(
    params: EditParams,
    maxWidth: number,
    maxHeight: number,
    overlays?: Overlays,
    full?: { width: number; height: number; region?: Region | null },
    region?: Region | null,
  ): Promise<Frame>;
  exportJpeg(params: EditParams, maxSize: number, quality?: number): Promise<Blob>;
  /** Filmic white/black relative exposures measured on the image, or null. */
  autoTuneFilmic(
    params: EditParams,
    maxWidth: number,
    maxHeight: number,
  ): Promise<{ white: number; black: number } | null>;
  /** The scene's light (xy) measured on the input of colour calibration instance `instance`, or null. */
  detectIlluminant(
    params: EditParams,
    instance: string,
    method: IlluminantDetection,
    maxWidth: number,
    maxHeight: number,
  ): Promise<[number, number] | null>;
  dispose(): void;
}
