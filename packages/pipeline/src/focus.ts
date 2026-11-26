/**
 * Focus areas (roadmap 8.9): where a photo is sharp. `FocusMap` mirrors Rust's
 * `focus::FocusMap`, measured once per photo in the sensor frame (wasm `focusMap`):
 * the blur of the sharpest edge in each cell, in sensor pixels. `focusView` places it
 * on a version's output frame (cropped, rotated, lens-corrected) through its
 * `SensorMapping`, for overlays.
 */
import { type SensorMapping, toSensor } from './shapes.ts';

/** Rust's `FOCUS_VERSION`: a stored map of another version is measured again. */
export const FOCUS_VERSION = 2;

/** A cell without an edge (Rust's `NO_EDGE`). */
export const NO_EDGE = 255;
/** A cell's value is its edge's blur σ (sensor pixels) times this (Rust's `BLUR_SCALE`). */
export const BLUR_SCALE = 10;
/** Edges blurred this much or more aren't kept (Rust's `MAX_BLUR`). */
export const MAX_BLUR = 5;

/** The edges of a photo and how blurred they are, by cell, in the sensor frame. */
export interface FocusMap {
  version: number;
  cols: number;
  rows: number;
  /** Row by row, σ × `BLUR_SCALE` of the cell's sharpest edge or `NO_EDGE`: deflated (zlib), base64. */
  cells: string;
}

/** A `FocusMap` on a version's output frame: `width × height` cells, same values. */
export interface FocusView {
  width: number;
  height: number;
  cells: Uint8Array;
}

/** Whether a stored map is current (measured by this version of the measure). */
export const isCurrentFocus = (map: unknown): map is FocusMap =>
  !!map && typeof map === 'object' && (map as FocusMap).version === FOCUS_VERSION;

/** A map's cells, inflated. */
export async function focusCells(map: FocusMap): Promise<Uint8Array> {
  const bin = atob(map.cells);
  const packed = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i);
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate'));
  const cells = new Uint8Array(await new Response(stream).arrayBuffer());
  if (cells.length !== map.cols * map.rows) throw new Error('Focus map of the wrong size');
  return cells;
}

/** Steps of the grid on which the output frame is mapped to the sensor (bilinear between). */
const GRID = 32;

/**
 * The map's `cells` (`focusCells`) on the output frame of `width × height` pixels
 * (full resolution) that `mapping` places on the sensor, as finely as the map is: each
 * view cell takes the sensor cell under its centre. Cells outside the sensor have no edge.
 */
export function focusView(
  map: Pick<FocusMap, 'cols' | 'rows'>,
  cells: Uint8Array,
  mapping: SensorMapping,
  width: number,
  height: number,
): FocusView {
  const scale = Math.max(map.cols, map.rows) / Math.max(mapping.width, mapping.height, 1);
  const vw = Math.max(1, Math.round(width * scale));
  const vh = Math.max(1, Math.round(height * scale));
  // The mapping is smooth: exact on a grid, interpolated within.
  const gu = new Float64Array((GRID + 1) * (GRID + 1));
  const gv = new Float64Array((GRID + 1) * (GRID + 1));
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const [u, v] = toSensor(mapping, i / GRID, j / GRID);
      gu[j * (GRID + 1) + i] = u;
      gv[j * (GRID + 1) + i] = v;
    }
  }
  const out = new Uint8Array(vw * vh).fill(NO_EDGE);
  for (let y = 0; y < vh; y++) {
    const fy = ((y + 0.5) / vh) * GRID;
    const j = Math.min(GRID - 1, Math.floor(fy));
    const ty = fy - j;
    for (let x = 0; x < vw; x++) {
      const fx = ((x + 0.5) / vw) * GRID;
      const i = Math.min(GRID - 1, Math.floor(fx));
      const tx = fx - i;
      const k = j * (GRID + 1) + i;
      const lerp = (g: Float64Array) =>
        (g[k]! * (1 - tx) + g[k + 1]! * tx) * (1 - ty) + (g[k + GRID + 1]! * (1 - tx) + g[k + GRID + 2]! * tx) * ty;
      const u = lerp(gu);
      const v = lerp(gv);
      if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) continue;
      out[y * vw + x] = cells[Math.floor(v * map.rows) * map.cols + Math.floor(u * map.cols)]!;
    }
  }
  return { width: vw, height: vh, cells: out };
}
