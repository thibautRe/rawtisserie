/**
 * darktable's and Ansel's tone equalizer (`toneequal.c`, v2, the same struct in both) as
 * our tone curve preserving detail ("Tones"), which is a port of Ansel's.
 *
 * Theirs: nine sliders at −8 … 0 EV of a luminance mask (log2, white at 0), through
 * which eight Gaussians are fitted (`build_interpolation_matrix`, `pseudo_solve`); the
 * correction, clamped to ±2 EV, scales the pixel. The mask is the norm (unscaled: a
 * grey's 2-norm is √3 its value) times the exposure boost, then, with the guided and
 * EIGF filters, pushed away from 2⁻⁴ by the contrast boost (linearly, on linear values).
 *
 * Ours: nine evenly spaced nodes over a range of scene EV (relative to middle grey) on
 * a norm scaled to a grey's value. The range is where their mask spans −8 … 0 EV; each
 * node takes their correction there. Mask smoothing and edge refinement are theirs
 * (blending, feathering).
 */
import { type ModuleParams, type RgbNorm, TONE_CURVE_NODES, defaultModuleParams } from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

const TONEEQUAL_V2 = new Layout([
  ...[
    'noise',
    'ultra_deep_blacks',
    'deep_blacks',
    'blacks',
    'shadows',
    'midtones',
    'highlights',
    'whites',
    'speculars',
    'blending',
    'smoothing',
    'feathering',
    'quantization',
    'contrast_boost',
    'exposure_boost',
  ].map((n) => [n, 'f32'] as const),
  ['details', 'i32'],
  ['method', 'i32'],
  ['iterations', 'i32'],
]);

const GREY = 0.1845;
/** `CONTRAST_FULCRUM`. */
const FULCRUM = 2 ** -4;
/** The sliders' exposures, and the Gaussians' centres (8 EV in 7 steps). */
const PARAM_CENTERS = Array.from({ length: 9 }, (_, i) => i - 8);
const OPS_CENTERS = Array.from({ length: 8 }, (_, i) => (-56 + 8 * i) / 7);

/** `dt_iop_toneequalizer_filter_t`: none, averaged guided, guided, averaged EIGF, EIGF. */
const NONE = 0;
const GUIDED = 2;
const EIGF = 4;
/**
 * `dt_iop_luminance_mask_method_t` as our norms, and what theirs is of a grey of value 1
 * (mean, lightness, value, 1-norm, 2-norm, power, geometric mean).
 */
const NORMS: readonly { norm: RgbNorm; grey: number }[] = [
  { norm: 'average', grey: 1 },
  { norm: 'average', grey: 1 },
  { norm: 'max', grey: 1 },
  { norm: 'average', grey: 3 },
  { norm: 'norm', grey: Math.sqrt(3) },
  { norm: 'power', grey: 1 },
  { norm: 'average', grey: 1 },
];

/** Least squares (normal equations): `x` minimising |A·x − b|. */
function leastSquares(a: number[][], b: number[]): number[] {
  const n = a[0]!.length;
  const m = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) =>
      j < n ? a.reduce((s, row) => s + row[i]! * row[j]!, 0) : a.reduce((s, row, k) => s + row[i]! * b[k]!, 0),
    ),
  );
  for (let c = 0; c < n; c++) {
    const pivot = m.slice(c).reduce((best, row, i) => (Math.abs(row[c]!) > Math.abs(m[best]![c]!) ? c + i : best), c);
    [m[c], m[pivot]] = [m[pivot]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Their correction (a factor) at mask exposure `e`, from the sliders (EV) and the curve smoothing. */
function correction(sliders: number[], sigma: number): (e: number) => number {
  const g = (r: number) => Math.exp((-r * r) / (2 * sigma * sigma));
  const a = PARAM_CENTERS.map((c) => OPS_CENTERS.map((o) => g(c - o)));
  const weights = leastSquares(
    a,
    sliders.map((v) => 2 ** v),
  );
  return (e) => {
    const x = Math.min(0, Math.max(-8, e));
    const sum = OPS_CENTERS.reduce((s, o, i) => s + g(x - o) * weights[i]!, 0);
    return Math.min(4, Math.max(0.25, sum));
  };
}

export const toneEqualizer: Translator = {
  operations: ['toneequal'],
  kinds: ['toneCurve'],
  translate(entry, bytes): Translation {
    const p = entry.modversion === 2 ? (TONEEQUAL_V2.read(bytes) as Record<string, number> | null) : null;
    if (!p) return unreadable(entry);
    const sliders = TONEEQUAL_V2.fields.slice(0, 9).map((f) => p[f.name]!);
    const notes: string[] = [];
    const details = p.details!;
    const { norm, grey } = NORMS[p.method!] ?? NORMS[4]!;
    if (p.method === 1 || p.method === 6) notes.push('Its luminance estimator read as the average');
    if (details !== NONE && details !== EIGF) notes.push('Its mask smoothed with the EIGF');
    if (p.quantization! > 0 || p.iterations! > 1) notes.push('No quantization, one iteration');
    const boost = 2 ** p.exposure_boost!;
    const contrast = details === GUIDED || details === EIGF ? 2 ** p.contrast_boost! : 1;
    // A grey of scene exposure `ev` (EV, middle grey 0): its mask exposure, and back.
    const maskOf = (ev: number) =>
      Math.log2(Math.max((boost * grey * GREY * 2 ** ev - FULCRUM) * contrast + FULCRUM, 1e-12));
    const evOf = (e: number) =>
      Math.log2(Math.max(((2 ** e - FULCRUM) / contrast + FULCRUM) / (boost * grey * GREY), 1e-12));
    const [lo, hi] = [evOf(-8), evOf(0)];
    const curve = correction(sliders, p.smoothing!);
    const rgb = Array.from({ length: TONE_CURVE_NODES }, (_, i) =>
      Math.log2(curve(maskOf(lo + ((hi - lo) * i) / (TONE_CURVE_NODES - 1)))),
    );
    const params: ModuleParams['toneCurve'] = {
      ...structuredClone(defaultModuleParams.toneCurve),
      channels: 'linked',
      preserveColors: norm,
      range: [lo, hi],
      rgb,
      preserveDetail: details !== NONE,
      smoothing: p.blending! / 100,
      edgeRefinement: p.feathering!,
      strength: 1,
    };
    return {
      instance: instance('toneCurve', params),
      status: notes.length ? 'approximated' : 'mapped',
      ...(notes.length && { note: notes.join('. ') }),
    };
  },
};
