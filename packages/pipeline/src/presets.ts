/**
 * Presets (roadmap 4.2): named parameters for one module kind, and styles, a chosen set
 * of module instances from a recipe. Both are applied on the client, so the pipeline
 * (and the Rust side) never sees them: applying one gives a plain recipe.
 *
 * A module preset may hold only some of a module's parameters (e.g. colour calibration's
 * mixer, leaving the white balance alone). Applying it sets those and keeps the others.
 * Parameters are only ever taken whole at the top level (an array, a colour primary), so
 * applying never has to merge inside a value.
 *
 * Payloads carry the `EDIT_PARAMS_VERSION` they were saved with. A recipe migration that
 * renames or reinterprets parameters must handle presets too (`normalizeModulePreset`,
 * `normalizeStyle`).
 */

import {
  EDIT_PARAMS_VERSION,
  type EditParams,
  type ModuleInstance,
  type ModuleKind,
  type ModuleParams,
  MODULE_KINDS,
  PRIMARIES,
  SINGLE_INSTANCE_KINDS,
  defaultModuleParams,
  moduleParams,
  normalizeEditParams,
  updateInstance,
} from './params.ts';

/** Kinds a module preset can be saved for. Geometry belongs to one image. */
export const PRESET_KINDS: readonly ModuleKind[] = MODULE_KINDS.filter((k) => k !== 'geometry');

export interface PresetGroup<K extends ModuleKind> {
  label: string;
  keys: readonly (keyof ModuleParams[K] & string)[];
}

/**
 * The parts of a module a preset can be limited to, for the kinds where saving only
 * some of it makes sense. Together, a kind's groups cover all of its parameters.
 */
export const PRESET_GROUPS: { readonly [K in ModuleKind]?: Readonly<Record<string, PresetGroup<K>>> } = {
  // Named like the module's tabs.
  colorCalibration: {
    illuminant: {
      label: 'CAT',
      keys: ['illuminant', 'temperature', 'fluorescent', 'led', 'x', 'y', 'adaptation', 'gamut', 'clip'],
    },
    mixer: {
      label: 'Mixer',
      keys: ['red', 'green', 'blue', 'normalizeRed', 'normalizeGreen', 'normalizeBlue'],
    },
    output: {
      label: 'Output',
      keys: ['colorfulness', 'normalizeColorfulness', 'brightness', 'normalizeBrightness', 'grey', 'normalizeGrey'],
    },
  },
  filmic: {
    scene: { label: 'White and black exposure', keys: ['whiteExposure', 'blackExposure', 'dynamicRangeScaling'] },
    look: {
      label: 'Look (contrast, toe, shoulder, hues)',
      keys: ['contrast', 'toe', 'shoulder', 'huePreservation', 'bleach'],
    },
  },
  colorPrimaries: {
    colors: { label: 'Color edits', keys: PRIMARIES },
    settings: {
      label: 'Range and smoothing',
      keys: [
        'whiteLevel',
        'gamutCoverage',
        'brightnessSmoothing',
        'saturationSmoothing',
        'hueSmoothing',
        'neutralProtection',
      ],
    },
  },
};

export interface ModulePresetPayload<K extends ModuleKind = ModuleKind> {
  version: number;
  /** Some or all of the kind's parameters. */
  params: Partial<ModuleParams[K]>;
}

/** A module instance in a style: it gets a fresh id when applied. */
export type StyleInstance = ModuleInstance extends infer M ? (M extends ModuleInstance ? Omit<M, 'id'> : never) : never;

export interface StylePayload {
  version: number;
  modules: StyleInstance[];
}

interface PresetBase {
  id: string;
  name: string;
  /** Shipped with the app (read-only), rather than saved by the user. */
  builtIn: boolean;
}

export type Preset =
  | (PresetBase & { type: 'module'; moduleKind: ModuleKind; payload: ModulePresetPayload })
  | (PresetBase & { type: 'style'; moduleKind: null; payload: StylePayload });

export type ModulePreset = Extract<Preset, { type: 'module' }>;
export type Style = Extract<Preset, { type: 'style' }>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The keys of a group selection; all of the kind's parameters without groups. */
function groupKeys(kind: ModuleKind, groups: readonly string[] | undefined): string[] {
  const all = Object.keys(defaultModuleParams[kind]);
  const defined = PRESET_GROUPS[kind] as Record<string, PresetGroup<ModuleKind>> | undefined;
  if (!groups || !defined) return all;
  return groups.flatMap((g) => defined[g]?.keys ?? []);
}

/**
 * The parameters of a module preset: `groups` of `params` (all of them by default), or,
 * reading a stored preset (`groups` = 'given'), the valid fields `params` has.
 */
export function presetParams<K extends ModuleKind>(
  kind: K,
  params: unknown,
  groups?: readonly string[] | 'given',
): Partial<ModuleParams[K]> {
  const full = moduleParams(kind, params) as Record<string, unknown>;
  const keys =
    groups === 'given' ? Object.keys(full).filter((k) => isObject(params) && k in params) : groupKeys(kind, groups);
  return Object.fromEntries(keys.map((k) => [k, full[k]])) as Partial<ModuleParams[K]>;
}

/** The groups a preset's parameters cover entirely (none for kinds without groups). */
export function presetGroupsOf(kind: ModuleKind, params: object): string[] {
  const defined = PRESET_GROUPS[kind] as Record<string, PresetGroup<ModuleKind>> | undefined;
  return Object.entries(defined ?? {})
    .filter(([, g]) => g.keys.every((k) => k in params))
    .map(([name]) => name);
}

/** A stored module preset's payload (untrusted input), migrated and with only valid fields. */
export function normalizeModulePreset<K extends ModuleKind>(kind: K, input: unknown): ModulePresetPayload<K> {
  const params = isObject(input) ? input.params : undefined;
  return { version: EDIT_PARAMS_VERSION, params: presetParams(kind, params, 'given') };
}

/** A stored style's payload (untrusted input), migrated like a recipe. */
export function normalizeStyle(input: unknown): StylePayload {
  const raw = isObject(input) ? input : {};
  const version = typeof raw.version === 'number' ? raw.version : EDIT_PARAMS_VERSION;
  const { modules } = normalizeEditParams({ version, modules: raw.modules });
  return { version: EDIT_PARAMS_VERSION, modules: modules.map(({ id: _, ...m }) => m as StyleInstance) };
}

/** A style made of some of a recipe's instances, by id, in pipeline order. */
export function styleFromRecipe(recipe: EditParams, ids: Iterable<string>): StylePayload {
  const wanted = new Set(ids);
  return {
    version: EDIT_PARAMS_VERSION,
    modules: recipe.modules
      .filter((m) => wanted.has(m.id))
      .map(({ id: _, ...m }) => structuredClone(m) as StyleInstance),
  };
}

/** Apply a module preset to one instance (adding it if it isn't there), and switch it on. */
export function applyModulePreset<K extends ModuleKind>(
  recipe: EditParams,
  kind: K,
  id: string,
  params: Partial<ModuleParams[K]>,
): EditParams {
  return updateInstance(recipe, kind, id, { enabled: true, params: structuredClone(params) });
}

/**
 * - `replace`: the style's instances take the place of every instance of their kinds.
 * - `append`: they are added after the existing ones (those of single-instance kinds,
 *   like filmic, still replace theirs).
 */
export type StyleMode = 'replace' | 'append';

/** Apply a style. Instances that stay keep their ids; added ones get fresh ids. */
export function applyStyle(recipe: EditParams, style: StylePayload, mode: StyleMode): EditParams {
  const kinds = new Set(style.modules.map((m) => m.kind));
  const replaced = (m: ModuleInstance) =>
    kinds.has(m.kind) && (mode === 'replace' || SINGLE_INSTANCE_KINDS.includes(m.kind));
  const added = style.modules.map((m) => ({ ...structuredClone(m), id: '' }));
  return normalizeEditParams({
    version: EDIT_PARAMS_VERSION,
    modules: [...recipe.modules.filter((m) => !replaced(m)), ...added],
  });
}

const builtIn = <K extends ModuleKind>(
  kind: K,
  slug: string,
  name: string,
  params: Partial<ModuleParams[K]>,
): ModulePreset => ({
  id: `builtin:${kind}:${slug}`,
  name,
  builtIn: true,
  type: 'module',
  moduleKind: kind,
  payload: { version: EDIT_PARAMS_VERSION, params },
});

/** Presets shipped with the app. Most only set some parameters, and keep the rest. */
export const BUILTIN_PRESETS: readonly ModulePreset[] = [
  builtIn('colorCalibration', 'mono-luminance', 'Monochrome: luminance', {
    // Rec.2020 luminance: the working space's.
    grey: [0.2627, 0.678, 0.0593],
    normalizeGrey: true,
  }),
  builtIn('colorCalibration', 'mono-red', 'Monochrome: red filter', { grey: [0.7, 0.3, 0], normalizeGrey: true }),
  builtIn('colorCalibration', 'mono-green', 'Monochrome: green filter', { grey: [0.2, 0.7, 0.1], normalizeGrey: true }),
  builtIn('color', 'vivid', 'Vivid', { saturation: 0.15, vibrance: 0.3 }),
  builtIn('color', 'muted', 'Muted', { saturation: -0.3, vibrance: 0 }),
  builtIn('filmic', 'high-contrast', 'High contrast', { contrast: 1.45 }),
  builtIn('filmic', 'low-contrast', 'Low contrast', { contrast: 1 }),
  builtIn('sharpen', 'light', 'Light', { amount: 0.5, radius: 1 }),
  builtIn('sharpen', 'strong', 'Strong', { amount: 1.2, radius: 1.5 }),
  builtIn('contrastEqualizer', 'clarity', 'Clarity', { luma: [0.5, 0.56, 0.6, 0.6, 0.55, 0.5] }),
];
