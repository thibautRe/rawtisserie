import type { EditParams, FocusMap, SensorMapping } from '@rawtisserie/pipeline';
import type { ExposureSource } from './source.ts';

/** Side of a zoom tile, in pixels of its level. */
export const ZOOM_TILE = 512;

/** What a zoom render reads: see `RenderSource`. */
export interface ZoomSource {
  /** The original's key in the object store. */
  sourceKey: string;
  params: EditParams | null;
  autoDefaults: boolean;
  /** With `autoDefaults`: edits from another application, imported on top of the default recipe. */
  importedEdits: string | null;
  /** With `importedEdits`: the owner's LUTs by name. */
  userLuts: { id: string; name: string }[];
  /** Ids of the LUTs the recipe may use. */
  luts: string[];
  /** The other photos the recipe blends in (multiple exposure). */
  exposures: ExposureSource[];
  /** Where the photo is in focus, if measured already (else the worker measures it). */
  focus: FocusMap | null;
}

/** Size of each zoom level: level `n` is the image fitted in its full size / 2ⁿ. */
export type ZoomLevels = { width: number; height: number }[];

/** What the worker is asked: the levels' sizes, or one tile. */
export type ZoomJob = { kind: 'levels' } | { kind: 'tile'; level: number; col: number; row: number; quality: number };

export type ZoomRequest = ZoomJob & { jobId: number; source: ZoomSource };

export type ZoomResponse =
  | {
      jobId: number;
      ok: true;
      levels: ZoomLevels;
      /** The focus map, and how this version's frame maps onto it. */
      focus: { map: FocusMap; mapping: SensorMapping } | null;
      /** The focus map, when the worker measured it (to store). */
      measured: FocusMap | null;
    }
  | { jobId: number; ok: true; jpeg: Uint8Array }
  | { jobId: number; ok: false; error: string; notFound?: boolean };
