/**
 * darktable's and Ansel's rgb curve (`rgbcurve.c`, v1, the same struct in both) as our
 * Tones (a tone curve: EV offsets at evenly spaced exposures). Theirs: output against
 * input through up to 20 nodes on 0 … 1 (linear values, or CIE lightness with "compensate
 * middle grey"), linked through a norm (their red curve) or per channel. Ours: each
 * curve's gain (log2 of output over input) at our nodes over −9 … +3 EV around middle
 * grey; past white the gain stays white's. Their curves are read as monotone Hermite
 * splines (their default; Catmull-Rom and cubic spline are close).
 */
import {
  type ModuleParams,
  type RgbNorm,
  TONE_CURVE_MAX_OFFSET,
  TONE_CURVE_NODES,
  defaultModuleParams,
} from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

const MAX_NODES = 20;
const NODE = new Layout([
  ['x', 'f32'],
  ['y', 'f32'],
]);
const RGBCURVE_V1 = new Layout([
  ['curve_nodes', { array: { array: { struct: NODE }, n: MAX_NODES }, n: 3 }],
  ['curve_num_nodes', { array: 'i32', n: 3 }],
  ['curve_type', { array: 'i32', n: 3 }],
  ['curve_autoscale', 'i32'],
  ['compensate_middle_grey', 'gboolean'],
  ['preserve_colors', 'i32'],
]);
const AUTOMATIC_RGB = 0;
const MONOTONE_HERMITE = 2;
/** `dt_iop_rgb_norms_t` as ours (theirs "sum" is ours "average", up to a scale). */
const NORMS: readonly RgbNorm[] = ['none', 'luminance', 'max', 'average', 'average', 'norm', 'power'];
const GREY = 0.1845;
const RANGE = [-9, 3] as const;

/** Fritsch–Carlson monotone cubic Hermite through `nodes` (sorted by x), clamped at the ends. */
function hermite(nodes: { x: number; y: number }[]): (x: number) => number {
  const n = nodes.length;
  if (n === 1) return () => nodes[0]!.y;
  const d = nodes.slice(1).map((p, i) => (p.y - nodes[i]!.y) / Math.max(p.x - nodes[i]!.x, 1e-9));
  const m = nodes.map((_, i) =>
    i === 0 ? d[0]! : i === n - 1 ? d[n - 2]! : d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2,
  );
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const [a, b] = [m[i]! / d[i]!, m[i + 1]! / d[i]!];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return (x) => {
    if (x <= nodes[0]!.x) return nodes[0]!.y;
    if (x >= nodes[n - 1]!.x) return nodes[n - 1]!.y;
    let i = 0;
    while (x > nodes[i + 1]!.x) i++;
    const [p, q] = [nodes[i]!, nodes[i + 1]!];
    const h = q.x - p.x;
    const t = (x - p.x) / h;
    const [t2, t3] = [t * t, t * t * t];
    return (
      (2 * t3 - 3 * t2 + 1) * p.y + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * q.y + (t3 - t2) * h * m[i + 1]!
    );
  };
}

/** CIE lightness (0 … 1) of a grey of linear value `v`, and back. */
const lightness = (v: number) => (v > 216 / 24389 ? 1.16 * Math.cbrt(v) - 0.16 : (24389 / 27 / 100) * v);
const fromLightness = (l: number) => (l > 0.08 ? ((l + 0.16) / 1.16) ** 3 : (l * 100 * 27) / 24389);

export const rgbCurve: Translator = {
  operations: ['rgbcurve'],
  kinds: ['toneCurve'],
  translate(entry, bytes): Translation {
    const p = entry.modversion === 1 ? RGBCURVE_V1.read(bytes) : null;
    if (!p) return unreadable(entry);
    const counts = p.curve_num_nodes as number[];
    const types = p.curve_type as number[];
    const compensate = !!p.compensate_middle_grey;
    const notes: string[] = [];
    const curve = (ch: number) => {
      const nodes = (p.curve_nodes as { x: number; y: number }[][])
        [ch]!.slice(0, Math.max(1, counts[ch]!))
        .toSorted((a, b) => a.x - b.x);
      if (types[ch] !== MONOTONE_HERMITE) notes.push('Its curves read as monotone splines');
      const f = hermite(nodes);
      // Linear in, linear out (through lightness with middle grey compensation).
      const linear = (v: number) => (compensate ? fromLightness(f(lightness(v))) : f(v));
      return Array.from({ length: TONE_CURVE_NODES }, (_, i) => {
        const v = Math.min(1, GREY * 2 ** (RANGE[0] + ((RANGE[1] - RANGE[0]) * i) / (TONE_CURVE_NODES - 1)));
        const gain = Math.log2(Math.max(linear(v), 1e-9) / v);
        if (Math.abs(gain) > TONE_CURVE_MAX_OFFSET) notes.push(`Its gain clamped to ±${TONE_CURVE_MAX_OFFSET} EV`);
        return Math.max(-TONE_CURVE_MAX_OFFSET, Math.min(TONE_CURVE_MAX_OFFSET, gain));
      });
    };
    const linked = p.curve_autoscale === AUTOMATIC_RGB;
    const rgb = curve(0);
    const params: ModuleParams['toneCurve'] = {
      ...structuredClone(defaultModuleParams.toneCurve),
      channels: linked ? 'linked' : 'independent',
      preserveColors: NORMS[p.preserve_colors as number] ?? 'luminance',
      range: [...RANGE],
      rgb,
      ...(!linked && { red: rgb, green: curve(1), blue: curve(2) }),
      preserveDetail: false,
      strength: 1,
    };
    const unique = [...new Set(notes)];
    return {
      instance: instance('toneCurve', params),
      status: unique.length ? 'approximated' : 'mapped',
      ...(unique.length && { note: unique.join('. ') }),
    };
  },
};
