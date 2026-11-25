/**
 * Focus areas (roadmap 8.9): where a photo is sharp. `FocusMap` mirrors Rust's
 * `focus::FocusMap`, measured once per photo in the sensor frame (wasm `focusMap`);
 * `focusView` places it on a version's output frame (cropped, rotated, lens-corrected)
 * through its `SensorMapping`, for overlays and for zooming to the focus area.
 */
import { fromSensor, type SensorMapping, toSensor } from './shapes.ts';

/** Rust's `FOCUS_VERSION`: a stored map of another version is measured again. */
export const FOCUS_VERSION = 1;

/** A cell value meaning "not enough detail to tell" (Rust's `NO_DETAIL`). */
export const NO_DETAIL = 255;

/** A region of the image and its centre, normalised (0 … 1 across each side). */
export interface FocusArea {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

/** The sharpness of a photo by cell, in the sensor frame. */
export interface FocusMap {
  version: number;
  cols: number;
  rows: number;
  /** Row by row, 0 (blurred) … 254 (sharp), or `NO_DETAIL`, base64. */
  cells: string;
  /** How sharp the photo's sharpest parts are (a ratio, about 0.5 to 2 in focus, by camera). */
  sharpness: number;
  /** The sharpest region, if any part has detail. */
  area: FocusArea | null;
}

/** A `FocusMap` placed on a version's output frame (same cells, `area` in that frame). */
export interface FocusView {
  cols: number;
  rows: number;
  cells: string;
  /** The sharpest region, if it's in the frame. */
  area: FocusArea | null;
}

/** Whether a stored map is current (measured by this version of the measure). */
export const isCurrentFocus = (map: unknown): map is FocusMap =>
  !!map && typeof map === 'object' && (map as FocusMap).version === FOCUS_VERSION;

export function decodeCells(cells: string): Uint8Array {
  const bin = atob(cells);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeCells(cells: Uint8Array): string {
  let bin = '';
  for (const c of cells) bin += String.fromCharCode(c);
  return btoa(bin);
}

/** Cells along the output's long side, as the measure has along the sensor's. */
const VIEW_CELLS = 64;

/**
 * `map` on an output frame of `width × height` pixels (any scale) that `mapping`
 * places on the sensor: each cell reads the sensor cells around its centre (those with
 * detail, bilinearly), and cells outside the sensor have no detail.
 */
export function focusView(map: FocusMap, mapping: SensorMapping, width: number, height: number): FocusView {
  const long = Math.max(width, height, 1);
  const cols = Math.max(1, Math.round((width / long) * VIEW_CELLS));
  const rows = Math.max(1, Math.round((height / long) * VIEW_CELLS));
  const src = decodeCells(map.cells);
  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [u, v] = toSensor(mapping, (c + 0.5) / cols, (r + 0.5) / rows);
      cells[r * cols + c] = sampleCells(src, map.cols, map.rows, u, v);
    }
  }
  return { cols, rows, cells: encodeCells(cells), area: map.area && areaInFrame(map.area, mapping) };
}

function sampleCells(cells: Uint8Array, cols: number, rows: number, u: number, v: number): number {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return NO_DETAIL;
  const x = u * cols - 0.5;
  const y = v * rows - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  let sum = 0;
  let weight = 0;
  let all = 0;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const cx = Math.min(cols - 1, Math.max(0, x0 + dx));
    const cy = Math.min(rows - 1, Math.max(0, y0 + dy));
    const w = (dx ? x - x0 : 1 - (x - x0)) * (dy ? y - y0 : 1 - (y - y0));
    all += w;
    const value = cells[cy * cols + cx]!;
    if (value === NO_DETAIL) continue;
    sum += value * w;
    weight += w;
  }
  // Mostly cells without detail: none either.
  if (weight < all / 2) return NO_DETAIL;
  return Math.round(sum / weight);
}

/** The centre of `map`'s focus area on the output frame `mapping` places (normalised); null without one, or cropped out. */
export function focusPoint(map: FocusMap, mapping: SensorMapping): [number, number] | null {
  if (!map.area) return null;
  const [x, y] = fromSensor(mapping, map.area.cx, map.area.cy);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : null;
}

/** `area` (sensor frame) in the output frame: the box around its mapped outline, clipped; null if cropped out. */
function areaInFrame(area: FocusArea, mapping: SensorMapping): FocusArea | null {
  const [cx, cy] = fromSensor(mapping, area.cx, area.cy);
  if (!(cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1)) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= 4; i++) {
    for (const [u, v] of [
      [area.x + (area.width * i) / 4, area.y],
      [area.x + (area.width * i) / 4, area.y + area.height],
      [area.x, area.y + (area.height * i) / 4],
      [area.x + area.width, area.y + (area.height * i) / 4],
    ] as const) {
      const [x, y] = fromSensor(mapping, u, v);
      xs.push(x);
      ys.push(y);
    }
  }
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x0 = clamp(Math.min(...xs));
  const y0 = clamp(Math.min(...ys));
  return {
    x: x0,
    y: y0,
    width: clamp(Math.max(...xs)) - x0,
    height: clamp(Math.max(...ys)) - y0,
    cx,
    cy,
  };
}
