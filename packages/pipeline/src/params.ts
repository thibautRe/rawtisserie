/**
 * Edit parameters — the "recipe" applied to a RAW file: a list of module instances.
 * Mirrors `EditParams` in `crates/pipeline/src/params.rs`; keep both in sync.
 *
 * The pipeline order is fixed by module kind (`MODULE_KINDS`); instances of the same
 * kind run in list order. A kind with no enabled instance is skipped.
 */

import type { PhotoMetadata } from './metadata.ts';

export interface ModuleParams {
  /** Lens correction from the data embedded in the file. Strengths scale it: 0 = off, 1 = as specified, up to 2. */
  lens: {
    distortion: number;
    /** Transverse chromatic aberration. */
    tca: number;
    vignetting: number;
  };
  geometry: {
    /** Clockwise quarter turns on top of the camera orientation, 0…3. */
    rotation: number;
    flipHorizontal: boolean;
    /** Straighten angle in degrees, clockwise positive, -45 … 45. */
    angle: number;
    /** Normalised to the oriented, straightened frame. */
    crop: CropRect;
  };
  blur: {
    /** Gaussian sigma in full-resolution pixels; 0 = off. */
    radius: number;
  };
  sharpen: {
    /** 0 = off. */
    amount: number;
    /** Gaussian sigma in full-resolution pixels. */
    radius: number;
  };
  /**
   * Contrast equalizer, after Ansel's: local contrast and denoising per detail size.
   * Each curve has `EQUALIZER_NODES` evenly spaced nodes, from coarse (first, about
   * a fifth of the image) to fine (last, a few pixels), each 0 … 1.
   */
  contrastEqualizer: {
    /** Luminance detail gain, (2y)²: 0.5 leaves the image alone, 1 is ×4. */
    luma: number[];
    /** Colour detail gain, like `luma`. */
    chroma: number[];
    /** Edge awareness: higher keeps strong edges out of coarse sizes (fewer halos). */
    edges: number[];
    /** Luminance noise threshold; 0 = off. */
    lumaDenoise: number[];
    /** Colour noise threshold; 0 = off. */
    chromaDenoise: number[];
    /** Strength of the curves relative to their defaults, -2 … 2. */
    mix: number;
  };
  exposure: {
    /** Exposure compensation, EV. */
    ev: number;
    /** Scene-linear black offset. */
    black: number;
  };
  /**
   * Colour calibration, after Ansel's: chromatic adaptation from the scene's light to
   * the working space's white (D65), gamut compression, then mixing in the adaptation's
   * space. Units are Ansel's.
   */
  colorCalibration: {
    /** The light to adapt from. */
    illuminant: Illuminant;
    /** Correlated colour temperature of the daylight and black body illuminants, K, 1667 … 25000. */
    temperature: number;
    fluorescent: Fluorescent;
    led: Led;
    /** Chromaticity of the custom illuminant (CIE 1931 xy). */
    x: number;
    y: number;
    /** Where the light is adapted and colours mixed. "As shot" always uses CAT16. */
    adaptation: Adaptation;
    /** Gamut compression, 0 … 12 (0 = off). */
    gamut: number;
    /** Clip negative values at each step. */
    clip: boolean;
    /** Output channels as a mix of the input ones, -2 … 2 each. */
    red: number[];
    green: number[];
    blue: number[];
    /** Scale each mix so that its coefficients add up to 1. */
    normalizeRed: boolean;
    normalizeGreen: boolean;
    normalizeBlue: boolean;
    /** Colourfulness along each channel, -1 … 1. */
    colorfulness: number[];
    normalizeColorfulness: boolean;
    /** Brightness along each channel, -1 … 1. */
    brightness: number[];
    normalizeBrightness: boolean;
    /** Monochrome mix of the channels, used when any is non-zero; -2 … 2. */
    grey: number[];
    normalizeGrey: boolean;
  };
  color: {
    /** -1 (monochrome) … +1. */
    saturation: number;
    /** -1 … +1, favours muted colours. */
    vibrance: number;
  };
  shadowsHighlights: {
    /** -1 … +1. */
    shadows: number;
    /** -1 … +1. */
    highlights: number;
  };
  /** Colour primaries, after Ansel's: moves six control colours. Units are Ansel's. */
  colorPrimaries: {
    red: Primary;
    yellow: Primary;
    green: Primary;
    cyan: Primary;
    blue: Primary;
    magenta: Primary;
    /** Scene exposure of the brightest colour the edits reach, EV, -2 … 16. */
    whiteLevel: number;
    /** Saturation of the control colours, 0 … 100 % of Rec.2020. */
    gamutCoverage: number;
    /** Reach of each edit along brightness, 1 … 100 %. */
    brightnessSmoothing: number;
    /** Reach of each edit along saturation, 0.01 … 2. */
    saturationSmoothing: number;
    /** Reach of each edit around the hue circle, radians, 0.01 … 2π. */
    hueSmoothing: number;
    /** Saturation below which edits fade out (greys stay grey), 0 … 2; 0 = off. */
    neutralProtection: number;
  };
  /** Filmic RGB tone mapping, after Ansel (spline v3, colour science v8 "AgX"). */
  filmic: {
    /** Scene exposure mapped to display white, EV relative to middle grey. */
    whiteExposure: number;
    /** Scene exposure mapped to display black, EV relative to middle grey (negative). */
    blackExposure: number;
    /** Slope of the linear part, 0 … 5. */
    contrast: number;
    /** Linear share of the range between black and middle grey, 0 … 100 % (the rest is the toe). */
    toe: number;
    /** Linear share of the range between middle grey and white, 0 … 100 % (the rest is the shoulder). */
    shoulder: number;
    /** AgX hue recovery: -100 keeps the film-like drift, +100 restores original hues. */
    huePreservation: number;
    bleach: Bleach;
    /**
     * How much the white/black range is widened (+) or narrowed (-) from the unscaled one,
     * %, -50 … +200. Auto-tune applies it to the measured range; the editor keeps it in
     * step with the white and black exposures (`apps/web/src/develop/filmicRange.ts`).
     */
    dynamicRangeScaling: number;
  };
}

export type ModuleKind = keyof ModuleParams;

/** The edit of one colour primary. */
export interface Primary {
  /** Hue rotation, degrees, -180 … 180. */
  hue: number;
  /** Saturation shift, %, -100 … 100. */
  saturation: number;
  /** Brightness shift, -0.25 … 0.25. */
  brightness: number;
}

export const PRIMARIES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;
export type PrimaryName = (typeof PRIMARIES)[number];

/** Number of nodes of each contrast equalizer curve. */
export const EQUALIZER_NODES = 6;
export const EQUALIZER_CURVES = ['luma', 'chroma', 'edges', 'lumaDenoise', 'chromaDenoise'] as const;
export type EqualizerCurve = (typeof EQUALIZER_CURVES)[number];

export const ILLUMINANTS = ['asShot', 'pipeline', 'daylight', 'blackBody', 'a', 'e', 'fluorescent', 'led', 'custom'] as const;
export type Illuminant = (typeof ILLUMINANTS)[number];
export const FLUORESCENTS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;
export type Fluorescent = (typeof FLUORESCENTS)[number];
export const LEDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'bh1', 'rgb1', 'v1', 'v2'] as const;
export type Led = (typeof LEDS)[number];
/** Chromatic adaptation transforms (Ansel's, without non-linear Bradford). */
export const ADAPTATIONS = ['cat16', 'linearBradford', 'xyz', 'none'] as const;
export type Adaptation = (typeof ADAPTATIONS)[number];

/** Module kinds, in pipeline order. */
export const MODULE_KINDS = [
  'lens',
  'geometry',
  'blur',
  'sharpen',
  'contrastEqualizer',
  'exposure',
  'colorCalibration',
  'color',
  'shadowsHighlights',
  'colorPrimaries',
  'filmic',
] as const satisfies readonly ModuleKind[];

/** Kinds whose extra instances are dropped on load. */
export const SINGLE_INSTANCE_KINDS: readonly ModuleKind[] = ['lens', 'geometry', 'filmic'];

export type ModuleInstance<K extends ModuleKind = ModuleKind> = {
  [P in K]: {
    /** Unique within the recipe; stable across edits. */
    id: string;
    /** Shown next to the module name, to tell instances apart. */
    label: string | null;
    enabled: boolean;
    kind: P;
    params: ModuleParams[P];
  };
}[K];

export interface EditParams {
  version: number;
  /** In pipeline order. */
  modules: ModuleInstance[];
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BLEACH_LEVELS = ['none', 'low', 'medium', 'high', 'extra'] as const;
export type Bleach = (typeof BLEACH_LEVELS)[number];

/**
 * v2: the sigmoid tone mapper was replaced by filmic. v3: a list of module instances.
 * v4: filmic's latitude/balance became independent toe/shoulder sizes.
 * v5: filmic's toe/shoulder measure the linear share instead of the curved one.
 * v6: colour calibration replaces warmth/tint, and does the white balance.
 */
export const EDIT_PARAMS_VERSION = 6;

/** Parameters of a new instance of each kind. */
export const defaultModuleParams: { readonly [K in ModuleKind]: ModuleParams[K] } = Object.freeze({
  lens: { distortion: 1, tca: 1, vignetting: 1 },
  geometry: { rotation: 0, flipHorizontal: false, angle: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
  blur: { radius: 0 },
  sharpen: { amount: 0, radius: 1 },
  contrastEqualizer: {
    luma: Array<number>(EQUALIZER_NODES).fill(0.5),
    chroma: Array<number>(EQUALIZER_NODES).fill(0.5),
    edges: Array<number>(EQUALIZER_NODES).fill(0.5),
    lumaDenoise: Array<number>(EQUALIZER_NODES).fill(0),
    chromaDenoise: Array<number>(EQUALIZER_NODES).fill(0),
    mix: 1,
  },
  // Ansel's default push for RAW files.
  exposure: { ev: 0.7, black: 0 },
  colorCalibration: {
    illuminant: 'asShot',
    // The working space's white, D65 (Ansel's 5003 K is its D50).
    temperature: 6504,
    fluorescent: 'f3',
    led: 'b5',
    x: 0.3127,
    y: 0.329,
    adaptation: 'cat16',
    gamut: 1,
    clip: true,
    red: [1, 0, 0],
    green: [0, 1, 0],
    blue: [0, 0, 1],
    normalizeRed: true,
    normalizeGreen: true,
    normalizeBlue: true,
    colorfulness: [0, 0, 0],
    normalizeColorfulness: false,
    brightness: [0, 0, 0],
    normalizeBrightness: false,
    grey: [0, 0, 0],
    normalizeGrey: false,
  },
  color: { saturation: 0, vibrance: 0 },
  shadowsHighlights: { shadows: 0, highlights: 0 },
  colorPrimaries: {
    ...(Object.fromEntries(PRIMARIES.map((p) => [p, { hue: 0, saturation: 0, brightness: 0 }])) as Record<PrimaryName, Primary>),
    whiteLevel: 1,
    gamutCoverage: 67,
    brightnessSmoothing: 100,
    // Ansel's 1/√2.
    saturationSmoothing: 0.7071,
    hueSmoothing: 0.7071,
    neutralProtection: 0,
  },
  // Ansel's defaults for RAW files, paired with the +0.7 EV exposure default.
  filmic: {
    whiteExposure: 3.15,
    blackExposure: -8.85,
    contrast: 1.18,
    // Ansel's latitude 10 %, balance 0.
    toe: 10,
    shoulder: 10,
    huePreservation: 0,
    bleach: 'medium',
    dynamicRangeScaling: 0,
  },
});

const instance = <K extends ModuleKind>(kind: K, id = ''): ModuleInstance<K> =>
  ({ id, label: null, enabled: true, kind, params: structuredClone(defaultModuleParams[kind]) }) as ModuleInstance<K>;

/** The recipe a new image starts with: exposure, white balance as shot (colour calibration) and filmic. */
export const defaultEditParams: EditParams = Object.freeze({
  version: EDIT_PARAMS_VERSION,
  modules: [instance('exposure', 'exposure'), instance('colorCalibration', 'colorCalibration'), instance('filmic', 'filmic')],
});

/**
 * The recipe a new image starts with, given what its file contains: the default
 * recipe, plus lens correction when the file embeds correction data. Mirrors
 * `EditParams::default_for`.
 */
export function defaultRecipe(metadata: Pick<PhotoMetadata, 'lensCorrection'>): EditParams {
  if (!metadata.lensCorrection) return defaultEditParams;
  return { ...defaultEditParams, modules: [instance('lens', 'lens'), ...structuredClone(defaultEditParams.modules)] };
}

const rank = (kind: ModuleKind) => MODULE_KINDS.indexOf(kind);
const isKind = (kind: unknown): kind is ModuleKind => MODULE_KINDS.includes(kind as ModuleKind);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a recipe of any version: v1/v2 recipes are migrated, missing fields get their
 * defaults, and the result is normalised like `EditParams::normalize` in Rust. Junk
 * (wrong types, unknown module kinds) is dropped, where Rust would refuse it.
 */
export function normalizeEditParams(input: unknown): EditParams {
  const raw = isObject(input) ? structuredClone(input) : {};
  migrateFilmic(raw);
  const version = typeof raw.version === 'number' ? raw.version : 0;
  const whiteBalance = version < 6 ? takeWhiteBalance(raw) : [];
  const modules = version < 3 && !('modules' in raw) ? migrateV2(raw) : v3Modules(raw);
  // The base image used to be balanced as shot; now colour calibration does it.
  if (version < 6) modules.push({ ...instance('colorCalibration'), params: fromWhiteBalance(whiteBalance) });
  return normalize(modules);
}

function v3Modules(raw: Record<string, unknown>): ModuleInstance[] {
  const modules: ModuleInstance[] = [];
  for (const m of Array.isArray(raw.modules) ? raw.modules : []) {
    if (!isObject(m) || !isKind(m.kind)) continue;
    modules.push({
      id: typeof m.id === 'string' ? m.id : '',
      label: typeof m.label === 'string' ? m.label : null,
      enabled: typeof m.enabled === 'boolean' ? m.enabled : true,
      kind: m.kind,
      params: moduleParams(m.kind, m.params),
    } as ModuleInstance);
  }
  return modules;
}

/**
 * Remove the warmth/tint white balance of a v1–v5 recipe; returns the enabled ones'
 * `[warmth, tint]`, in pipeline order. Mirrors `take_white_balance`.
 */
function takeWhiteBalance(raw: Record<string, unknown>): [number, number][] {
  const read = (p: unknown): [number, number] => {
    const get = (key: string) => (isObject(p) && typeof p[key] === 'number' ? p[key] : 0);
    return [get('warmth'), get('tint')];
  };
  if (Array.isArray(raw.modules)) {
    const isWb = (m: unknown): m is Record<string, unknown> => isObject(m) && m.kind === 'whiteBalance';
    const found = raw.modules.filter(isWb).filter((m) => m.enabled !== false).map((m) => read(m.params));
    raw.modules = raw.modules.filter((m) => !isWb(m));
    return found;
  }
  if (!('whiteBalance' in raw)) return [];
  const wb = raw.whiteBalance;
  delete raw.whiteBalance;
  return [read(wb)];
}

/**
 * The default colour calibration, with the gains of v1–v5 warmth/tint instances
 * (applied after the white balance) folded into its channel mix. Mirrors
 * `ColorCalibration::from_white_balance`; computed the same way, in f64 from the same
 * f32 constants, and rounded, so that both give the same numbers.
 */
export function fromWhiteBalance(instances: [number, number][]): ModuleParams['colorCalibration'] {
  const p = structuredClone(defaultModuleParams.colorCalibration);
  const f = Math.fround;
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  let gains = [1, 1, 1];
  for (const [warmth, tint] of instances) {
    const w = clamp(f(warmth)) * 0.5;
    const t = clamp(f(tint)) * 0.35;
    const wb = [2 ** w, 2 ** -t, 2 ** -w];
    const luma = LUMA_REC2020.map(f);
    const y = wb[0]! * luma[0]! + wb[1]! * luma[1]! + wb[2]! * luma[2]!;
    gains = gains.map((g, c) => g * (wb[c]! / y));
  }
  if (gains.some((g) => g !== 1)) {
    const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    const [red, green, blue] = mixForRgbGains(gains).map((row) => row.map(round));
    Object.assign(p, { red, green, blue, normalizeRed: false, normalizeGreen: false, normalizeBlue: false });
  }
  return p;
}

type Mat3 = number[][];
const LUMA_REC2020 = [0.2627, 0.678, 0.0593];
export const XYZ_FROM_REC709 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const REC709_FROM_XYZ = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];
const REC2020_FROM_REC709 = [
  [0.6274039, 0.329283, 0.0433131],
  [0.0690973, 0.9195404, 0.0113623],
  [0.0163914, 0.0880133, 0.8955953],
];
const REC709_FROM_REC2020 = [
  [1.660491, -0.5876411, -0.0728499],
  [-0.1245505, 1.1328999, -0.0083494],
  [-0.0181508, -0.1005789, 1.1187297],
];
export const XYZ_TO_CAT16 = [
  [0.401288, 0.650173, -0.051461],
  [-0.250268, 1.204414, 0.045854],
  [-0.002079, 0.048952, 0.953127],
];
const CAT16_TO_XYZ = [
  [1.862068, -1.011255, 0.149187],
  [0.38752, 0.621447, -0.008974],
  [-0.015841, -0.034123, 1.049964],
];

function mul(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i]![k]! * b[k]![j]!;
      return s;
    }),
  );
}

/** The CAT16 mix equal to per-channel gains in linear Rec.2020. Mirrors `mix_for_rgb_gains`. */
function mixForRgbGains(gains: number[]): Mat3 {
  const f = (m: Mat3) => m.map((row) => row.map(Math.fround));
  const lmsFromRgb = mul(f(XYZ_TO_CAT16), mul(f(XYZ_FROM_REC709), f(REC709_FROM_REC2020)));
  const rgbFromLms = mul(f(REC2020_FROM_REC709), mul(f(REC709_FROM_XYZ), f(CAT16_TO_XYZ)));
  const diag = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? gains[i]! : 0)));
  return mul(lmsFromRgb, mul(diag, rgbFromLms));
}

function moduleParams<K extends ModuleKind>(kind: K, input: unknown): ModuleParams[K] {
  const params = merge(defaultModuleParams[kind], input as DeepPartial<ModuleParams[K]>);
  if (kind === 'filmic') {
    const f = params as ModuleParams['filmic'];
    if (!BLEACH_LEVELS.includes(f.bleach)) f.bleach = defaultModuleParams.filmic.bleach;
  }
  if (kind === 'colorCalibration') {
    const c = params as ModuleParams['colorCalibration'];
    const d = defaultModuleParams.colorCalibration;
    if (!ILLUMINANTS.includes(c.illuminant)) c.illuminant = d.illuminant;
    if (!FLUORESCENTS.includes(c.fluorescent)) c.fluorescent = d.fluorescent;
    if (!LEDS.includes(c.led)) c.led = d.led;
    if (!ADAPTATIONS.includes(c.adaptation)) c.adaptation = d.adaptation;
  }
  return params;
}

/** Unique non-empty ids, one instance of single-instance kinds, pipeline order. */
function normalize(input: ModuleInstance[]): EditParams {
  const seen = new Set<ModuleKind>();
  const modules = input
    .filter((m) => !SINGLE_INSTANCE_KINDS.includes(m.kind) || (!seen.has(m.kind) && seen.add(m.kind)))
    .sort((a, b) => rank(a.kind) - rank(b.kind)); // stable

  const ids = new Set<string>();
  for (const [i, m] of modules.entries()) {
    if (m.id === '' || ids.has(m.id)) {
      const others = new Set(modules.filter((_, j) => j !== i).map((o) => o.id));
      modules[i] = { ...m, id: freshId(m.kind, (id) => ids.has(id) || others.has(id)) };
    }
    ids.add(modules[i]!.id);
  }
  return { version: EDIT_PARAMS_VERSION, modules };
}

/** `kind`, or `kind-2`, `kind-3`… : the first id that isn't taken. */
function freshId(kind: ModuleKind, taken: (id: string) => boolean): string {
  if (!taken(kind)) return kind;
  for (let n = 2; ; n++) if (!taken(`${kind}-${n}`)) return `${kind}-${n}`;
}

/**
 * v1/v2 (one section per module) → v3. Exposure and filmic always become instances;
 * the other sections only when they differ from their defaults. Mirrors `params/v2.rs`.
 * (White balance is taken out beforehand: `takeWhiteBalance`.)
 */
function migrateV2(input: Record<string, unknown>): ModuleInstance[] {
  const modules: ModuleInstance[] = [];
  for (const kind of MODULE_KINDS) {
    if (kind === 'colorCalibration') continue;
    const section = isObject(input[kind]) ? input[kind] : undefined;
    const params = moduleParams(kind, section);
    const always = kind === 'exposure' || kind === 'filmic';
    if (!always && JSON.stringify(params) === JSON.stringify(defaultModuleParams[kind])) continue;
    // Filmic could be switched off in v2; v3 disables the instance instead.
    const enabled = kind === 'filmic' && typeof section?.enabled === 'boolean' ? section.enabled : true;
    modules.push({ ...instance(kind), enabled, params } as ModuleInstance);
  }
  return modules;
}

/**
 * Filmic's toe and shoulder (v5: linear share of each side of middle grey, %) from
 * v1–v3 `latitude`/`balance` (exact when balance is 0; otherwise assumes equal room
 * on both sides of grey) or from v4 `toe`/`shoulder` (the curved share, 100 % minus
 * the v5 value). Mirrors `migrate_filmic`.
 */
function migrateFilmic(raw: Record<string, unknown>) {
  const version = typeof raw.version === 'number' ? raw.version : 0;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const round = (v: number) => Math.round(clamp(v, 0, 1) * 10_000) / 100;
  const fix = (p: unknown) => {
    if (!isObject(p)) return;
    if ('latitude' in p || 'balance' in p) {
      const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
      const latitude = clamp(num(p.latitude, 10), 0, 100) / 100;
      const balance = clamp(num(p.balance, 0), -50, 50) / 100;
      delete p.latitude;
      delete p.balance;
      p.toe ??= round(latitude * (1 + 2 * balance));
      p.shoulder ??= round(latitude * (1 - 2 * balance));
    } else if (version === 4) {
      for (const key of ['toe', 'shoulder']) if (typeof p[key] === 'number') p[key] = round(1 - p[key] / 100);
    }
  };
  if (Array.isArray(raw.modules)) {
    for (const m of raw.modules) if (isObject(m) && m.kind === 'filmic') fix(m.params);
  } else {
    fix(raw.filmic);
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** `base` with the fields of `patch` that have the right type (arrays: whole, same length). */
function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (Array.isArray(base)) {
    const ok = Array.isArray(patch) && patch.length === base.length && patch.every((v, i) => typeof v === typeof base[i]);
    return (ok ? [...patch] : [...base]) as T;
  }
  if (patch === undefined || patch === null || typeof base !== 'object' || base === null) {
    return (patch ?? base) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    const p = (patch as Record<string, unknown>)[key];
    out[key] =
      typeof value === 'object' && value !== null
        ? merge(value, p as DeepPartial<typeof value>)
        : typeof p === typeof value
          ? p
          : value;
  }
  return out as T;
}

/** The first instance of a kind, enabled or not. */
export function findModule<K extends ModuleKind>(params: EditParams, kind: K): ModuleInstance<K> | undefined {
  return params.modules.find((m) => m.kind === kind) as ModuleInstance<K> | undefined;
}

/**
 * Update the first instance of a kind immutably, adding one (enabled, with default
 * parameters) if there is none: `updateModule(p, 'exposure', { params: { ev: 1.2 } })`.
 */
export function updateModule<K extends ModuleKind>(
  params: EditParams,
  kind: K,
  patch: { enabled?: boolean; params?: Partial<ModuleParams[K]> },
): EditParams {
  const id = findModule(params, kind)?.id ?? freshId(kind, (id) => params.modules.some((m) => m.id === id));
  return updateInstance(params, kind, id, patch);
}

/** Update one instance immutably, adding it (enabled, with default parameters) after its kind if it isn't there. */
export function updateInstance<K extends ModuleKind>(
  params: EditParams,
  kind: K,
  id: string,
  patch: { enabled?: boolean; label?: string | null; params?: Partial<ModuleParams[K]> },
): EditParams {
  const existing = params.modules.find((m) => m.id === id) as ModuleInstance<K> | undefined;
  const base = existing ?? instance(kind, id);
  const updated = {
    ...base,
    enabled: patch.enabled ?? base.enabled,
    label: patch.label === undefined ? base.label : patch.label,
    params: { ...base.params, ...patch.params },
  } as ModuleInstance;
  if (existing) return { ...params, modules: params.modules.map((m) => (m === existing ? updated : m)) };
  const at = params.modules.findLastIndex((m) => rank(m.kind) <= rank(kind)) + 1;
  return { ...params, modules: params.modules.toSpliced(at, 0, updated) };
}

/**
 * Default parameters of the instance at `position` among its kind. Only the first
 * exposure carries the +0.7 EV push and only the first colour calibration does the
 * white balance: other ones start neutral, so that adding them doesn't change the image.
 */
export function instanceDefaults<K extends ModuleKind>(kind: K, position: number): ModuleParams[K] {
  const defaults = structuredClone(defaultModuleParams[kind]);
  if (position === 0) return defaults;
  if (kind === 'exposure') return { ...defaults, ev: 0 };
  if (kind === 'colorCalibration') return { ...defaults, adaptation: 'none', gamut: 0, clip: false };
  return defaults;
}

const positionOf = (params: EditParams, kind: ModuleKind, id: string) => params.modules.filter((m) => m.kind === kind).findIndex((m) => m.id === id);

/** Add a new instance with default parameters right after this one. Not for single-instance kinds. */
export function addInstance(params: EditParams, id: string): EditParams {
  const at = params.modules.findIndex((m) => m.id === id);
  const source = params.modules[at];
  if (!source || SINGLE_INSTANCE_KINDS.includes(source.kind)) return params;
  const added = {
    ...instance(source.kind, freshId(source.kind, (id) => params.modules.some((m) => m.id === id))),
    params: instanceDefaults(source.kind, 1),
  } as ModuleInstance;
  return { ...params, modules: params.modules.toSpliced(at + 1, 0, added) };
}

export function removeInstance(params: EditParams, id: string): EditParams {
  return { ...params, modules: params.modules.filter((m) => m.id !== id) };
}

/** Swap an instance with the previous (-1) or next (+1) one of its kind, if there is one. */
export function moveInstance(params: EditParams, id: string, delta: -1 | 1): EditParams {
  const at = params.modules.findIndex((m) => m.id === id);
  const source = params.modules[at];
  const other = params.modules[at + delta];
  if (!source || other?.kind !== source.kind) return params;
  const modules = [...params.modules];
  modules[at] = other;
  modules[at + delta] = source;
  return { ...params, modules };
}

/** Put the instances of a kind back as in the default recipe (removing them if it has none). */
export function resetModule(params: EditParams, kind: ModuleKind): EditParams {
  const defaults = structuredClone(defaultEditParams.modules.filter((m) => m.kind === kind));
  return normalize([...params.modules.filter((m) => m.kind !== kind), ...defaults]);
}

/** Whether the instances of a kind differ from the default recipe's (ids aside). */
export function isModuleModified(params: EditParams, kind: ModuleKind): boolean {
  const strip = (p: EditParams) => JSON.stringify(p.modules.filter((m) => m.kind === kind).map(({ id: _, ...m }) => m));
  return strip(params) !== strip(defaultEditParams);
}

/**
 * Reset one instance. The only instance of its kind goes back to the default recipe
 * (`resetModule`); with several, it keeps its place and label and gets default parameters.
 */
export function resetInstance(params: EditParams, kind: ModuleKind, id: string): EditParams {
  if (params.modules.filter((m) => m.kind === kind).length <= 1) return resetModule(params, kind);
  return updateInstance(params, kind, id, { enabled: true, params: instanceDefaults(kind, positionOf(params, kind, id)) });
}

/** Whether `resetInstance` would change anything. */
export function isInstanceModified(params: EditParams, kind: ModuleKind, id: string): boolean {
  if (params.modules.filter((m) => m.kind === kind).length <= 1) return isModuleModified(params, kind);
  const m = params.modules.find((m) => m.id === id);
  return !!m && (!m.enabled || JSON.stringify(m.params) !== JSON.stringify(instanceDefaults(kind, positionOf(params, kind, id))));
}

export function isDefaultEdit(params: EditParams): boolean {
  return MODULE_KINDS.every((kind) => !isModuleModified(params, kind));
}
