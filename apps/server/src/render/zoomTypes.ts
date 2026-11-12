import type { EditParams } from '@rawtisserie/pipeline';

/** Side of a zoom tile, in pixels of its level. */
export const ZOOM_TILE = 512;

/** What a zoom render reads: see `RenderSource`. */
export interface ZoomSource {
  /** The original's key in the object store. */
  sourceKey: string;
  params: EditParams | null;
  autoDefaults: boolean;
  /** Ids of the LUTs the recipe may use. */
  luts: string[];
}

/** Size of each zoom level: level `n` is the image fitted in its full size / 2ⁿ. */
export type ZoomLevels = { width: number; height: number }[];

/** What the worker is asked: the levels' sizes, or one tile. */
export type ZoomJob = { kind: 'levels' } | { kind: 'tile'; level: number; col: number; row: number; quality: number };

export type ZoomRequest = ZoomJob & { jobId: number; source: ZoomSource };

export type ZoomResponse =
  | { jobId: number; ok: true; levels: ZoomLevels }
  | { jobId: number; ok: true; jpeg: Uint8Array }
  | { jobId: number; ok: false; error: string; notFound?: boolean };
