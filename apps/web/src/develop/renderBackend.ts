import type { EditParams, ExportMetadata, ExportOptions, SensorMapping } from '@rawtisserie/pipeline';
import type {
  DenoiseStatus,
  GuideLine,
  IlluminantDetection,
  Overlays,
  ParsedLut,
  PerspectiveCorrection,
  PerspectiveFit,
  PixelSample,
  Placement,
  Region,
  ToneCurveInput,
} from './protocol.ts';
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
export type LutSource = (id: string) => Promise<ArrayBuffer | null>;

/** What raw denoise (roadmap 3.5) asks the page for, and hands it. */
export interface DenoiseSource {
  /** A model's file (`/api/denoise-models/:id`), or null when it can't be had. */
  model(id: string, onProgress?: (fraction: number) => void): Promise<ArrayBuffer | null>;
  /** The RAW file, for a photo opened from a kept denoised file whose recipe changed. */
  original(): Promise<ArrayBuffer>;
  /** Keep a denoised photo, named by `denoiseKeyName` (in place of the RAW file). */
  keep?(key: string, file: ArrayBuffer): void;
}

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
  /**
   * A small final-quality render within `maxWidth × maxHeight` (menu previews), with
   * caches of its own so it doesn't slow down the interactive renders after it.
   */
  thumbnail(params: EditParams, maxWidth: number, maxHeight: number): Promise<ImageBitmap>;
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
  /**
   * Straight lines for perspective guides, on the image before straightening and
   * perspective as rendered within `maxWidth × maxHeight`; some selected already.
   */
  detectLines(params: EditParams, maxWidth: number, maxHeight: number): Promise<GuideLine[]>;
  /** The correction that straightens the selected `lines` (`mode`), or null without enough of them. */
  fitPerspective(params: EditParams, lines: GuideLine[], mode: PerspectiveFit): Promise<PerspectiveCorrection | null>;
  /**
   * Where the LUTs recipes use come from: their packed tables by id, or null when
   * unavailable (the LUT is then skipped). Each is asked for once.
   */
  setLutSource(source: LutSource): void;
  /** Where raw denoise gets its models (and the RAW file, and where it keeps its results). */
  setDenoiseSource(source: DenoiseSource): void;
  /** Follow where the recipe's raw denoise stands; returns the unsubscribe. */
  onDenoiseStatus(listener: (status: DenoiseStatus) => void): () => void;
  /**
   * The colour picker: where the pointer is over the image (normalised in the whole
   * frame), or null, and whether a zoomed-in region shows. The pixel there comes back through `onSample`, and again after
   * every render while the pointer stays.
   */
  pointer(at: [number, number] | null, zoomed: boolean): void;
  /** The pinned samples' places (normalised in the whole frame), read like the pointer's. */
  pins(pins: [number, number][]): void;
  /** Follow the pixel under the pointer (null: none) and the pinned ones; returns the unsubscribe. */
  onSample(listener: (sample: PixelSample | null, pins: (PixelSample | null)[]) => void): () => void;
  /** Decode a LUT file (`.cube`, Hald CLUT PNG). Throws if it isn't one. */
  parseLut(bytes: ArrayBuffer): Promise<ParsedLut>;
  dispose(): void;
}
