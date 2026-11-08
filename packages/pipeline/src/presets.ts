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
 * Presets and styles with retouch spots or masks carry the shapes they use (`shapes`);
 * applying them gives those fresh ids where the recipe already has shapes with theirs
 * (`importShapes`). Where references are is only known to `paramShapeRefs` and
 * `mapShapeRefs` (and `maskShapeRefs`/`mapMaskShapeRefs`). A module preset holds the
 * instance's mask only if asked when saving: ranges travel well, drawn shapes rarely.
 *
 * Payloads carry the `EDIT_PARAMS_VERSION` they were saved with. A recipe migration that
 * renames or reinterprets parameters must handle presets too (`normalizeModulePreset`,
 * `normalizeStyle`).
 */

import {
  EDIT_PARAMS_VERSION,
  MASKABLE_KINDS,
  type Mask,
  type EditParams,
  type ModuleInstance,
  type ModuleKind,
  type ModuleParams,
  MODULE_KINDS,
  PRIMARIES,
  SINGLE_INSTANCE_KINDS,
  defaultModuleParams,
  mapMaskShapeRefs,
  maskParams,
  maskShapeRefs,
  moduleParams,
  normalizeEditParams,
  mapShapeRefs,
  paramShapeRefs,
  shapeRefs,
  sortedShapes,
  updateInstance,
  withUsedShapes,
} from './params.ts';
import { type Shape, freshShapeId, normalizeShape } from './shapes.ts';

/**
 * Kinds a module preset can be saved for. Geometry belongs to one image. Retouch spots
 * are in sensor coordinates, so a preset puts them at the same place on the sensor:
 * meant for dust, on photos from the same camera.
 */
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
  // Named like the module's tabs. The ranges usually suit a scene more than a look.
  colorBalance: {
    master: { label: 'Master', keys: ['hueShift', 'vibrance', 'chroma', 'saturation', 'brilliance'] },
    mixer: { label: 'Mixer', keys: ['shadows', 'midtones', 'highlights'] },
    settings: {
      label: 'Settings (ranges, white fulcrum)',
      keys: ['fulcrum', 'midtonesRange', 'shadowsFalloff', 'highlightsFalloff', 'whiteFulcrum'],
    },
  },
  // The range is fitted to each image: a look is usually saved without it.
  toneCurve: {
    curves: {
      label: 'Curves and detail preservation',
      keys: [
        'channels',
        'preserveColors',
        'rgb',
        'red',
        'green',
        'blue',
        'preserveDetail',
        'smoothing',
        'edgeRefinement',
      ],
    },
    range: { label: 'Node range (fitted to this image)', keys: ['range'] },
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
  /** The instance's mask, if saved with it (maskable kinds only): applying sets it. */
  mask?: Mask;
  /** The shapes `params` and `mask` refer to (retouch spots, drawn mask parts); absent without any. */
  shapes?: Record<string, Shape>;
}

/** A module instance in a style: it gets a fresh id when applied. */
export type StyleInstance = ModuleInstance extends infer M ? (M extends ModuleInstance ? Omit<M, 'id'> : never) : never;

export interface StylePayload {
  version: number;
  /** With their masks. */
  modules: StyleInstance[];
  /** The shapes the instances use (retouch spots, masks); absent without any. */
  shapes?: Record<string, Shape>;
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

/**
 * The payload of a preset made from an instance's parameters: `groups` of them (all by
 * default), and its `mask` if given, with the shapes they use from `shapes` (the recipe's).
 */
export function modulePresetPayload<K extends ModuleKind>(
  kind: K,
  params: ModuleParams[K],
  shapes: Record<string, Shape> | undefined,
  groups?: readonly string[],
  mask?: Mask,
): ModulePresetPayload<K> {
  return withShapes(kind, presetParams(kind, params, groups), structuredClone(shapes ?? {}), mask);
}

/** A stored module preset's payload (untrusted input), migrated and with only valid fields. */
export function normalizeModulePreset<K extends ModuleKind>(kind: K, input: unknown): ModulePresetPayload<K> {
  const params = isObject(input) ? input.params : undefined;
  const shapes: Record<string, Shape> = {};
  for (const [id, value] of Object.entries(isObject(input) && isObject(input.shapes) ? input.shapes : {})) {
    const shape = normalizeShape(value);
    if (shape) shapes[id] = shape;
  }
  const mask = isObject(input) && isObject(input.mask) ? maskParams(input.mask) : undefined;
  return withShapes(kind, presetParams(kind, params, 'given'), shapes, mask);
}

/**
 * A payload of `params` (and `mask`, for maskable kinds) and the shapes of `available`
 * they use; references to missing shapes are dropped.
 */
function withShapes<K extends ModuleKind>(
  kind: K,
  params: Partial<ModuleParams[K]>,
  available: Record<string, Shape>,
  mask?: Mask,
): ModulePresetPayload<K> {
  const exists = (id: string) => (id in available ? id : null);
  const kept = mapShapeRefs(kind, params, exists);
  const payload: ModulePresetPayload<K> = { version: EDIT_PARAMS_VERSION, params: kept };
  if (mask && MASKABLE_KINDS.includes(kind)) payload.mask = structuredClone(mapMaskShapeRefs(mask, exists));
  const used = new Set([...paramShapeRefs(kind, kept), ...maskShapeRefs(payload.mask)]);
  if (used.size) payload.shapes = sortedShapes(Object.fromEntries([...used].map((id) => [id, available[id]!])));
  return payload;
}

/**
 * The shapes of a recipe (`existing`) with `incoming` ones added: those whose id is
 * taken get a fresh one. Returns them sorted, and the new id of each incoming shape.
 */
function importShapes(
  existing: Record<string, Shape>,
  incoming: Record<string, Shape> | undefined,
): { shapes: Record<string, Shape>; rename: (id: string) => string } {
  const shapes = { ...existing };
  const renamed = new Map<string, string>();
  const names = Object.keys(incoming ?? {});
  for (const [id, shape] of Object.entries(incoming ?? {})) {
    const to = id in shapes ? freshShapeId([...Object.keys(shapes), ...names]) : id;
    renamed.set(id, to);
    shapes[to] = structuredClone(shape);
  }
  return { shapes: sortedShapes(shapes), rename: (id) => renamed.get(id) ?? id };
}

/** A stored style's payload (untrusted input), migrated like a recipe. */
export function normalizeStyle(input: unknown): StylePayload {
  const raw = isObject(input) ? input : {};
  const version = typeof raw.version === 'number' ? raw.version : EDIT_PARAMS_VERSION;
  const { modules, shapes } = normalizeEditParams({ version, modules: raw.modules, shapes: raw.shapes });
  const payload: StylePayload = {
    version: EDIT_PARAMS_VERSION,
    modules: modules.map(({ id: _, ...m }) => m as StyleInstance),
  };
  if (shapes) payload.shapes = shapes;
  return payload;
}

/** A style made of some of a recipe's instances, by id, in pipeline order. */
export function styleFromRecipe(recipe: EditParams, ids: Iterable<string>): StylePayload {
  const wanted = new Set(ids);
  const chosen = recipe.modules.filter((m) => wanted.has(m.id));
  const payload: StylePayload = {
    version: EDIT_PARAMS_VERSION,
    modules: chosen.map(({ id: _, ...m }) => structuredClone(m) as StyleInstance),
  };
  const used = new Set(shapeRefs(chosen));
  const shapes = Object.entries(recipe.shapes ?? {}).filter(([id]) => used.has(id));
  if (shapes.length) payload.shapes = structuredClone(Object.fromEntries(shapes));
  return payload;
}

/**
 * Apply a module preset to one instance (adding it if it isn't there), and switch it on.
 * A preset with a mask replaces the instance's; one without leaves it alone. Its shapes
 * come along; those the instance used before go if nothing else uses them.
 */
export function applyModulePreset<K extends ModuleKind>(
  recipe: EditParams,
  kind: K,
  id: string,
  payload: Pick<ModulePresetPayload<K>, 'params' | 'shapes' | 'mask'>,
): EditParams {
  const { shapes, rename } = importShapes(recipe.shapes ?? {}, payload.shapes);
  const params = mapShapeRefs(kind, structuredClone(payload.params), rename);
  const mask = payload.mask && mapMaskShapeRefs(structuredClone(payload.mask), rename);
  const next = updateInstance(recipe, kind, id, { enabled: true, params, mask });
  return withUsedShapes(Object.keys(shapes).length ? { ...next, shapes } : next);
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
  const kept = recipe.modules.filter((m) => !replaced(m));
  // The style's shapes, renamed where the recipe keeps a shape with the same id.
  const taken = new Set(shapeRefs(kept));
  const keptShapes = Object.fromEntries(Object.entries(recipe.shapes ?? {}).filter(([id]) => taken.has(id)));
  const { shapes, rename } = importShapes(keptShapes, style.shapes);
  const added = style.modules.map((m) => {
    const copy = { ...structuredClone(m), id: '' } as ModuleInstance;
    const renamed = { ...copy, params: mapShapeRefs(copy.kind, copy.params, rename) } as ModuleInstance;
    if (copy.mask) renamed.mask = mapMaskShapeRefs(copy.mask, rename);
    return renamed;
  });
  return normalizeEditParams({ version: EDIT_PARAMS_VERSION, modules: [...kept, ...added], shapes });
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
  // Tungsten-balanced film (CineStill 800T and the like): white balance fixed for 3200 K
  // lamps, so tungsten light renders neutral and daylight turns blue.
  builtIn('colorCalibration', 'tungsten', 'Tungsten film (3200 K)', {
    illuminant: 'blackBody',
    temperature: 3200,
    adaptation: 'cat16',
  }),
  builtIn('colorBalance', 'vivid', 'Vivid', { chroma: [0.15, 0, 0, 0], vibrance: 0.3 }),
  builtIn('colorBalance', 'muted', 'Muted', { chroma: [-0.3, 0, 0, 0], vibrance: 0 }),
  // Ansel's colour balance rgb presets: more saturation, mostly in the shadows.
  builtIn('colorBalance', 'colorfulness-skin', 'Colorfulness: natural skin', { saturation: [0.2, 0.3, 0, 0] }),
  builtIn('colorBalance', 'colorfulness-standard', 'Colorfulness: standard', { saturation: [0.2, 0.25, 0, 0] }),
  builtIn('colorBalance', 'colorfulness-vibrant', 'Colorfulness: vibrant', { saturation: [0.2, 0.5, 0, 0] }),
  // Split-toning: shadows corrected as if lit by a warm light (so cooler), highlights as
  // if lit by a cool one (so warmer).
  builtIn('colorBalance', 'teal-orange', 'Split-toning: teal and orange', {
    shadows: { ...defaultModuleParams.colorBalance.shadows, temperature: 4500 },
    midtones: { ...defaultModuleParams.colorBalance.midtones },
    highlights: { ...defaultModuleParams.colorBalance.highlights, temperature: 9000 },
  }),
  builtIn('filmic', 'high-contrast', 'High contrast', { contrast: 1.45 }),
  builtIn('filmic', 'low-contrast', 'Low contrast', { contrast: 1 }),
  builtIn('sharpen', 'light', 'Light', { amount: 0.5, radius: 1 }),
  builtIn('sharpen', 'strong', 'Strong', { amount: 1.2, radius: 1.5 }),
  builtIn('contrastEqualizer', 'clarity', 'Clarity', { luma: [0.5, 0.56, 0.6, 0.6, 0.55, 0.5] }),
  // Glow: light around lamps and specular highlights.
  builtIn('glow', 'bloom', 'Bloom', {
    threshold: 1.5,
    softness: 0.5,
    radius: 120,
    falloff: 0.3,
    strength: 2.5,
    saturation: 0,
  }),
  // Film halation: a red to orange fringe around the brightest highlights.
  builtIn('glow', 'halation', 'Halation', {
    threshold: 1.5,
    softness: 0.3,
    radius: 40,
    falloff: -0.6,
    strength: 3,
    hue: 10,
    saturation: 1,
  }),
  // Diffusion filters: a haze over most of the image (Pro-Mist), or only the brighter
  // parts, keeping the shadows deep (Black Pro-Mist).
  builtIn('glow', 'mist', 'Mist', {
    threshold: -1,
    softness: 1,
    radius: 100,
    falloff: 0.5,
    strength: 0.4,
    saturation: 0,
  }),
  builtIn('glow', 'black-mist', 'Black mist', {
    threshold: 0.5,
    softness: 1,
    radius: 60,
    falloff: 0,
    strength: 0.6,
    saturation: 0,
  }),
  // Darker shadows and brighter highlights around middle grey (nodes every 1.5 EV from
  // -9 EV), back to no change at the ends.
  // Contrast is global: preserving detail would move whole areas and leave their texture.
  builtIn('toneCurve', 'contrast-low', 'Contrast: low', {
    channels: 'linked',
    preserveDetail: false,
    rgb: [0, 0, -0.1, -0.2, -0.2, -0.1, 0, 0.15, 0.1],
  }),
  builtIn('toneCurve', 'contrast-medium', 'Contrast: medium', {
    channels: 'linked',
    preserveDetail: false,
    rgb: [0, -0.1, -0.25, -0.4, -0.4, -0.2, 0, 0.3, 0.2],
  }),
  builtIn('toneCurve', 'contrast-high', 'Contrast: high', {
    channels: 'linked',
    preserveDetail: false,
    rgb: [0, -0.15, -0.4, -0.65, -0.65, -0.35, 0, 0.5, 0.35],
  }),
  // Dynamic range: the tone equalizer's job, keeping the texture of what moves.
  builtIn('toneCurve', 'lift-shadows', 'Lift shadows', {
    channels: 'linked',
    preserveDetail: true,
    rgb: [0.5, 0.6, 0.6, 0.45, 0.25, 0.1, 0, 0, 0],
  }),
  builtIn('toneCurve', 'compress-highlights', 'Compress highlights', {
    channels: 'linked',
    preserveDetail: true,
    rgb: [0, 0, 0, 0, 0, -0.1, -0.3, -0.6, -0.9],
  }),
  builtIn('toneCurve', 'compress-dynamic-range', 'Compress dynamic range', {
    channels: 'linked',
    preserveDetail: true,
    rgb: [0.6, 0.6, 0.5, 0.35, 0.15, 0, -0.2, -0.45, -0.7],
  }),
];
