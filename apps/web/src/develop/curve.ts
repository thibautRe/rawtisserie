const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A Catmull-Rom curve through evenly spaced nodes, clamped to [0, 1], with
 * one-sided tangents at the ends. Mirrors `equalizer::curve` in the pipeline.
 */
export function curveAt(nodes: readonly number[], x: number): number {
  const n = nodes.length;
  const h = 1 / (n - 1);
  x = clamp(x, 0, 1);
  const i = Math.min(Math.floor(x / h), n - 2);
  const tangent = (k: number) => {
    const a = Math.max(k - 1, 0);
    const b = Math.min(k + 1, n - 1);
    return (nodes[b]! - nodes[a]!) / ((b - a) * h);
  };
  const t = (x - i * h) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const y =
    (2 * t3 - 3 * t2 + 1) * nodes[i]! +
    (t3 - 2 * t2 + t) * h * tangent(i) +
    (-2 * t3 + 3 * t2) * nodes[i + 1]! +
    (t3 - t2) * h * tangent(i + 1);
  return clamp(y, 0, 1);
}

/** Where a curve's values are drawn, 0 … 1: `toShown`, and back from where the pointer is. */
export interface CurveScale {
  toShown(v: number): number;
  toValue(u: number): number;
}

export const LINEAR_SCALE: CurveScale = { toShown: (v) => v, toValue: (u) => u };

/**
 * Finer around `neutral` and coarser toward 0 and 1, which stay in place (as `sinhCurve`
 * does for sliders): on either side, `u = asinh(x·sinh k) / k` of the value's distance
 * `x` from `neutral` (a fraction of the way to the end). With k = 2.5, a pixel near
 * `neutral` moves the value 0.41× as much as on a linear graph, and 2.5× at the ends.
 */
export function fineScale(neutral: number, k = 2.5): CurveScale {
  const s = Math.sinh(k);
  const side = (v: number) => (v >= neutral ? 1 - neutral : neutral) || 1;
  return {
    toShown: (v) => {
      const d = v - neutral;
      return neutral + Math.sign(d) * side(v) * (Math.asinh((Math.abs(d) / side(v)) * s) / k);
    },
    toValue: (u) => {
      const d = u - neutral;
      return neutral + Math.sign(d) * side(u) * (Math.sinh((Math.abs(d) / side(u)) * k) / s);
    },
  };
}
