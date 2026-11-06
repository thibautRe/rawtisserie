import type { EditParams, ExportMetadata, ExportOptions, SensorMapping } from '@rawtisserie/pipeline';
import type { IlluminantDetection, Overlays, Placement, Region, ToneCurveInput } from './protocol.ts';
import type { ScopeMode, ScopeRequest } from './scopes.ts';

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
  /** How the image maps to the sensor frame, where shapes live (`shapes.ts`). */
  mapping: SensorMapping;
  /** The scope of the render, if asked for; transferred to its canvas like `image`. */
  scope: { mode: ScopeMode; image: ImageBitmap } | null;
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
   * of the render within `full` if given, with `scope` drawn from it.
   */
  render(
    params: EditParams,
    maxWidth: number,
    maxHeight: number,
    overlays?: Overlays,
    full?: { width: number; height: number; region?: Region | null },
    region?: Region | null,
    scope?: ScopeRequest | null,
  ): Promise<Frame>;
  /** A final-quality export: the file, typed by its format. */
  export(params: EditParams, options: ExportOptions, metadata: ExportMetadata): Promise<Blob>;
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
  /** What tone curve instance `instance` reads on its input, and the node range that fits it, or null. */
  toneCurveInput(
    params: EditParams,
    instance: string,
    maxWidth: number,
    maxHeight: number,
  ): Promise<ToneCurveInput | null>;
  dispose(): void;
}
