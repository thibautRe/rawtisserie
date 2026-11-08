/**
 * Colour calibration's channel mixer, seen as primaries: Ansel's "primaries" and
 * "white preserving" mixer modes (`iop/channelmixerrgb_shared.c`, GPL-3.0-or-later).
 * They are UI parametrisations: the recipe keeps the 3×3 matrix (`red`, `green`,
 * `blue` rows), which the controls are read from and written back to.
 *
 * The mixer acts in the adaptation's space (CAT16 or Bradford LMS, XYZ, or RGB). Each
 * column is where an input channel goes: a primary. Primaries live in that space's
 * affine chromaticity plane (vectors summing to 1), around its white. Ansel's white is
 * its pipeline's D50; ours is D65, as in the rest of the module.
 *
 * Deviation: in primaries mode, the "white" Ansel rotates and scales is where the mixer
 * sends (1, 1, 1). Outside RGB that isn't the white, so there even the identity reads as a
 * white cast. Here it is where the mixer sends the basis white, as in the white-preserving
 * mode: white purity 0 means no cast.
 */

import { type Adaptation, type ModuleParams, XYZ_FROM_REC709, XYZ_TO_CAT16 } from './params.ts';

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];
type Calibration = ModuleParams['colorCalibration'];

/** A mixer's rows, as colour calibration and colour balance's ranges (`ToneMixer`) store them. */
export type MixerRows = Pick<
  Calibration,
  'red' | 'green' | 'blue' | 'normalizeRed' | 'normalizeGreen' | 'normalizeBlue'
>;

/** Where colour balance's mixers act: linear Rec.2020, whose white is (1, 1, 1). */
export const RGB_WHITE: Vec3 = [1, 1, 1];

/** Ansel's primaries mode. Angles in degrees (Ansel's sliders show degrees too). */
export interface MixerPrimaries {
  /** Rotation of the white the mixer maps the basis white to, from the red direction. */
  whiteHue: number;
  /** How far that white is from the basis white, relative to the gamut's edge; 0 = no cast. */
  whitePurity: number;
  redHue: number;
  /** Distance to the white, relative to the gamut's edge: 1 keeps the primary, 0 makes it white. */
  redPurity: number;
  greenHue: number;
  greenPurity: number;
  blueHue: number;
  bluePurity: number;
  /** Brightness of the white. */
  gain: number;
}

/** Ansel's white-preserving mode: whites stay put. Rotations in degrees. */
export interface MixerWhitePreserving {
  redRotation: number;
  /** Distance to the white × (1 + saturation): -1 makes the primary white, +1 doubles it. */
  redSaturation: number;
  greenRotation: number;
  greenSaturation: number;
  blueRotation: number;
  blueSaturation: number;
}

export const IDENTITY_PRIMARIES: MixerPrimaries = {
  whiteHue: 0,
  whitePurity: 0,
  redHue: 0,
  redPurity: 1,
  greenHue: 0,
  greenPurity: 1,
  blueHue: 0,
  bluePurity: 1,
  gain: 1,
};
export const IDENTITY_WHITE_PRESERVING: MixerWhitePreserving = {
  redRotation: 0,
  redSaturation: 0,
  greenRotation: 0,
  greenSaturation: 0,
  blueRotation: 0,
  blueSaturation: 0,
};

const EPS = 5e-5;
/** Smallest primaries triangle, relative to the basis one, the white-preserving mode accepts. */
const MIN_FOOTPRINT = 0.02;
const DEG = Math.PI / 180;

const XYZ_TO_BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

const mulVec = (m: number[][], v: number[]): Vec3 =>
  [0, 1, 2].map((i) => m[i]![0]! * v[0]! + m[i]![1]! * v[1]! + m[i]![2]! * v[2]!) as Vec3;
const sum3 = (v: number[]) => v[0]! + v[1]! + v[2]!;

/** The working space's white in the space the mixer acts in. As shot always uses CAT16. */
export function mixerWhite(p: Pick<Calibration, 'adaptation' | 'illuminant'>): Vec3 {
  const adaptation: Adaptation = p.illuminant === 'asShot' ? 'cat16' : p.adaptation;
  const xyz = mulVec(XYZ_FROM_REC709, [1, 1, 1]);
  switch (adaptation) {
    case 'cat16':
      return mulVec(XYZ_TO_CAT16, xyz);
    case 'linearBradford':
      return mulVec(XYZ_TO_BRADFORD, xyz);
    case 'xyz':
      return xyz;
    case 'none':
      return [1, 1, 1];
  }
}

/** The instance's mixer matrix (rows: outputs), normalised like the pipeline does. */
export function mixerMatrix(p: MixerRows): Mat3 {
  const row = (r: number[], normalize: boolean): Vec3 => {
    const n = normalize ? sum3(r) : 1;
    return r.map((c) => c / n) as Vec3;
  };
  return [row(p.red, p.normalizeRed), row(p.green, p.normalizeGreen), row(p.blue, p.normalizeBlue)];
}

/** The recipe fields for a mixer matrix (rounded, rows not normalised). */
export function mixerRows(m: Mat3): MixerRows {
  const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
  const [red, green, blue] = m.map((r) => r.map(round));
  return { red: red!, green: green!, blue: blue!, normalizeRed: false, normalizeGreen: false, normalizeBlue: false };
}

function invert(m: Mat3): Mat3 | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

// The affine plane (sum = 1), with an orthonormal basis.
const S2 = 0.7071067811865475;
const S6 = 0.4082482904638631;
const S6B = 0.8164965809277261;
const project = (d: number[]): [number, number] => [S2 * (d[0]! - d[1]!), S6 * (d[0]! + d[1]!) - S6B * d[2]!];
const unproject = ([u, v]: [number, number]): Vec3 => [S2 * u + S6 * v, -S2 * u + S6 * v, -S6B * v];
const affine = (v: number[]): Vec3 | null => (Math.abs(sum3(v)) < EPS ? null : (v.map((c) => c / sum3(v)) as Vec3));
const rotate = ([x, y]: [number, number], a: number): [number, number] => [
  Math.cos(a) * x - Math.sin(a) * y,
  Math.sin(a) * x + Math.cos(a) * y,
];
const wrapPi = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

/** The basis white (normalised) and the basis primaries around it, in the affine plane. */
function simplex(white: Vec3) {
  const w = affine(white);
  if (!w) return null;
  const primaries = [0, 1, 2].map((i) => project([0, 1, 2].map((c) => (c === i ? 1 : 0) - w[c]!))) as [
    number,
    number,
  ][];
  return { w, primaries };
}

/** Distance from the white to the basis triangle's edge, along a unit direction. */
function distanceToEdge(dir: [number, number], primaries: [number, number][]) {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const [a, b] = [primaries[i]!, primaries[(i + 1) % 3]!];
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    const den = dir[0] * ey - dir[1] * ex;
    if (Math.abs(den) < EPS) continue;
    const t = (a[0] * ey - a[1] * ex) / den;
    const u = (a[0] * dir[1] - a[1] * dir[0]) / den;
    if (t >= 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

function pointFromPolar(
  s: NonNullable<ReturnType<typeof simplex>>,
  ref: number,
  hue: number,
  purity: number,
): Vec3 | null {
  const r = s.primaries[ref]!;
  const radius = Math.hypot(r[0], r[1]);
  if (radius < EPS) return null;
  const dir = rotate([r[0] / radius, r[1] / radius], hue);
  const edge = distanceToEdge(dir, s.primaries);
  if (edge === Infinity) return null;
  const d = unproject([purity * edge * dir[0], purity * edge * dir[1]]);
  return s.w.map((c, i) => c + d[i]!) as Vec3;
}

function polarFromPoint(
  s: NonNullable<ReturnType<typeof simplex>>,
  ref: number,
  point: Vec3,
): { hue: number; purity: number } | null {
  const r = s.primaries[ref]!;
  const uv = project(point.map((c, i) => c - s.w[i]!));
  const radius = Math.hypot(uv[0], uv[1]);
  if (radius < EPS) return { hue: 0, purity: 0 };
  const dir: [number, number] = [uv[0] / radius, uv[1] / radius];
  const edge = distanceToEdge(dir, s.primaries);
  if (edge === Infinity || edge < EPS) return null;
  return { hue: wrapPi(Math.atan2(dir[1], dir[0]) - Math.atan2(r[1], r[0])), purity: radius / edge };
}

const column = (m: Mat3, c: number): Vec3 => [m[0][c]!, m[1][c]!, m[2][c]!];
const fromColumns = (cols: Vec3[], scales: number[]): Mat3 =>
  [0, 1, 2].map((row) => [0, 1, 2].map((col) => scales[col]! * cols[col]![row]!)) as Mat3;

/** Ansel's `primaries_to_matrix`. Null when the primaries are degenerate. */
export function primariesToMatrix(white: Vec3, p: MixerPrimaries): Mat3 | null {
  const s = simplex(white);
  if (!s || Math.abs(sum3(white)) < EPS) return null;
  const customWhite = pointFromPolar(s, 0, p.whiteHue * DEG, p.whitePurity);
  const cols = [
    pointFromPolar(s, 0, p.redHue * DEG, p.redPurity),
    pointFromPolar(s, 1, p.greenHue * DEG, p.greenPurity),
    pointFromPolar(s, 2, p.blueHue * DEG, p.bluePurity),
  ];
  if (!customWhite || cols.some((c) => !c)) return null;
  const inverse = invert([0, 1, 2].map((row) => [0, 1, 2].map((col) => cols[col]![row]!)) as Mat3);
  if (!inverse) return null;
  // Column scales such that the basis white maps to the custom white.
  const weights = mulVec(
    inverse,
    customWhite.map((c) => c * p.gain * sum3(white)),
  );
  if (white.some((c) => Math.abs(c) < EPS)) return null;
  return fromColumns(
    cols as Vec3[],
    weights.map((t, c) => t / white[c]!),
  );
}

/** Ansel's `primaries_from_matrix`. Null when the matrix can't be shown as primaries. */
export function primariesFromMatrix(white: Vec3, m: Mat3): MixerPrimaries | null {
  const s = simplex(white);
  if (!s || !invert(m) || Math.abs(sum3(white)) < EPS) return null;
  const mappedWhite = mulVec(m, white);
  const w = affine(mappedWhite);
  const achromatic = w && polarFromPoint(s, 0, w);
  if (!achromatic) return null;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const point = affine(column(m, c));
    const polar = point && polarFromPoint(s, c, point);
    if (!polar) return null;
    out.push(polar.hue / DEG, polar.purity);
  }
  const [redHue, redPurity, greenHue, greenPurity, blueHue, bluePurity] = out as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const result = {
    whiteHue: achromatic.hue / DEG,
    whitePurity: achromatic.purity,
    redHue,
    redPurity,
    greenHue,
    greenPurity,
    blueHue,
    bluePurity,
    gain: sum3(mappedWhite) / sum3(white),
  };
  const back = primariesToMatrix(white, result);
  return back && roundtripError(m, back) <= 1e-4 ? result : null;
}

const area = (v: [number, number][]) =>
  (v[1]![0] - v[0]![0]) * (v[2]![1] - v[0]![1]) - (v[1]![1] - v[0]![1]) * (v[2]![0] - v[0]![0]);

/** Ansel's `white_preserving_to_matrix`. Null when the primaries are (nearly) collinear. */
export function whitePreservingToMatrix(white: Vec3, p: MixerWhitePreserving): Mat3 | null {
  const s = simplex(white);
  if (!s) return null;
  const params = [
    [p.redRotation, p.redSaturation],
    [p.greenRotation, p.greenSaturation],
    [p.blueRotation, p.blueSaturation],
  ] as const;
  const footprint = params.map(([rotation, saturation], i) => {
    const [u, v] = rotate(s.primaries[i]!, rotation * DEG);
    return [(1 + saturation) * u, (1 + saturation) * v] as [number, number];
  });
  if (Math.abs(area(footprint)) < MIN_FOOTPRINT * Math.abs(area(s.primaries))) return null;
  const cols = footprint.map((uv) => {
    const d = unproject(uv);
    return s.w.map((c, i) => c + d[i]!) as Vec3;
  });
  const inverse = invert([0, 1, 2].map((row) => [0, 1, 2].map((col) => cols[col]![row]!)) as Mat3);
  if (!inverse || white.some((c) => Math.abs(c) < EPS)) return null;
  // Column scales such that the white maps to itself.
  const weights = mulVec(inverse, white);
  return fromColumns(
    cols,
    weights.map((t, c) => t / white[c]!),
  );
}

/** The rotation and saturation of each column of a matrix, whether it keeps the white or not. */
function whitePreservingDirections(white: Vec3, m: Mat3): MixerWhitePreserving | null {
  const s = simplex(white);
  if (!s) return null;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const point = affine(column(m, c));
    const r = s.primaries[c]!;
    const radius0 = Math.hypot(r[0], r[1]);
    if (!point || radius0 < EPS) return null;
    const uv = project(point.map((v, i) => v - s.w[i]!));
    const radius = Math.hypot(uv[0], uv[1]);
    if (radius < EPS) out.push(0, -1);
    else out.push(wrapPi(Math.atan2(uv[1], uv[0]) - Math.atan2(r[1], r[0])) / DEG, radius / radius0 - 1);
  }
  const [redRotation, redSaturation, greenRotation, greenSaturation, blueRotation, blueSaturation] = out as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { redRotation, redSaturation, greenRotation, greenSaturation, blueRotation, blueSaturation };
}

/** Ansel's `white_preserving_from_matrix`, or null if the matrix moves the white. */
export function whitePreservingFromMatrix(white: Vec3, m: Mat3): MixerWhitePreserving | null {
  const result = whitePreservingDirections(white, m);
  // Only the column directions were read: check that the matrix really is white-preserving.
  const back = result && whitePreservingToMatrix(white, result);
  return back && roundtripError(m, back) <= 1e-4 ? result : null;
}

/**
 * The white-preserving matrix with the same primaries (column directions) as `m`: `m`
 * without the shift it gives the white (a tint, a brightness change). Null when its
 * primaries are degenerate.
 */
export function withoutWhiteShift(white: Vec3, m: Mat3): Mat3 | null {
  const directions = whitePreservingDirections(white, m);
  return directions && whitePreservingToMatrix(white, directions);
}

/** Largest coefficient difference, relative to the largest coefficient (at least 1). */
export function roundtripError(a: Mat3, b: Mat3): number {
  let error = 0;
  let magnitude = 1;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      error = Math.max(error, Math.abs(a[i]![j]! - b[i]![j]!));
      magnitude = Math.max(magnitude, Math.abs(a[i]![j]!));
    }
  return error / magnitude;
}
