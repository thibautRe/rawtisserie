import type { BrushPoint, Shape } from '@rawtisserie/pipeline';

/**
 * What the user may set on a drawn shape besides where it is: its opacity, its feather
 * (ellipses, gradients and paths), and a brush stroke's size (the mean radius of its
 * points, a fraction of the sensor's shorter side like the feather) and hardness.
 */
export interface ShapeSettings {
  opacity: number;
  feather?: number;
  /** The feather slider's range: a gradient's (the length of its ramp) is longer. */
  featherMax?: number;
  size?: number;
  hardness?: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** A shape's settings, or null without a shape. */
export function shapeSettings(shape: Shape | undefined): ShapeSettings | null {
  if (!shape) return null;
  switch (shape.type) {
    case 'ellipse':
    case 'path':
      return { opacity: shape.opacity, feather: shape.feather, featherMax: 0.1 };
    case 'gradient':
      return { opacity: shape.opacity, feather: shape.feather, featherMax: 1 };
    case 'brush':
      return {
        opacity: shape.opacity,
        size: mean(shape.points.map((p) => p[2])),
        hardness: mean(shape.points.map((p) => p[3])),
      };
    case 'raster':
      return { opacity: shape.opacity };
  }
}

/**
 * The shape with `patch` applied. A stroke's new size scales every point's radius (so a
 * stroke painted with varying sizes keeps its shape); its hardness applies to every point.
 */
export function withShapeSettings<S extends Shape>(shape: S, patch: Partial<ShapeSettings>): S {
  let next: Shape = { ...shape, ...(patch.opacity !== undefined && { opacity: patch.opacity }) };
  if (patch.feather !== undefined && 'feather' in next) next = { ...next, feather: patch.feather };
  if (next.type === 'brush' && (patch.size !== undefined || patch.hardness !== undefined)) {
    const was = mean(next.points.map((p) => p[2]));
    const { size, hardness } = patch;
    next = {
      ...next,
      points: next.points.map(([x, y, r, h]): BrushPoint => [
        x,
        y,
        size === undefined ? r : was > 0 ? (r * size) / was : size,
        hardness ?? h,
      ]),
    };
  }
  return next as S;
}
