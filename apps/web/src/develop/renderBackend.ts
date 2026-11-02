import type { EditParams } from '@rawtisserie/pipeline';
import type { IlluminantDetection, Overlays } from './protocol.ts';

export interface Frame {
  image: ImageData;
  /** Size of the full-size render, in device pixels; drafts are stretched to it. */
  fullWidth: number;
  fullHeight: number;
  ms: number;
}

/**
 * Renders recipes for one loaded photo. The developer only talks to this, so the
 * pipeline can run locally (wasm worker) or, later, on a render service. Loading the
 * photo is backend-specific and happens before the backend is handed to the developer.
 */
export interface RenderBackend {
  /** Render within `maxWidth × maxHeight`, as a draft of the render within `full` if given. */
  render(params: EditParams, maxWidth: number, maxHeight: number, overlays?: Overlays, full?: { width: number; height: number }): Promise<Frame>;
  exportJpeg(params: EditParams, maxSize: number, quality?: number): Promise<Blob>;
  /** Filmic white/black relative exposures measured on the image, or null. */
  autoTuneFilmic(params: EditParams, maxWidth: number, maxHeight: number): Promise<{ white: number; black: number } | null>;
  /** The scene's light (xy) measured on the input of colour calibration instance `instance`, or null. */
  detectIlluminant(params: EditParams, instance: string, method: IlluminantDetection, maxWidth: number, maxHeight: number): Promise<[number, number] | null>;
  dispose(): void;
}
