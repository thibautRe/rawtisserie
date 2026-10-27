import type { EditParams } from '@rawtisserie/pipeline';
import type { Overlays } from './protocol.ts';

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
  dispose(): void;
}
