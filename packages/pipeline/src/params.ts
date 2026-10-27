/**
 * Edit parameters — the "recipe" applied to a RAW file: a list of module instances.
 * Mirrors `EditParams` in `crates/pipeline/src/params.rs`; keep both in sync.
 *
 * The pipeline order is fixed by module kind (`MODULE_KINDS`); instances of the same
 * kind run in list order. A kind with no enabled instance is skipped.
 */

export interface ModuleParams {
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
  /** Filmic RGB tone mapping, after Ansel (spline v3, colour science v8 "AgX"). */
  filmic: {
    /** Scene exposure mapped to display white, EV relative to middle grey. */
    whiteExposure: number;
    /** Scene exposure mapped to display black, EV relative to middle grey (negative). */
    blackExposure: number;
    /** Slope of the linear part, 0 … 5. */
    contrast: number;
    /** Toe size: curved share of the range between black and middle grey, 0 … 100 %. */
    toe: number;
    /** Shoulder size: curved share of the range between middle grey and white, 0 … 100 %. */
    shoulder: number;
    /** AgX hue recovery: -100 keeps the film-like drift, +100 restores original hues. */
    huePreservation: number;
    bleach: Bleach;
    /** Widens (+) or narrows (-) the range found by auto-tune, %, -50 … +200. */
    dynamicRangeScaling: number;
  };
}

export type ModuleKind = keyof ModuleParams;

/** Module kinds, in pipeline order. */
export const MODULE_KINDS = [
  'geometry',
  'blur',
  'sharpen',
  'exposure',
  'whiteBalance',
  'color',
  'shadowsHighlights',
  'filmic',
] as const satisfies readonly ModuleKind[];

/** Kinds whose extra instances are dropped on load. */
export const SINGLE_INSTANCE_KINDS: readonly ModuleKind[] = ['geometry', 'filmic'];

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
 */
export const EDIT_PARAMS_VERSION = 4;

/** Parameters of a new instance of each kind. */
export const defaultModuleParams: { readonly [K in ModuleKind]: ModuleParams[K] } = Object.freeze({
  geometry: { rotation: 0, flipHorizontal: false, angle: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
  blur: { radius: 0 },
  sharpen: { amount: 0, radius: 1 },
  // Ansel's default push for RAW files.
  exposure: { ev: 0.7, black: 0 },
  whiteBalance: { warmth: 0, tint: 0 },
  color: { saturation: 0, vibrance: 0 },
  shadowsHighlights: { shadows: 0, highlights: 0 },
  // Ansel's defaults for RAW files, paired with the +0.7 EV exposure default.
  filmic: {
    whiteExposure: 3.15,
    blackExposure: -8.85,
    contrast: 1.18,
    // Ansel's latitude 10 %, balance 0.
    toe: 90,
    shoulder: 90,
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
  migrateFilmicLatitude(raw);
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
 * v1–v3 filmic `latitude`/`balance` → `toe`/`shoulder`. Exact when balance is 0;
 * otherwise assumes equal room on both sides of grey. Mirrors `migrate_filmic_latitude`.
 */
function migrateFilmicLatitude(raw: Record<string, unknown>) {
  const fix = (p: unknown) => {
    if (!isObject(p) || !('latitude' in p || 'balance' in p)) return;
    const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const latitude = clamp(num(p.latitude, 10), 0, 100) / 100;
    const balance = clamp(num(p.balance, 0), -50, 50) / 100;
    const size = (s: number) => Math.round(clamp(1 - latitude * s, 0, 1) * 10_000) / 100;
    delete p.latitude;
    delete p.balance;
    p.toe ??= size(1 + 2 * balance);
    p.shoulder ??= size(1 - 2 * balance);
  };
  if (Array.isArray(raw.modules)) {
    for (const m of raw.modules) if (isObject(m) && m.kind === 'filmic') fix(m.params);
  } else {
    fix(raw.filmic);
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** `base` with the fields of `patch` that have the right type. */
function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
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
