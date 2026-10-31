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
    (2 * t3 - 3 * t2 + 1) * nodes[i]! + (t3 - 2 * t2 + t) * h * tangent(i) + (-2 * t3 + 3 * t2) * nodes[i + 1]! + (t3 - t2) * h * tangent(i + 1);
  return clamp(y, 0, 1);
}
