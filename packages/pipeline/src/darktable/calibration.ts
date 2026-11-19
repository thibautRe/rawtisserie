/**
 * darktable's white balance (`temperature.c`) and colour calibration (`channelmixerrgb.c`,
 * v3, the same struct in Ansel) as our colour calibration, which is a port of Ansel's.
 *
 * Their illuminants are chromaticities relative to their pipeline's D50 white (their
 * 5003 K "D50" is a no-op); ours are real ones, relative to D65 (`ops/calibration.rs`):
 * each goes through a D50 → D65 Bradford adaptation, but "same as pipeline" (no
 * adaptation) and "as shot" (the file's), which mean the same in both.
 *
 * Our base image is balanced for D65 light (the camera's reference multipliers), as
 * theirs is with white balance on "camera reference" (or darktable 5's late correction).
 * Another white balance is a diagonal in camera RGB before calibration: it's folded
 * into the first calibration instance's illuminant (von Kries in CAT16), or becomes one.
 */
import { type Xy, WHITE_XY, illuminantFromXy, illuminantXy } from '../illuminants.ts';
import { type Adaptation, type ModuleParams, defaultModuleParams } from '../params.ts';
import type { CameraWhite } from '../metadata.ts';
import { Layout } from './struct.ts';
import { type TranslateContext, type Translation, type Translator, instance, unreadable } from './translate.ts';

type Calibration = ModuleParams['colorCalibration'];
type Mat3 = number[][];

const CHANNEL = { array: 'f32', n: 4 } as const;
const CHANNELMIXERRGB_V3 = new Layout([
  ['red', CHANNEL],
  ['green', CHANNEL],
  ['blue', CHANNEL],
  ['saturation', CHANNEL],
  ['lightness', CHANNEL],
  ['grey', CHANNEL],
  ['normalize_R', 'gboolean'],
  ['normalize_G', 'gboolean'],
  ['normalize_B', 'gboolean'],
  ['normalize_sat', 'gboolean'],
  ['normalize_light', 'gboolean'],
  ['normalize_grey', 'gboolean'],
  ['illuminant', 'i32'],
  ['illum_fluo', 'i32'],
  ['illum_led', 'i32'],
  ['adaptation', 'i32'],
  ['x', 'f32'],
  ['y', 'f32'],
  ['temperature', 'f32'],
  ['gamut', 'f32'],
  ['clip', 'gboolean'],
  ['version', 'i32'],
]);

/** darktable 4+ (v4 adds `preset`); Ansel's v3 has `g2` (unused here) in its place. */
const TEMPERATURE_V3 = new Layout([
  ['red', 'f32'],
  ['green', 'f32'],
  ['blue', 'f32'],
  ['g2', 'f32'],
]);
const TEMPERATURE_V4 = new Layout([...TEMPERATURE_V3.fields.map((f) => [f.name, f.type] as const), ['preset', 'i32']]);
/** `DT_IOP_TEMP_D65_LATE`: as shot for demosaicing, undone before colour calibration. */
const PRESET_D65_LATE = 4;

const FLUORESCENTS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;
const LEDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'bh1', 'rgb1', 'v1', 'v2'] as const;
/** `dt_adaptation_t`: linear Bradford, CAT16, full Bradford, XYZ, none (RGB). */
const ADAPTATIONS: readonly Adaptation[] = ['linearBradford', 'cat16', 'linearBradford', 'xyz', 'none'];

const D50: Xy = [0.3457029, 0.3585386];

// ── Chromaticities ────────────────────────────────────────────────────────────

const XYZ_TO_BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const XYZ_TO_CAT16: Mat3 = [
  [0.401288, 0.650173, -0.051461],
  [-0.250268, 1.204414, 0.045854],
  [-0.002079, 0.048952, 0.953127],
];

const mulVec = (m: Mat3, v: number[]) => m.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!);
function inverse(m: Mat3): Mat3 {
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
const toXyz = ([x, y]: Xy) => [x / y, 1, (1 - x - y) / y];
const toXy = ([X, Y, Z]: number[]): Xy => [X! / (X! + Y! + Z!), Y! / (X! + Y! + Z!)];

/** Von Kries in `space` (XYZ → LMS): `xy` seen as a light under `from`, moved so that `from` becomes `to`. */
function adapt(xy: Xy, from: Xy, to: Xy, space: Mat3): Xy {
  const lms = mulVec(space, toXyz(xy));
  const [f, t] = [mulVec(space, toXyz(from)), mulVec(space, toXyz(to))];
  return toXy(
    mulVec(
      inverse(space),
      lms.map((v, i) => (v * t[i]!) / f[i]!),
    ),
  );
}

/** A darktable illuminant (relative to its D50 white) as ours (relative to D65). */
const fromDarktable = (xy: Xy): Xy => adapt(xy, D50, WHITE_XY, XYZ_TO_BRADFORD);

/** The light that multipliers `wb` neutralise (`color::illuminant_of_wb`). */
function lightOfWb(wb: number[], camera: CameraWhite): Xy | null {
  const rgb = camera.reference.map((r, c) => r / wb[c]!);
  const xy = toXy(mulVec(camera.xyzFromCamera, rgb));
  return xy.every((v) => Number.isFinite(v) && v > 0) ? xy : null;
}

// ── White balance ─────────────────────────────────────────────────────────────

/**
 * The light the history's white balance takes as white, when it isn't D65 (the camera's
 * reference, which our base image has already): null when it is, or isn't known.
 */
function whiteBalanceLight(ctx: TranslateContext): { light: Xy | null; note?: string } {
  const entry = ctx.active.find((e) => e.operation === 'temperature');
  const bytes = entry && ctx.paramsOf(entry);
  const p =
    bytes && (entry.modversion === 4 ? TEMPERATURE_V4 : entry.modversion === 3 ? TEMPERATURE_V3 : null)?.read(bytes);
  if (entry && !p) return { light: null, note: `White balance: version ${entry.modversion} isn't supported` };
  if (p && entry!.enabled && p.preset === PRESET_D65_LATE) return { light: null };
  const camera = ctx.metadata.cameraWhite;
  if (!camera) return { light: null, note: "The camera's white balance data isn't known: its own is used" };
  const g = p && entry!.enabled ? (p.green as number) || 1 : 1;
  // Off: the camera's raw colours (no multipliers at all).
  const wb = p && entry!.enabled ? [(p.red as number) / g, 1, (p.blue as number) / g] : [1, 1, 1];
  if (wb.every((v, c) => Math.abs(v / camera.reference[c]! - 1) < 0.015)) return { light: null };
  const light = lightOfWb(wb, camera);
  return light ? { light } : { light: null, note: 'Its white balance could not be read' };
}

// ── Colour calibration ────────────────────────────────────────────────────────

/** An illuminant of ours for the light `xy` (daylight, black body or custom). */
const fromXy = (xy: Xy): Partial<Calibration> => illuminantFromXy(xy);

/** `p` (theirs) as ours, before the white balance is folded in. */
function calibrationParams(p: Record<string, unknown>, notes: string[]): Calibration {
  const out: Calibration = structuredClone(defaultModuleParams.colorCalibration);
  const three = (v: unknown) => (v as number[]).slice(0, 3);
  Object.assign(out, {
    red: three(p.red),
    green: three(p.green),
    blue: three(p.blue),
    colorfulness: three(p.saturation),
    brightness: three(p.lightness),
    grey: three(p.grey),
    normalizeRed: p.normalize_R,
    normalizeGreen: p.normalize_G,
    normalizeBlue: p.normalize_B,
    normalizeColorfulness: p.normalize_sat,
    normalizeBrightness: p.normalize_light,
    normalizeGrey: p.normalize_grey,
    gamut: p.gamut,
    clip: p.clip,
    adaptation: ADAPTATIONS[p.adaptation as number] ?? 'cat16',
  });
  if (p.adaptation === 2) notes.push('Non-linear Bradford adaptation done as linear');
  const ill = p.illuminant as number;
  if (ill === 0) out.illuminant = 'pipeline';
  else if (ill === 10) out.illuminant = 'asShot';
  else {
    const theirs: Calibration = {
      ...out,
      temperature: p.temperature as number,
      x: p.x as number,
      y: p.y as number,
      fluorescent: FLUORESCENTS[p.illum_fluo as number] ?? 'f3',
      led: LEDS[p.illum_led as number] ?? 'b5',
      // 8, 9: detected from the image (surfaces, edges), kept as the light found.
      illuminant:
        (
          { 1: 'a', 2: 'daylight', 3: 'e', 4: 'fluorescent', 5: 'led', 6: 'blackBody' } as Record<
            number,
            Calibration['illuminant']
          >
        )[ill] ?? 'custom',
    };
    Object.assign(out, fromXy(fromDarktable(illuminantXy(theirs, null))));
  }
  return out;
}

/**
 * Ours, with a white balance that took `light` as white folded in: theirs adapts from
 * their illuminant what that white balance gave; ours from the light that does both.
 */
function foldWhiteBalance(p: Calibration, light: Xy, asShot: Xy | null): Calibration {
  const adapts = p.illuminant !== 'pipeline' && p.adaptation !== 'none';
  const from = adapts ? illuminantXy(p, asShot) : WHITE_XY;
  const both = adapt(from, WHITE_XY, light, XYZ_TO_CAT16);
  return { ...p, ...fromXy(both), ...(!adapts && { adaptation: 'cat16' as const }) };
}

export const calibration: Translator = {
  operations: ['channelmixerrgb', 'temperature'],
  kinds: ['colorCalibration'],
  translate(entry, bytes, ctx): Translation {
    const calibrations = ctx.active.filter((e) => e.operation === 'channelmixerrgb' && e.enabled);
    const wb = whiteBalanceLight(ctx);
    const asShot = ctx.metadata.asShotIlluminant ?? null;
    if (entry.operation === 'temperature') {
      if (!wb.light)
        return { instance: null, status: wb.note ? 'approximated' : 'mapped', ...(wb.note && { note: wb.note }) };
      const note = 'Not the camera reference: folded into colour calibration';
      // No calibration to fold it into: one of its own.
      if (calibrations.length) return { instance: null, status: 'approximated', note };
      const params: Calibration = {
        ...defaultModuleParams.colorCalibration,
        ...fromXy(wb.light),
        gamut: 0,
        clip: false,
      };
      return { instance: instance('colorCalibration', params), status: 'approximated', note };
    }
    const p = entry.modversion === 3 ? CHANNELMIXERRGB_V3.read(bytes) : null;
    if (!p) return unreadable(entry);
    const notes: string[] = [];
    let params = calibrationParams(p, notes);
    // The white balance goes into the first instance that applies.
    if (wb.light && calibrations[0] === entry) {
      params = foldWhiteBalance(params, wb.light, asShot);
      notes.push('With the white balance folded in');
    }
    return {
      instance: instance('colorCalibration', params),
      status: notes.length ? 'approximated' : 'mapped',
      ...(notes.length && { note: notes.join('. ') }),
    };
  },
};
