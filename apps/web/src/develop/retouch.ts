/**
 * Shape editing in the developer (retouch spots and mask shapes): the state of the shape
 * tools (shared by the module panel and the overlay on the image), and the helpers
 * behind them.
 */
import {
  type ModuleKind,
  type Point,
  REC2020_FROM_REC709,
  REC709_FROM_REC2020,
  type SensorMapping,
  type ShapeOp,
  type SpotMode,
  fromSensor,
} from '@rawtisserie/pipeline';
import type { MaskView } from './protocol.ts';

/** `select` edits existing shapes; the others also add one with each click, drag or stroke. */
export type ShapeTool = 'select' | 'circle' | 'ellipse' | 'gradient' | 'path' | 'brush';

/** Whose shapes the overlay edits: a retouch instance's spots, or an instance's mask. */
export type ShapeTarget = 'retouch' | 'mask';

export interface ShapeUi {
  /** Shapes are shown on the image and can be edited there. */
  editing: boolean;
  target: ShapeTarget;
  /** The instance whose spots or mask are shown and edited (it may not exist yet). */
  instance: string;
  /** Its kind. */
  kind: ModuleKind;
  tool: ShapeTool;
  /** How new spots fill their shape. */
  mode: SpotMode;
  /** How new mask shapes combine with the others. */
  maskOp: ShapeOp;
  /** Brush radius in CSS pixels on screen, and the solid share of it (0 … 1). */
  brushSize: number;
  brushHardness: number;
  /** Index of the selected spot or mask shape. */
  selected: number | null;
  /** The instance whose mask is shown over the image, and what of it. */
  maskOverlay: ({ id: string } & MaskView) | null;
}

export const DEFAULT_SHAPE_UI: ShapeUi = {
  editing: false,
  target: 'retouch',
  instance: 'retouch',
  kind: 'retouch',
  tool: 'select',
  mode: 'heal',
  maskOp: 'union',
  brushSize: 20,
  brushHardness: 0.6,
  selected: null,
  maskOverlay: null,
};

/** Whether the overlay is editing the spots of retouch instance `id`, or the mask of instance `id`. */
export const isEditing = (ui: ShapeUi, target: ShapeTarget, id: string) =>
  ui.editing && ui.target === target && ui.instance === id;

/** Radius of a spot placed with a click (no drag), in CSS pixels on screen. */
export const CLICK_RADIUS_PX = 16;

/**
 * CSS pixels on the displayed image (`width × height`, unzoomed) per unit of sensor
 * length (the sensor's shorter side) around sensor point `p`.
 */
export function displayScale(m: SensorMapping, p: Point, width: number, height: number): number {
  const unit = Math.min(m.width, m.height);
  const eps = 1e-3;
  const a = fromSensor(m, p[0], p[1]);
  const bx = fromSensor(m, p[0] + (eps * unit) / m.width, p[1]);
  const by = fromSensor(m, p[0], p[1] + (eps * unit) / m.height);
  const lx = Math.hypot((bx[0] - a[0]) * width, (bx[1] - a[1]) * height);
  const ly = Math.hypot((by[0] - a[0]) * width, (by[1] - a[1]) * height);
  return (lx + ly) / 2 / eps;
}

/**
 * Where a new spot copies from: beside it (to the right, or the left near the edge),
 * as an offset in normalised sensor coordinates. `extent` is the spot's half size.
 */
export function defaultSource(center: Point, extent: Point): [number, number] {
  const dx = 2.5 * extent[0];
  return center[0] + dx + extent[0] <= 1 ? [round(dx), 0] : [round(-dx), 0];
}

/** Sensor coordinates are stored to this precision (well under a pixel). */
export const round = (v: number) => Math.round(v * 1e6) / 1e6;

const srgbEncode = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const apply = (m: number[][], v: number[]) => m.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!);

/** A fill colour (linear Rec.2020) as a CSS `#rrggbb`, clipped to sRGB. */
export function rec2020ToHex(c: readonly number[]): string {
  const rgb = apply(REC709_FROM_REC2020, [...c]).map(srgbEncode);
  return `#${rgb
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** A CSS `#rrggbb` as a fill colour (linear Rec.2020). */
export function hexToRec2020(hex: string): [number, number, number] {
  const rgb = [1, 3, 5].map((i) => srgbDecode(parseInt(hex.slice(i, i + 2), 16) / 255));
  return apply(REC2020_FROM_REC709, rgb).map((v) => Math.round(v * 1e4) / 1e4) as [number, number, number];
}
