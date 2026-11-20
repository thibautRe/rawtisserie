/**
 * darktable's rgb primaries (`primaries.c`, v1): its working space's primaries rotated
 * around the white and scaled towards the gamut's edge (`dt_rotate_and_scale_primary`),
 * and the white tinted, then pixels read as that space and converted back: one 3×3
 * matrix on linear RGB. Ours: a colour calibration instance doing only that mix (no
 * adaptation). Their working space is linear Rec.2020 as an ICC profile: colorants
 * adapted to D50 (Bradford), white D50; its RGB numbers are ours.
 */
import { type ModuleParams, defaultModuleParams } from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

type Mat3 = number[][];
type Xy = [number, number];

const PRIMARIES_V1 = new Layout(
  [
    'achromatic_tint_hue',
    'achromatic_tint_purity',
    'red_hue',
    'red_purity',
    'green_hue',
    'green_purity',
    'blue_hue',
    'blue_purity',
  ].map((n) => [n, 'f32'] as const),
);

const mul = (a: Mat3, b: Mat3): Mat3 =>
  a.map((row) => [0, 1, 2].map((j) => row.reduce((t, v, k) => t + v * b[k]![j]!, 0)));
const mulVec = (m: Mat3, v: number[]) => m.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!);
function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m.flat() as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [A, B, C] = [e * i - f * h, f * g - d * i, d * h - e * g];
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
const xyz = ([x, y]: Xy) => [x / y, 1, (1 - x - y) / y];
const xy = (v: number[]): Xy => [v[0]! / (v[0]! + v[1]! + v[2]!), v[1]! / (v[0]! + v[1]! + v[2]!)];

const D65: Xy = [0.3127, 0.329];
const D50: Xy = [0.3457, 0.3585];
const BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
/** Von Kries in Bradford LMS, D65 → D50 (an ICC profile's colorants). */
const toD50 = (c: Xy): Xy => {
  const [s, d] = [mulVec(BRADFORD, xyz(D65)), mulVec(BRADFORD, xyz(D50))];
  const lms = mulVec(BRADFORD, xyz(c)).map((v, i) => (v * d[i]!) / s[i]!);
  return xy(mulVec(invert(BRADFORD), lms));
};
/** Their working space's primaries (linear Rec.2020's, adapted to D50) and white. */
const PRIMARIES: Xy[] = (
  [
    [0.708, 0.292],
    [0.17, 0.797],
    [0.131, 0.046],
  ] as Xy[]
).map(toD50);
const WHITE = D50;

/** `dt_rotate_and_scale_primary`: primary `i` rotated by `rotation` and scaled by `scaling` towards the gamut's edge. */
function rotateAndScale(scaling: number, rotation: number, i: number): Xy {
  const [dx, dy] = [PRIMARIES[i]![0] - WHITE[0], PRIMARIES[i]![1] - WHITE[1]];
  const angle = Math.atan2(dy, dx) + rotation;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  // `_find_distance_to_edge`: along that direction, to the nearest side of the triangle.
  let edge = Infinity;
  for (let k = 0; k < 3; k++) {
    const [[x3, y3], [x4, y4]] = [PRIMARIES[k]!, PRIMARIES[(k + 1) % 3]!];
    const [x1, y1, x2, y2] = [WHITE[0], WHITE[1], WHITE[0] + c, WHITE[1] + s];
    const den = (x1 - x2) * (y3 - y4) - (x3 - x4) * (y1 - y2);
    if (den === 0) continue;
    const t = ((x1 - x3) * (y3 - y4) - (x3 - x4) * (y1 - y3)) / den;
    if (t >= 0 && t < edge) edge = t;
  }
  return [WHITE[0] + scaling * edge * c, WHITE[1] + scaling * edge * s];
}

/** `dt_make_transposed_matrices_from_primaries_and_whitepoint`, not transposed: RGB → XYZ. */
function rgbToXyz(primaries: Xy[], white: Xy): Mat3 {
  const p = [0, 1, 2].map((r) => primaries.map((q) => xyz(q)[r]!));
  const scale = mulVec(invert(p), xyz(white));
  return p.map((row) => row.map((v, j) => v * scale[j]!));
}

/** Their matrix on linear RGB (`_calculate_adjustment_matrix`): read as the custom space, back to theirs. */
export function primariesMatrix(p: Record<string, number>): Mat3 {
  const custom = (['red', 'green', 'blue'] as const).map((c, i) =>
    rotateAndScale(p[`${c}_purity`]!, p[`${c}_hue`]!, i),
  );
  const white = rotateAndScale(p.achromatic_tint_purity!, p.achromatic_tint_hue!, 0);
  return mul(invert(rgbToXyz(PRIMARIES, WHITE)), rgbToXyz(custom, white));
}

export const rgbPrimaries: Translator = {
  operations: ['primaries'],
  kinds: ['colorCalibration'],
  translate(entry, bytes): Translation {
    const p = entry.modversion === 1 ? (PRIMARIES_V1.read(bytes) as Record<string, number> | null) : null;
    if (!p) return unreadable(entry);
    const m = primariesMatrix(p);
    const params: ModuleParams['colorCalibration'] = {
      ...structuredClone(defaultModuleParams.colorCalibration),
      illuminant: 'pipeline',
      adaptation: 'none',
      gamut: 0,
      clip: false,
      red: m[0]!,
      green: m[1]!,
      blue: m[2]!,
      normalizeRed: false,
      normalizeGreen: false,
      normalizeBlue: false,
    };
    return { instance: { ...instance('colorCalibration', params), label: 'rgb primaries' }, status: 'mapped' };
  },
};
