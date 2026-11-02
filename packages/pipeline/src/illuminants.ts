/**
 * Illuminants for colour calibration's controls, after Ansel's `pixel/illuminants.h`
 * (GPL-3.0-or-later). Chromaticities are CIE 1931 xy; the working space's white is D65.
 * The chromaticity of each setting mirrors `illuminant_xy` in
 * `crates/pipeline/src/ops/calibration.rs`, which is what renders.
 */

import type { Fluorescent, Illuminant, Led, ModuleParams } from './params.ts';

export type Xy = [number, number];

/** The working space's white (D65), as the Rust pipeline computes it. */
export const WHITE_XY: Xy = [0.3127266, 0.3290232];

export const TEMPERATURE_MIN = 1667;
export const TEMPERATURE_MAX = 25000;

export const FLUORESCENT_XY: Record<Fluorescent, Xy> = {
  f1: [0.3131, 0.33727],
  f2: [0.37208, 0.37529],
  f3: [0.4091, 0.3943],
  f4: [0.44018, 0.40329],
  f5: [0.31379, 0.34531],
  f6: [0.3779, 0.38835],
  f7: [0.31292, 0.32933],
  f8: [0.34588, 0.35875],
  f9: [0.37417, 0.37281],
  f10: [0.34609, 0.35986],
  f11: [0.38052, 0.37713],
  f12: [0.43695, 0.40441],
};

export const LED_XY: Record<Led, Xy> = {
  b1: [0.456, 0.4078],
  b2: [0.4357, 0.4012],
  b3: [0.3756, 0.3723],
  b4: [0.3422, 0.3502],
  b5: [0.3118, 0.3236],
  bh1: [0.4474, 0.4066],
  rgb1: [0.4557, 0.4211],
  v1: [0.456, 0.4548],
  v2: [0.3781, 0.3775],
};

/** CIE daylight at a correlated colour temperature, 4000 … 25000 K. */
export function daylightXy(t: number): Xy | null {
  let x: number;
  if (t >= 4000 && t <= 7000) x = ((-4.607e9 / t + 2.9678e6) / t + 0.09911e3) / t + 0.244063;
  else if (t > 7000 && t <= 25000) x = ((-2.0064e9 / t + 1.9018e6) / t + 0.24748e3) / t + 0.23704;
  else return null;
  return [x, (-3 * x + 2.87) * x - 0.275];
}

/** The Planckian locus, 1667 … 25000 K. */
export function blackBodyXy(t: number): Xy | null {
  let x: number;
  if (t >= 1667 && t <= 4000) x = ((-0.2661239e9 / t - 0.2343589e6) / t + 0.8776956e3) / t + 0.17991;
  else if (t > 4000 && t <= 25000) x = ((-3.0258469e9 / t + 2.1070379e6) / t + 0.2226347e3) / t + 0.24039;
  else return null;
  let y: number;
  if (t <= 2222) y = ((-1.1063814 * x - 1.3481102) * x + 2.18555832) * x - 0.20219683;
  else if (t <= 4000) y = ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867;
  else y = ((3.081758 * x - 5.8733867) * x + 3.75112997) * x - 0.37001483;
  return [x, y];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The light an instance adapts from; `asShot` is the file's (`PhotoMetadata.asShotIlluminant`). */
export function illuminantXy(p: ModuleParams['colorCalibration'], asShot: Xy | null | undefined): Xy {
  const t = clamp(p.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX);
  switch (p.illuminant) {
    case 'asShot':
      return asShot ?? WHITE_XY;
    case 'pipeline':
      return WHITE_XY;
    case 'daylight':
      return daylightXy(t) ?? blackBodyXy(t) ?? WHITE_XY;
    case 'blackBody':
      return blackBodyXy(t) ?? WHITE_XY;
    case 'a':
      return [0.44757, 0.40745];
    case 'e':
      return [1 / 3, 1 / 3];
    case 'fluorescent':
      return FLUORESCENT_XY[p.fluorescent];
    case 'led':
      return LED_XY[p.led];
    case 'custom':
      return p.x > 0 && p.y > 0 && p.x + p.y < 1 ? [p.x, p.y] : WHITE_XY;
  }
}

/** Correlated colour temperature (McCamy's approximation, valid for 3000 … 50000 K). */
function mcCamy(x: number, y: number) {
  const n = (x - 0.3366) / (y - 0.1735);
  return -949.86315 + 6253.80338 * Math.exp(-n / 0.92159) + 28.70599 * Math.exp(-n / 0.20039) + 0.00004 * Math.exp(-n / 0.07125);
}

/** The closest temperature on the daylight/black body locus, by brute force (Ansel's `CCT_reverse_lookup`). */
function reverseLookup(x: number, y: number) {
  const samples = 1 << 16;
  let best = { radius: Infinity, t: 0 };
  for (let i = 0; i < samples; i++) {
    const t = TEMPERATURE_MIN + (i / (samples - 1)) ** 4 * (TEMPERATURE_MAX - TEMPERATURE_MIN);
    const [bx, by] = (t >= 4000 ? daylightXy(t) : blackBodyXy(t))!;
    const radius = Math.hypot(bx - x, by - y);
    if (radius < best.radius) best = { radius, t };
  }
  return best.t;
}

/** Correlated colour temperature of a chromaticity, in kelvin. */
export function xyToCct(x: number, y: number): number {
  const t = mcCamy(x, y);
  return t < 3000 && t > TEMPERATURE_MIN ? reverseLookup(x, y) : t;
}

/** CIE 1960 uv. */
function uv([x, y]: Xy): Xy {
  const d = 12 * y - 1.882 * x + 2.9088;
  return [(5.5932 * x + 1.9116 * y) / d, (7.8972 * y) / d];
}

/**
 * The temperature of a light, and whether a daylight or black body spectrum at that
 * temperature matches it (within 0.005 in CIE 1960 uv); otherwise it takes a custom
 * illuminant. Ansel's `check_if_close_to_daylight`.
 */
export function closestIlluminant(xy: Xy): { temperature: number; illuminant: 'daylight' | 'blackBody' | 'custom' } {
  const temperature = xyToCct(xy[0], xy[1]);
  const t = clamp(temperature, TEMPERATURE_MIN, TEMPERATURE_MAX);
  const ref = uv(xy);
  const error = (test: Xy | null) => (test ? Math.hypot(uv(test)[0] - ref[0], uv(test)[1] - ref[1]) : Infinity);
  const daylight = error(daylightXy(t) ?? blackBodyXy(t));
  const blackBody = error(blackBodyXy(t));
  if (blackBody < 0.005 || daylight < 0.005) return { temperature, illuminant: blackBody < daylight ? 'blackBody' : 'daylight' };
  return { temperature, illuminant: 'custom' };
}

/** CIE 1976 u'v'. */
function uvPrime([x, y]: Xy): Xy {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (9 * y) / d];
}

/**
 * Hue (degrees) and chroma of a light, as CIE L*u*v* at L* = 100 around the working
 * space's white (Ansel uses D50, its pipeline's white).
 */
export function xyToHueChroma(xy: Xy): { hue: number; chroma: number } {
  const [u, v] = uvPrime(xy);
  const [wu, wv] = uvPrime(WHITE_XY);
  const [du, dv] = [1300 * (u - wu), 1300 * (v - wv)];
  const hue = (Math.atan2(dv, du) * 180) / Math.PI;
  return { hue: hue < 0 ? hue + 360 : hue, chroma: Math.hypot(du, dv) };
}

export function hueChromaToXy(hue: number, chroma: number): Xy {
  const [wu, wv] = uvPrime(WHITE_XY);
  const h = (hue * Math.PI) / 180;
  const [u, v] = [(chroma * Math.cos(h)) / 1300 + wu, (chroma * Math.sin(h)) / 1300 + wv];
  const d = 6 * u - 16 * v + 12;
  return [(9 * u) / d, (4 * v) / d];
}

/** A CSS colour showing a light, at full brightness (for swatches and slider tracks). */
export function xyToCss([x, y]: Xy): string {
  const [X, Y, Z] = [x / y, 1, (1 - x - y) / y];
  const rgb = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ].map((c) => Math.max(c, 0));
  const max = Math.max(...rgb);
  const encode = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return `rgb(${rgb.map((c) => encode(c / max)).join(' ')})`;
}

type Calibration = ModuleParams['colorCalibration'];
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const kelvin = (t: number) => Math.round(clamp(t, TEMPERATURE_MIN, TEMPERATURE_MAX));

/**
 * Switch an instance to another kind of illuminant, starting from the light it has now,
 * as Ansel does: a temperature becomes the current light's, a custom illuminant takes
 * its chromaticity. Leaving "as shot" (always CAT16) keeps CAT16.
 */
export function switchIlluminant(p: Calibration, illuminant: Illuminant, asShot: Xy | null | undefined): Partial<Calibration> {
  const xy = illuminantXy(p, asShot);
  const patch: Partial<Calibration> = { illuminant };
  if (p.illuminant === 'asShot') patch.adaptation = 'cat16';
  if (illuminant === 'custom') [patch.x, patch.y] = xy.map((v) => round(v, 4)) as Xy;
  const hasTemperature = (i: Illuminant) => i === 'daylight' || i === 'blackBody';
  if (hasTemperature(illuminant) && !hasTemperature(p.illuminant)) patch.temperature = kelvin(xyToCct(xy[0], xy[1]));
  return patch;
}

/** Settings for a measured light (auto-detection): a daylight or black body temperature when one matches, otherwise custom. */
export function illuminantFromXy(xy: Xy): Partial<Calibration> {
  const { temperature, illuminant } = closestIlluminant(xy);
  return { illuminant, temperature: kelvin(temperature), x: round(xy[0], 4), y: round(xy[1], 4), adaptation: 'cat16' };
}
