/**
 * darktable's and Ansel's tone mappers as our filmic: filmic rgb (`filmicrgb.c`, which
 * ours is a port of: parameter for parameter), and darktable's sigmoid and AgX, whose
 * curves are fitted with filmic's (`fitFilmic`).
 *
 * `FilmicCurve` is our filmic's curve (`ops/filmic.rs`'s `Spline`), ported to compare
 * curves here; `importedEdits.test.ts` checks it against Rust's.
 */
import { type ModuleParams, defaultModuleParams } from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';
import type { DarktableEntry } from './xmp.ts';

type Filmic = ModuleParams['filmic'];

// ── Our filmic's curve ────────────────────────────────────────────────────────

const SAFETY_MARGIN = 0.01;
const GREY = 0.1845;
const TOE_POWER = 1.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function sigmoidScale(limitX: number, limitY: number, transX: number, transY: number, slope: number, power: number) {
  const projected = slope * Math.max(limitX - transX, 1e-6);
  const actual = Math.max(limitY - transY, 1e-6);
  const base = Math.max(actual ** -power - projected ** -power, 1e-6);
  return Math.min(base ** (-1 / power), 1e9);
}

/** Our filmic's tone curve: scene-linear (middle grey 0.1845) → display-linear. Mirrors `filmic::Spline`. */
export class FilmicCurve {
  private x: number[];
  private y: number[];
  private contrast: number;
  private intercept: number;
  private toeScale: number;
  private toeFallback: [number, number] | null;
  private shoulder: [number, number];
  readonly power: number;
  private blackSource: number;
  private dynamicRange: number;

  constructor(p: Filmic) {
    const white = clamp(p.whiteExposure, 0.1, 16);
    const black = clamp(p.blackExposure, -16, -0.1);
    const range = white - black;
    const greyLog = Math.abs(black) / range;
    const power = p.autoHardness ? Math.log(GREY) / Math.log(greyLog) : clamp(p.hardness, 1, 10);
    const blackTarget = clamp(p.blackTarget, 0, 20) / 100;
    const whiteTarget = clamp(p.whiteTarget, 20, 100) / 100;
    const greyDisplay = GREY ** (1 / power);
    const blackDisplay = Math.min(blackTarget, GREY) ** (1 / power);
    const whiteDisplay = Math.max(whiteTarget, GREY) ** (1 / power);
    const slope = (clamp(p.contrast, 0, 5) * range) / 8;
    const minContrast =
      Math.max(1, (whiteDisplay - greyDisplay) / (1 - greyLog), (greyDisplay - blackDisplay) / greyLog) + SAFETY_MARGIN;
    const contrast = clamp(slope / (power * greyDisplay ** (power - 1)), minContrast, 100);
    let intercept = greyDisplay - contrast * greyLog;
    const margin = SAFETY_MARGIN * (whiteDisplay - blackDisplay);
    const xmin = (blackDisplay + margin - intercept) / contrast;
    const xmax = (whiteDisplay - margin - intercept) / contrast;
    const toe = clamp(p.toe, 0, 100) / 100;
    const shoulder = clamp(p.shoulder, 0, 100) / 100;
    const toeLog = greyLog - toe * (greyLog - xmin);
    const shoulderLog = greyLog + shoulder * (xmax - greyLog);
    const x = [0, toeLog, greyLog, shoulderLog, 1];
    const y = [
      blackDisplay,
      toeLog * contrast + intercept,
      greyDisplay,
      shoulderLog * contrast + intercept,
      whiteDisplay,
    ];
    let [dx, dy] = [Math.max(x[1]!, 1e-6), Math.max(y[1]! - y[0]!, 1e-6)];
    this.toeScale = -sigmoidScale(1, 1 - y[0]!, 1 - x[1]!, 1 - y[1]!, contrast, TOE_POWER);
    this.toeFallback = dy / dx > contrast ? [dy / dx ** ((contrast * dx) / dy), (contrast * dx) / dy] : null;
    [dx, dy] = [Math.max(1 - x[3]!, 1e-6), Math.max(y[4]! - y[3]!, 1e-6)];
    const q = (contrast * dx) / dy;
    this.shoulder = [dy / dx ** q, q];
    intercept = y[1]! - contrast * x[1]!;
    this.x = x;
    this.y = y;
    this.contrast = contrast;
    this.intercept = intercept;
    this.power = power;
    this.blackSource = black;
    this.dynamicRange = range;
  }

  private eval(x: number): number {
    const [latMin, latMax] = [this.x[1]!, this.x[3]!];
    if (x < latMin) {
      if (this.toeFallback)
        return this.y[0]! + Math.max(this.toeFallback[0] * Math.max(x, 0) ** this.toeFallback[1], 0);
      const ty = latMin * this.contrast + this.intercept;
      const u = (this.contrast * (x - latMin)) / this.toeScale;
      return this.toeScale * (u / (1 + u ** TOE_POWER) ** (1 / TOE_POWER)) + ty;
    }
    if (x > latMax) return this.y[4]! - Math.max(this.shoulder[0] * Math.max(1 - x, 0) ** this.shoulder[1], 0);
    return this.intercept + x * this.contrast;
  }

  /** Scene-linear → display-linear (per channel, as filmic applies it). */
  toneMap(v: number): number {
    let log = clamp((Math.log2(v / GREY) - this.blackSource) / this.dynamicRange, 0, 1);
    if (Number.isNaN(log)) log = 0;
    return clamp(this.eval(log), 0, this.y[4]!) ** this.power;
  }
}

// ── filmic rgb ────────────────────────────────────────────────────────────────

const FILMICRGB = new Layout([
  ['grey_point_source', 'f32'],
  ['black_point_source', 'f32'],
  ['white_point_source', 'f32'],
  ['reconstruct_threshold', 'f32'],
  ['reconstruct_feather', 'f32'],
  ['reconstruct_bloom_vs_details', 'f32'],
  ['reconstruct_grey_vs_color', 'f32'],
  ['reconstruct_structure_vs_texture', 'f32'],
  ['security_factor', 'f32'],
  ['grey_point_target', 'f32'],
  ['black_point_target', 'f32'],
  ['white_point_target', 'f32'],
  ['output_power', 'f32'],
  ['latitude', 'f32'],
  ['contrast', 'f32'],
  ['saturation', 'f32'],
  ['balance', 'f32'],
  ['noise_level', 'f32'],
  ['preserve_color', 'i32'],
  ['version', 'i32'],
  ['auto_hardness', 'gboolean'],
  ['custom_grey', 'gboolean'],
  ['high_quality_reconstruction', 'i32'],
  ['noise_distribution', 'i32'],
  ['shadows', 'i32'],
  ['highlights', 'i32'],
  ['compensate_icc_black', 'gboolean'],
  ['spline_version', 'i32'],
]);
/** darktable's v6 adds `enable_highlight_reconstruction`; Ansel's v5 hasn't it. */
const FILMICRGB_DT = new Layout([
  ...FILMICRGB.fields.map((f) => [f.name, f.type] as const),
  ['enable_highlight_reconstruction', 'gboolean'],
]);
/** `DT_FILMIC_SPLINE_VERSION_V3`; Ansel's curve types: `DT_FILMIC_CURVE_SIGMOID` (3). */
const SPLINE_V3 = 2;
const ANSEL_SIGMOID = 3;
/** Ansel's colour science v8 ("AgX"), ours. */
const COLORSCIENCE_V8 = 7;

/** filmic rgb's parameters as ours, and what differs. */
function filmicrgbParams(
  entry: DarktableEntry,
  bytes: Uint8Array,
  app: string,
): { params: Filmic; notes: string[] } | null {
  const p = (entry.modversion === 6 ? FILMICRGB_DT : entry.modversion === 5 ? FILMICRGB : null)?.read(bytes);
  if (!p) return null;
  const notes: string[] = [];
  const num = (k: string) => p[k] as number;
  // Their grey isn't ours (18.45 %): the range is moved so that it lands where theirs does.
  const shift = Math.log2(num('grey_point_source') / 100 / GREY);
  if (Math.abs(shift) > 0.01) notes.push('Middle grey moved');
  const latitude = clamp(num('latitude'), 0, 100) / 100;
  const balance = clamp(num('balance'), -50, 50) / 100;
  const share = (v: number) => Math.round(clamp(v, 0, 1) * 10_000) / 100;
  const params: Filmic = {
    ...defaultModuleParams.filmic,
    whiteExposure: num('white_point_source') + shift,
    blackExposure: num('black_point_source') + shift,
    contrast: num('contrast'),
    toe: share(latitude * (1 + 2 * balance)),
    shoulder: share(latitude * (1 - 2 * balance)),
    autoHardness: !!p.auto_hardness,
    hardness: num('output_power'),
    blackTarget: num('black_point_target'),
    whiteTarget: num('white_point_target'),
  };
  const ansel = app === 'ansel';
  if (num('spline_version') !== SPLINE_V3) notes.push('An older curve: drawn with the current one');
  else if (!ansel || num('shadows') !== ANSEL_SIGMOID || num('highlights') !== ANSEL_SIGMOID)
    notes.push('Toe and shoulder drawn with the sigmoid curves');
  if (!ansel || num('version') !== COLORSCIENCE_V8) notes.push('Colour handled by Ansel’s v8 colour science');
  if (p.enable_highlight_reconstruction) notes.push('No highlight reconstruction');
  return { params, notes };
}

// ── sigmoid ───────────────────────────────────────────────────────────────────

const SIGMOID_V3 = new Layout([
  ['middle_grey_contrast', 'f32'],
  ['contrast_skewness', 'f32'],
  ['display_white_target', 'f32'],
  ['display_black_target', 'f32'],
  ['color_processing', 'i32'],
  ['hue_preservation', 'f32'],
  ['red_inset', 'f32'],
  ['red_rotation', 'f32'],
  ['green_inset', 'f32'],
  ['green_rotation', 'f32'],
  ['blue_inset', 'f32'],
  ['blue_rotation', 'f32'],
  ['purity', 'f32'],
  ['base_primaries', 'i32'],
]);

/** darktable's `_generalized_loglogistic_sigmoid`. */
function loglogistic(
  v: number,
  magnitude: number,
  paperExp: number,
  fog: number,
  filmPower: number,
  paperPower: number,
) {
  const film = (fog + Math.max(v, 0)) ** filmPower;
  const out = magnitude * (film / (paperExp + film)) ** paperPower;
  return Number.isNaN(out) ? magnitude : out;
}

/** Sigmoid's curve on a grey: scene-linear → display-linear (darktable's `commit_params`). */
function sigmoidCurve(p: Record<string, unknown>): (v: number) => number {
  const contrast = p.middle_grey_contrast as number;
  const delta = 1e-6;
  const slope = (f: (v: number) => number) => (f(GREY + delta) - f(GREY - delta)) / 2 / delta;
  const refExposure = GREY ** contrast * (1 / GREY - 1);
  const refSlope = slope((v) => loglogistic(v, 1, refExposure, 0, contrast, 1));
  const paperPower = 5 ** -(p.contrast_skewness as number);
  const white = 0.01 * (p.display_white_target as number);
  const black = 0.01 * (p.display_black_target as number);
  const tempRelation = (white / GREY) ** (1 / paperPower) - 1;
  const tempSlope = slope((v) => loglogistic(v, white, GREY * tempRelation, 0, 1, paperPower));
  const filmPower = refSlope / tempSlope;
  const whiteGrey = (white / GREY) ** (1 / paperPower) - 1;
  const whiteBlack = (black / white) ** (-1 / paperPower) - 1;
  const fog = (GREY * whiteGrey ** (1 / filmPower)) / (whiteBlack ** (1 / filmPower) - whiteGrey ** (1 / filmPower));
  const paperExp = (fog + GREY) ** filmPower * whiteGrey;
  return (v) => loglogistic(v, white, paperExp, fog, filmPower, paperPower);
}

// ── AgX ───────────────────────────────────────────────────────────────────────

const AGX_V7 = new Layout([
  ['look_lift', 'f32'],
  ['look_slope', 'f32'],
  ['look_brightness', 'f32'],
  ['look_saturation', 'f32'],
  ['look_original_hue_mix_ratio', 'f32'],
  ['range_black_relative_ev', 'f32'],
  ['range_white_relative_ev', 'f32'],
  ['dynamic_range_scaling', 'f32'],
  ['curve_pivot_x', 'f32'],
  ['curve_pivot_y_linear_output', 'f32'],
  ['curve_contrast_around_pivot', 'f32'],
  ['curve_linear_ratio_below_pivot', 'f32'],
  ['curve_linear_ratio_above_pivot', 'f32'],
  ['curve_toe_power', 'f32'],
  ['curve_shoulder_power', 'f32'],
  ['curve_gamma', 'f32'],
  ['auto_gamma', 'gboolean'],
  ['curve_target_display_black_ratio', 'f32'],
  ['curve_target_display_white_ratio', 'f32'],
  ['base_primaries', 'i32'],
  ['disable_primaries_adjustments', 'gboolean'],
  ['red_inset', 'f32'],
  ['red_rotation', 'f32'],
  ['green_inset', 'f32'],
  ['green_rotation', 'f32'],
  ['blue_inset', 'f32'],
  ['blue_rotation', 'f32'],
  ['master_outset_ratio', 'f32'],
  ['master_unrotation_ratio', 'f32'],
  ['red_outset', 'f32'],
  ['red_unrotation', 'f32'],
  ['green_outset', 'f32'],
  ['green_unrotation', 'f32'],
  ['blue_outset', 'f32'],
  ['blue_unrotation', 'f32'],
  ['completely_reverse_primaries', 'gboolean'],
]);

const EPS = 1e-6;
/** AgX's (and filmic's) `_scale`. */
const agxScale = sigmoidScale;

/** AgX's curve and look on a grey: scene-linear → display-linear (`_calculate_tone_mapping_params`, `_agx_tone_mapping`). */
function agxCurve(p: Record<string, unknown>): (v: number) => number {
  const n = (k: string) => p[k] as number;
  const black = n('range_black_relative_ev');
  const range = n('range_white_relative_ev') - black;
  const pivotX = clamp(n('curve_pivot_x'), EPS, 1 - EPS);
  const pivotLinear = n('curve_pivot_y_linear_output');
  const gamma =
    p.auto_gamma && pivotX > 0 && pivotLinear > 0 ? Math.log2(pivotLinear) / Math.log2(pivotX) : n('curve_gamma');
  const pivotYAt = (g: number) =>
    clamp(pivotLinear, n('curve_target_display_black_ratio'), n('curve_target_display_white_ratio')) ** (1 / g);
  const pivotY = pivotYAt(gamma);
  const compensation = (gamma * Math.max(EPS, pivotY) ** (gamma - 1)) / (2.2 * Math.max(EPS, pivotYAt(2.2)) ** 1.2);
  const slope = (n('curve_contrast_around_pivot') * (range / 16.5)) / compensation;
  const targetBlack = n('curve_target_display_black_ratio') ** (1 / gamma);
  const toePower = Math.max(0.01, n('curve_toe_power'));
  let dxBelow = ((pivotY - targetBlack) * n('curve_linear_ratio_below_pivot')) / slope;
  const toeX = Math.max(EPS, pivotX - dxBelow);
  dxBelow = pivotX - toeX;
  const toeY = pivotY - slope * dxBelow;
  const toeScale = -agxScale(1, 1 - targetBlack, 1 - toeX, 1 - toeY, slope, toePower);
  const toeDy = Math.max(EPS, toeY - targetBlack);
  const convexToe = toeDy / toeX > slope;
  const toeFallbackPower = (slope * toeX) / toeDy;
  const toeFallbackCoeff = toeDy / toeX ** toeFallbackPower;
  const intercept = toeY - slope * toeX;
  const targetWhite = n('curve_target_display_white_ratio') ** (1 / gamma);
  let dxAbove = ((targetWhite - pivotY) * n('curve_linear_ratio_above_pivot')) / slope;
  const shoulderX = Math.min(1 - EPS, pivotX + dxAbove);
  dxAbove = shoulderX - pivotX;
  const shoulderY = pivotY + slope * dxAbove;
  const shoulderPower = Math.max(0.01, n('curve_shoulder_power'));
  const shoulderScale = agxScale(1, targetWhite, shoulderX, shoulderY, slope, shoulderPower);
  const shoulderDx = 1 - shoulderX;
  const shoulderDy = Math.max(EPS, targetWhite - shoulderY);
  const concaveShoulder = shoulderDy / shoulderDx > slope;
  const shoulderFallbackPower = (slope * shoulderDx) / shoulderDy;
  const shoulderFallbackCoeff = shoulderDy / shoulderDx ** shoulderFallbackPower;
  const scaled = (x: number, scale: number, power: number, tx: number, ty: number) => {
    const u = (slope * (x - tx)) / scale;
    return scale * (u / (1 + u ** power) ** (1 / power)) + ty;
  };
  const curve = (x: number) => {
    let y: number;
    if (x < toeX)
      y = convexToe
        ? x < 0
          ? targetBlack
          : targetBlack + Math.max(0, toeFallbackCoeff * x ** toeFallbackPower)
        : scaled(x, toeScale, toePower, toeX, toeY);
    else if (x <= shoulderX) y = slope * x + intercept;
    else
      y = concaveShoulder
        ? x >= 1
          ? targetWhite
          : targetWhite - Math.max(0, shoulderFallbackCoeff * (1 - x) ** shoulderFallbackPower)
        : scaled(x, shoulderScale, shoulderPower, shoulderX, shoulderY);
    return clamp(y, targetBlack, targetWhite);
  };
  // The look: slope and lift, then a power (saturation doesn't move a grey).
  const [lift, lookSlope, brightness] = [n('look_lift'), n('look_slope'), n('look_brightness')];
  const lookPower = brightness < 1 ? 1 / Math.sqrt(Math.max(brightness, EPS)) : 1 / brightness;
  const tuned = lookSlope !== 1 || brightness !== 1 || lift !== 0 || n('look_saturation') !== 1;
  return (v) => {
    const log = clamp((Math.log2(Math.max(EPS, v / 0.18)) - black) / range, 0, 1);
    let y = curve(log);
    if (tuned) {
      const m = lookSlope / (1 + lift);
      y = m * y + lift * m;
      if (y > 0) y **= lookPower;
    }
    return Math.max(0, y) ** gamma;
  };
}

// ── Fitting ───────────────────────────────────────────────────────────────────

/** Minimise `f` from `start` (Nelder–Mead, `steps` the initial simplex's size along each axis). */
function nelderMead(f: (x: number[]) => number, start: number[], steps: number[], iterations = 3000): number[] {
  const n = start.length;
  let simplex = [start, ...steps.map((s, i) => start.map((v, j) => (i === j ? v + s : v)))].map((x) => ({
    x,
    v: f(x),
  }));
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.v - b.v);
    const best = simplex[0]!;
    const worst = simplex[n]!;
    if (Math.abs(worst.v - best.v) < 1e-12) break;
    const centroid = start.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p.x[j]!, 0) / n);
    const along = (t: number) => centroid.map((c, j) => c + t * (worst.x[j]! - c));
    const reflected = along(-1);
    const r = f(reflected);
    if (r < best.v) {
      const expanded = along(-2);
      const e = f(expanded);
      simplex[n] = e < r ? { x: expanded, v: e } : { x: reflected, v: r };
    } else if (r < simplex[n - 1]!.v) {
      simplex[n] = { x: reflected, v: r };
    } else {
      const contracted = along(0.5);
      const c = f(contracted);
      if (c < worst.v) simplex[n] = { x: contracted, v: c };
      else
        simplex = simplex
          .map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => (v + best.x[j]!) / 2), v: 0 }))
          .map((p, i) => (i === 0 ? p : { ...p, v: f(p.x) }));
    }
  }
  return simplex.sort((a, b) => a.v - b.v)[0]!.x;
}

/** Scene exposures the fit compares (EV around middle grey), and how much each counts: mid-tones most. */
const FIT_EV = Array.from({ length: 89 }, (_, i) => -12 + i * 0.25);
const fitWeight = (ev: number) => 0.2 + Math.exp(-((ev / 3.5) ** 2));
/** Perceptual-ish encoding the curves are compared in. */
const encode = (v: number) => Math.max(v, 0) ** (1 / 2.4);

export interface FilmicFit {
  params: Filmic;
  /** Exposure (EV) to apply before filmic: where their curve doesn't keep middle grey. */
  offset: number;
  /** Mean absolute difference, encoded (0 … 1). */
  error: number;
}

/**
 * Our filmic closest to `target` (scene-linear → display-linear, on a grey), starting
 * from `start`: its exposures, contrast, toe, shoulder and power, and an exposure offset.
 */
export function fitFilmic(target: (v: number) => number, start: Filmic): FilmicFit {
  const goal = FIT_EV.map((ev) => encode(target(GREY * 2 ** ev)));
  const make = (x: number[]): Filmic => ({
    ...start,
    whiteExposure: clamp(x[0]!, 0.5, 16),
    blackExposure: clamp(x[1]!, -16, -1),
    contrast: clamp(x[2]!, 0.1, 5),
    toe: clamp(x[3]!, 0, 100),
    shoulder: clamp(x[4]!, 0, 100),
    autoHardness: false,
    hardness: clamp(x[5]!, 1, 10),
  });
  const loss = (x: number[]) => {
    const curve = new FilmicCurve(make(x));
    const offset = 2 ** clamp(x[6]!, -3, 3);
    let sum = 0;
    for (const [i, ev] of FIT_EV.entries())
      sum += fitWeight(ev) * (encode(curve.toneMap(GREY * 2 ** ev * offset)) - goal[i]!) ** 2;
    return sum;
  };
  const power = start.autoHardness ? new FilmicCurve(start).power : start.hardness;
  let x = [start.whiteExposure, start.blackExposure, start.contrast, start.toe, start.shoulder, power, 0];
  // Restarts: Nelder–Mead settles in local minima.
  for (let round = 0; round < 3; round++) x = nelderMead(loss, x, [1, 1, 0.3, 15, 15, 0.5, 0.2]);
  const params = make(x);
  const curve = new FilmicCurve(params);
  const offset = clamp(x[6]!, -3, 3);
  const error =
    FIT_EV.reduce((s, ev, i) => s + Math.abs(encode(curve.toneMap(GREY * 2 ** (ev + offset))) - goal[i]!), 0) /
    FIT_EV.length;
  return { params, offset, error };
}

// ── The translator ────────────────────────────────────────────────────────────

const TONE_MAPPERS = ['filmicrgb', 'sigmoid', 'agx'];
const AXIS_ROTATIONS = ['red_rotation', 'green_rotation', 'blue_rotation', 'red_inset', 'green_inset', 'blue_inset'];

/**
 * Their tone mappers (one, or several in a row) as our filmic. filmic rgb alone maps
 * parameter for parameter; anything else is fitted (`fitFilmic`). One instance: the
 * last of theirs carries it, the others are reported as part of it.
 */
const toneMapping: Translator = {
  operations: TONE_MAPPERS,
  kinds: ['filmic'],
  translate(entry, bytes, ctx): Translation {
    const enabled = ctx.active.filter((e) => e.enabled && TONE_MAPPERS.includes(e.operation));
    const last = enabled.at(-1);
    if (!entry.enabled) return { instance: null, status: 'mapped' };
    if (entry !== last)
      return { instance: null, status: 'approximated', note: 'Fitted together with the next tone mapper' };
    const notes: string[] = [];
    const curves: ((v: number) => number)[] = [];
    let start: Filmic = { ...defaultModuleParams.filmic };
    let huePreservation = 0;
    for (const e of enabled) {
      const b = ctx.paramsOf(e);
      if (!b) continue;
      if (e.operation === 'filmicrgb') {
        const f = filmicrgbParams(e, b, ctx.app);
        if (!f) continue;
        if (enabled.length === 1) {
          return {
            instance: instance('filmic', f.params),
            status: f.notes.length ? 'approximated' : 'mapped',
            ...(f.notes.length && { note: f.notes.join('. ') }),
          };
        }
        const curve = new FilmicCurve(f.params);
        curves.push((v) => curve.toneMap(v));
        start = f.params;
      } else if (e.operation === 'sigmoid') {
        const p = e.modversion === 3 ? SIGMOID_V3.read(b) : null;
        if (!p) continue;
        curves.push(sigmoidCurve(p));
        start = { ...start, blackTarget: clamp(p.display_black_target as number, 0, 20) };
        if ((p.display_white_target as number) > 100) notes.push('Display white above 100 %: kept at 100 %');
        // Per channel: their hue preservation; RGB ratio keeps hues.
        huePreservation = p.color_processing === 1 ? 100 : 2 * (p.hue_preservation as number) - 100;
        if (AXIS_ROTATIONS.some((k) => p[k] !== 0) || p.purity !== 0) notes.push('Primaries not adjusted');
      } else {
        const p = e.modversion === 7 ? AGX_V7.read(b) : null;
        if (!p) continue;
        curves.push(agxCurve(p));
        const n = (k: string) => p[k] as number;
        start = {
          ...start,
          whiteExposure: n('range_white_relative_ev'),
          blackExposure: n('range_black_relative_ev'),
          blackTarget: clamp(n('curve_target_display_black_ratio') * 100, 0, 20),
          whiteTarget: clamp(n('curve_target_display_white_ratio') * 100, 20, 100),
          hardness: n('curve_gamma'),
          autoHardness: false,
        };
        huePreservation = 200 * n('look_original_hue_mix_ratio') - 100;
        if (n('look_saturation') !== 1) notes.push('Look saturation not applied');
        if (
          !p.disable_primaries_adjustments &&
          (AXIS_ROTATIONS.some((k) => p[k] !== 0) || n('master_outset_ratio') !== 1)
        )
          notes.push('Primaries not adjusted');
      }
    }
    if (!curves.length) return unreadable(entry);
    const fit = fitFilmic((v) => curves.reduce((x, c) => c(x), v), start);
    notes.unshift(`Curve fitted onto filmic (within ${Math.round(fit.error * 1000) / 10} %)`);
    const params = { ...fit.params, huePreservation: clamp(Math.round(huePreservation), -100, 100) };
    return {
      instance: instance('filmic', params),
      ...(Math.abs(fit.offset) > 0.05 && {
        extra: [
          {
            ...instance('exposure', { ev: fit.offset, black: 0 }),
            label: `${entry.operation === 'agx' ? 'AgX' : 'Tone'} brightness`,
          },
        ],
      }),
      status: 'approximated',
      note: notes.join('. '),
    };
  },
};

export const TONE_TRANSLATORS: readonly Translator[] = [toneMapping];
