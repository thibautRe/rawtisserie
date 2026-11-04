/**
 * Drawn shapes (roadmap 4.3), shared by retouch spots and, later, masks. Mirrors
 * `crates/pipeline/src/shapes.rs`, which rasterises them; this side has what the
 * editor needs: validation, outlines to draw, and the mapping between the displayed
 * image and the sensor frame (`SensorMapping`, mirrors `ops/geometry.rs`).
 *
 * Shapes live in normalised sensor coordinates: (0, 0) is the top-left corner of the
 * base image (before lens correction, orientation, straighten and crop), (1, 1) its
 * bottom-right corner. Lengths (radii, feather) are fractions of the sensor's shorter
 * side; angles are radians, clockwise (y points down).
 */

export type Point = [number, number];

export interface EllipseShape {
  type: 'ellipse';
  center: Point;
  /** Along the ellipse's own axes, before rotation. */
  radii: [number, number];
  rotation: number;
  feather: number;
  opacity: number;
}

/** 0 behind the line through `anchor`, 1 ahead of it (towards `angle`), over `feather`. */
export interface GradientShape {
  type: 'gradient';
  anchor: Point;
  angle: number;
  feather: number;
  opacity: number;
}

/** A path node: `[x, y, inX, inY, outX, outY]`, its position and control points (absolute). */
export type PathNode = [number, number, number, number, number, number];

/** A closed path of cubic Bézier segments. */
export interface PathShape {
  type: 'path';
  points: PathNode[];
  feather: number;
  opacity: number;
}

/** A brush point: `[x, y, radius, hardness]`; hardness is the solid share of the radius. */
export type BrushPoint = [number, number, number, number];

export interface BrushShape {
  type: 'brush';
  points: BrushPoint[];
  opacity: number;
}

export type Shape = EllipseShape | GradientShape | PathShape | BrushShape;
export type ShapeType = Shape['type'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): number[] | null =>
  Array.isArray(v) && v.length === n && v.every(isNumber) ? [...v] : null;
const num = (v: unknown, fallback: number) => (isNumber(v) ? v : fallback);

/**
 * A shape from untrusted input, with Rust's defaults for missing optional fields
 * (rotation and feather 0, opacity 1), or null if it isn't one (Rust refuses those).
 */
export function normalizeShape(input: unknown): Shape | null {
  if (!isObject(input)) return null;
  const opacity = num(input.opacity, 1);
  switch (input.type) {
    case 'ellipse': {
      const center = tuple(input.center, 2);
      const radii = tuple(input.radii, 2);
      if (!center || !radii) return null;
      return {
        type: 'ellipse',
        center: center as Point,
        radii: radii as [number, number],
        rotation: num(input.rotation, 0),
        feather: num(input.feather, 0),
        opacity,
      };
    }
    case 'gradient': {
      const anchor = tuple(input.anchor, 2);
      if (!anchor) return null;
      return {
        type: 'gradient',
        anchor: anchor as Point,
        angle: num(input.angle, 0),
        feather: num(input.feather, 0),
        opacity,
      };
    }
    case 'path': {
      if (!Array.isArray(input.points)) return null;
      const points = input.points.map((p) => tuple(p, 6));
      if (points.some((p) => !p)) return null;
      return { type: 'path', points: points as PathNode[], feather: num(input.feather, 0), opacity };
    }
    case 'brush': {
      if (!Array.isArray(input.points)) return null;
      const points = input.points.map((p) => tuple(p, 4));
      if (points.some((p) => !p)) return null;
      return { type: 'brush', points: points as BrushPoint[], opacity };
    }
    default:
      return null;
  }
}

/** The shape moved by `(dx, dy)` (normalised sensor coordinates). */
export function translateShape<S extends Shape>(shape: S, dx: number, dy: number): S {
  switch (shape.type) {
    case 'ellipse':
      return { ...shape, center: [shape.center[0] + dx, shape.center[1] + dy] };
    case 'gradient':
      return { ...shape, anchor: [shape.anchor[0] + dx, shape.anchor[1] + dy] };
    case 'path':
      return {
        ...shape,
        points: shape.points.map((p) => p.map((v, i) => v + (i % 2 ? dy : dx)) as PathNode),
      };
    case 'brush':
      return { ...shape, points: shape.points.map(([x, y, r, h]) => [x + dx, y + dy, r, h] as BrushPoint) };
  }
}

/** A point that represents the shape (to place things relative to it). */
export function shapeCenter(shape: Shape): Point {
  switch (shape.type) {
    case 'ellipse':
      return shape.center;
    case 'gradient':
      return shape.anchor;
    case 'path':
    case 'brush': {
      const xs = shape.points.map((p) => p[0]);
      const ys = shape.points.map((p) => p[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }
  }
}

/**
 * Lines that draw a shape, in normalised sensor coordinates, dense enough to stay
 * smooth once mapped to the display (lens distortion bends straight lines). `sensor`
 * is the sensor's size in pixels (lengths are fractions of its shorter side).
 *
 * - `edge`: closed outlines of the shape's edge (for a brush, the stroke's centre line, open);
 * - `feather`: where the feather ends (ellipses and gradients only).
 */
export function shapeOutline(
  shape: Shape,
  sensor: { width: number; height: number },
): { edge: Point[][]; feather: Point[][]; closed: boolean } {
  const unit = Math.min(sensor.width, sensor.height);
  const kx = unit / sensor.width;
  const ky = unit / sensor.height;
  switch (shape.type) {
    case 'ellipse': {
      const ring = (grow: number): Point[] => {
        const [cx, cy] = shape.center;
        const [a, b] = [Math.abs(shape.radii[0]) + grow, Math.abs(shape.radii[1]) + grow];
        const [s, c] = [Math.sin(shape.rotation), Math.cos(shape.rotation)];
        return Array.from({ length: 72 }, (_, i) => {
          const t = (i / 72) * 2 * Math.PI;
          const [u, v] = [a * Math.cos(t), b * Math.sin(t)];
          return [cx + (u * c - v * s) * kx, cy + (u * s + v * c) * ky];
        });
      };
      return { edge: [ring(0)], feather: shape.feather > 0 ? [ring(shape.feather)] : [], closed: true };
    }
    case 'gradient': {
      // Lines across the whole frame, perpendicular to the direction.
      const [s, c] = [Math.sin(shape.angle), Math.cos(shape.angle)];
      const line = (offset: number): Point[] =>
        Array.from({ length: 33 }, (_, i) => {
          const t = ((i - 16) / 16) * 3;
          return [shape.anchor[0] + (offset * c - t * s) * kx, shape.anchor[1] + (offset * s + t * c) * ky];
        });
      const half = Math.max(0, shape.feather) / 2;
      return { edge: [line(0)], feather: half > 0 ? [line(-half), line(half)] : [], closed: false };
    }
    case 'path':
      return { edge: [flattenPath(shape.points)], feather: [], closed: true };
    case 'brush':
      return { edge: [shape.points.map(([x, y]) => [x, y] as Point)], feather: [], closed: false };
  }
}

/** A closed path's outline as a polygon (normalised coordinates), 16 steps per segment. */
export function flattenPath(nodes: PathNode[]): Point[] {
  const out: Point[] = [];
  nodes.forEach((a, i) => {
    const b = nodes[(i + 1) % nodes.length]!;
    for (let s = 0; s < 16; s++) {
      const t = s / 16;
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
      out.push([
        w[0] * a[0] + w[1] * a[4] + w[2] * b[2] + w[3] * b[0],
        w[0] * a[1] + w[1] * a[5] + w[2] * b[3] + w[3] * b[1],
      ]);
    }
  });
  return out;
}

/**
 * Ramer–Douglas–Peucker: drop the points of a stroke that lie within `tolerance` of
 * the line through their neighbours (distances in the units `scale` maps x and y to).
 */
export function simplifyStroke<P extends readonly number[]>(
  points: P[],
  tolerance: number,
  scale: Point = [1, 1],
): P[] {
  if (points.length <= 2) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const at = (i: number): Point => [points[i]![0]! * scale[0], points[i]![1]! * scale[1]];
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const [a, b] = [at(first), at(last)];
    let worst = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(at(i), a, b);
      if (d > worst) [worst, index] = [d, i];
    }
    if (worst > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The first `s1`, `s2`… id not in `taken`. */
export function freshShapeId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`s${n}`)) return `s${n}`;
}

/**
 * How points map between the output frame (the displayed image: oriented, straightened,
 * cropped) and the sensor frame, both normalised. `SensorMappingData` in Rust, from the
 * pipeline worker with each frame.
 */
export interface SensorMapping {
  /** Sensor size in pixels. */
  width: number;
  height: number;
  /** Output (x, y) → (u0 + x·a + y·c, v0 + x·b + y·d), sensor pixels before lens correction: `[u0, v0, a, b, c, d]`. */
  affine: [number, number, number, number, number, number];
  /** Lens distortion (green): offset `d` from (cx, cy) reads the source at `d · scale(|d|² · toIndex)`. */
  lens: { cx: number; cy: number; toIndex: number; scale: number[] } | null;
}

/** The radial scale of a lens table at squared offset `r2` (pixels²), as `Correction` does. */
function lensScale(lens: NonNullable<SensorMapping['lens']>, r2: number): number {
  const size = lens.scale.length - 1;
  const pos = Math.min(r2 * lens.toIndex, size);
  const i = Math.min(Math.floor(pos), size - 1);
  return lens.scale[i]! + (lens.scale[i + 1]! - lens.scale[i]!) * (pos - i);
}

/** The sensor position of an output position (both normalised). Mirrors `SensorMapping::to_sensor`. */
export function toSensor(m: SensorMapping, x: number, y: number): Point {
  const [u0, v0, a, b, c, d] = m.affine;
  let u = u0 + x * a + y * c;
  let v = v0 + x * b + y * d;
  if (m.lens) {
    const [dx, dy] = [u - m.lens.cx, v - m.lens.cy];
    const s = lensScale(m.lens, dx * dx + dy * dy);
    [u, v] = [m.lens.cx + dx * s, m.lens.cy + dy * s];
  }
  return [u / m.width, v / m.height];
}

/** The output position of a sensor position (both normalised). Mirrors `SensorMapping::from_sensor`. */
export function fromSensor(m: SensorMapping, su: number, sv: number): Point {
  let u = su * m.width;
  let v = sv * m.height;
  if (m.lens) {
    const [qx, qy] = [u - m.lens.cx, v - m.lens.cy];
    const target = Math.hypot(qx, qy);
    if (target > 0) {
      let r = target;
      for (let i = 0; i < 24; i++) r = target / lensScale(m.lens, r * r);
      [u, v] = [m.lens.cx + (qx * r) / target, m.lens.cy + (qy * r) / target];
    }
  }
  const [u0, v0, a, b, c, d] = m.affine;
  const det = a * d - c * b;
  const [du, dv] = [u - u0, v - v0];
  return [(du * d - dv * c) / det, (dv * a - du * b) / det];
}
