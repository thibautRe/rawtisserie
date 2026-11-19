/**
 * Ansel's own colour modules, which ours are ports of: colour primaries
 * (`colorprimaries.c`, our colour primaries, the same units) and split-toning rgb
 * (`splittoningrgb.c`, our colour balance's mixers).
 *
 * Split-toning has a dark and a bright key (EV relative to luminance 1), each a light
 * (5003 K is neutral: Ansel's D50; ours is 6504 K) and a channel mix; between them it
 * interpolates. Ours: the shadows and highlights mixers, our ranges placed across the
 * keys, and the mid-tones one their average.
 */
import { PRIMARIES, type ModuleParams, type ToneMixer, defaultModuleParams } from '../params.ts';
import { WHITE_XY, daylightXy, xyToCct } from '../illuminants.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

const COLORPRIMARIES_V1 = new Layout([
  ['white_level', 'f32'],
  ['gamut_coverage', 'f32'],
  ['sigma_L', 'f32'],
  ['sigma_rho', 'f32'],
  ['sigma_theta', 'f32'],
  ['neutral_protection', 'f32'],
  ['interpolation', 'i32'],
  ['hue', { array: 'f32', n: 6 }],
  ['saturation', { array: 'f32', n: 6 }],
  ['brightness', { array: 'f32', n: 6 }],
]);

export const colorPrimaries: Translator = {
  operations: ['colorprimaries'],
  kinds: ['colorPrimaries'],
  translate(entry, bytes): Translation {
    const p = entry.modversion === 1 ? COLORPRIMARIES_V1.read(bytes) : null;
    if (!p) return unreadable(entry);
    const [hue, saturation, brightness] = [p.hue, p.saturation, p.brightness] as number[][];
    const params: ModuleParams['colorPrimaries'] = {
      ...structuredClone(defaultModuleParams.colorPrimaries),
      ...Object.fromEntries(
        PRIMARIES.map((name, i) => [name, { hue: hue![i]!, saturation: saturation![i]!, brightness: brightness![i]! }]),
      ),
      whiteLevel: p.white_level as number,
      gamutCoverage: p.gamut_coverage as number,
      brightnessSmoothing: p.sigma_L as number,
      saturationSmoothing: p.sigma_rho as number,
      hueSmoothing: p.sigma_theta as number,
      neutralProtection: p.neutral_protection as number,
    };
    return { instance: instance('colorPrimaries', params), status: 'mapped' };
  },
};

const ROW = { array: 'f32', n: 3 } as const;
const SPLITTONINGRGB_V1 = new Layout([
  ['ev', { array: 'f32', n: 2 }],
  ['temperature', { array: 'f32', n: 2 }],
  ['red', { array: ROW, n: 2 }],
  ['green', { array: ROW, n: 2 }],
  ['blue', { array: ROW, n: 2 }],
  ['normalize', { array: { array: 'gboolean', n: 3 }, n: 2 }],
]);

const D50 = [0.3457029, 0.3585386];
/** Ansel's light (neutral at its D50) as ours (neutral at D65): von Kries in Bradford LMS. */
function temperatureFromAnsel(t: number): number {
  const xy = daylightXy(t);
  if (!xy) return t;
  const M = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
  ];
  const xyz = ([x, y]: number[]) => [x! / y!, 1, (1 - x! - y!) / y!];
  const lms = (v: number[]) => M.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!);
  const [c, from, to] = [lms(xyz(xy)), lms(xyz(D50)), lms(xyz(WHITE_XY))];
  const adapted = c.map((v, i) => (v * to[i]!) / from[i]!);
  // Back to XYZ (the inverse Bradford matrix).
  const inv = [
    [0.986993, -0.147054, 0.159963],
    [0.432305, 0.51836, 0.0492912],
    [-0.0085287, 0.0400428, 0.9684867],
  ];
  const [X, Y, Z] = inv.map((r) => r[0]! * adapted[0]! + r[1]! * adapted[1]! + r[2]! * adapted[2]!);
  return Math.round(xyToCct(X! / (X! + Y! + Z!), Y! / (X! + Y! + Z!)));
}

const GREY_EV = Math.log2(0.1845);

export const splitToning: Translator = {
  operations: ['splittoningrgb'],
  kinds: ['colorBalance'],
  translate(entry, bytes): Translation {
    const p = entry.modversion === 1 ? SPLITTONINGRGB_V1.read(bytes) : null;
    if (!p) return unreadable(entry);
    const ev = p.ev as number[];
    const point = (i: number): ToneMixer => {
      const rows = (k: string) => (p[k] as number[][])[i]!;
      const normalize = (p.normalize as boolean[][])[i]!;
      return {
        temperature: temperatureFromAnsel((p.temperature as number[])[i]!),
        red: rows('red'),
        green: rows('green'),
        blue: rows('blue'),
        normalizeRed: normalize[0]!,
        normalizeGreen: normalize[1]!,
        normalizeBlue: normalize[2]!,
      };
    };
    const [dark, bright] = [point(0), point(1)];
    const average = (a: number[], b: number[]) => a.map((v, i) => (v + b[i]!) / 2);
    const midtones: ToneMixer = {
      temperature: Math.round((dark.temperature + bright.temperature) / 2),
      red: average(dark.red, bright.red),
      green: average(dark.green, bright.green),
      blue: average(dark.blue, bright.blue),
      normalizeRed: dark.normalizeRed && bright.normalizeRed,
      normalizeGreen: dark.normalizeGreen && bright.normalizeGreen,
      normalizeBlue: dark.normalizeBlue && bright.normalizeBlue,
    };
    const span = Math.max(0.5, ev[1]! - ev[0]!);
    const params: ModuleParams['colorBalance'] = {
      ...structuredClone(defaultModuleParams.colorBalance),
      shadows: dark,
      midtones,
      highlights: bright,
      fulcrum: (ev[0]! + ev[1]!) / 2 - GREY_EV,
      midtonesRange: span / 2,
      shadowsFalloff: span / 2,
      highlightsFalloff: span / 2,
    };
    return {
      instance: instance('colorBalance', params),
      status: 'approximated',
      note: 'Its two keys as our shadows and highlights',
    };
  },
};
