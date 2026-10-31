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
  whiteBalance: {
    /** -1 (cooler) … +1 (warmer), relative to as-shot. */
    warmth: number;
    /** -1 (green) … +1 (magenta), relative to as-shot. */
    tint: number;
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
    /** Widens (+) or narrows (-) the range found by auto-tune, %, -50 … +200. */
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

/** Module kinds, in pipeline order. */
export const MODULE_KINDS = [
  'lens',
  'geometry',
  'blur',
  'sharpen',
  'contrastEqualizer',
  'exposure',
  'whiteBalance',
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
 */
export const EDIT_PARAMS_VERSION = 5;

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
  whiteBalance: { warmth: 0, tint: 0 },
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

/** The recipe a new image starts with: exposure and filmic. */
export const defaultEditParams: EditParams = Object.freeze({
  version: EDIT_PARAMS_VERSION,
  modules: [instance('exposure', 'exposure'), instance('filmic', 'filmic')],
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
  if (version < 3 && !('modules' in raw)) return migrateV2(raw);

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
  return normalize(modules);
}

function moduleParams<K extends ModuleKind>(kind: K, input: unknown): ModuleParams[K] {
  const params = merge(defaultModuleParams[kind], input as DeepPartial<ModuleParams[K]>);
  if (kind === 'filmic') {
    const f = params as ModuleParams['filmic'];
    if (!BLEACH_LEVELS.includes(f.bleach)) f.bleach = defaultModuleParams.filmic.bleach;
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
 */
export function migrateV2(input: Record<string, unknown>): EditParams {
  const modules: ModuleInstance[] = [];
  for (const kind of MODULE_KINDS) {
    const section = isObject(input[kind]) ? input[kind] : undefined;
    const params = moduleParams(kind, section);
    const always = kind === 'exposure' || kind === 'filmic';
    if (!always && JSON.stringify(params) === JSON.stringify(defaultModuleParams[kind])) continue;
    // Filmic could be switched off in v2; v3 disables the instance instead.
    const enabled = kind === 'filmic' && typeof section?.enabled === 'boolean' ? section.enabled : true;
    modules.push({ ...instance(kind), enabled, params } as ModuleInstance);
  }
  return normalize(modules);
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
  const existing = findModule(params, kind);
  const base = existing ?? instance(kind, freshId(kind, (id) => params.modules.some((m) => m.id === id)));
  const updated = {
    ...base,
    enabled: patch.enabled ?? base.enabled,
    params: { ...base.params, ...patch.params },
  } as ModuleInstance;
  if (existing) return { ...params, modules: params.modules.map((m) => (m === existing ? updated : m)) };
  const at = params.modules.findLastIndex((m) => rank(m.kind) <= rank(kind)) + 1;
  return { ...params, modules: params.modules.toSpliced(at, 0, updated) };
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

export function isDefaultEdit(params: EditParams): boolean {
  return MODULE_KINDS.every((kind) => !isModuleModified(params, kind));
}
