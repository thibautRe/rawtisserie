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
  AUTO_TUNE_KINDS,
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
      label: 'Curves, detail preservation and strength',
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
        'strength',
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
    display: {
      label: 'Display (hardness, target black and white)',
      keys: ['autoHardness', 'hardness', 'blackTarget', 'whiteTarget'],
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
  /** Run the kind's auto-tune once applied (`AUTO_TUNE_KINDS` only; roadmap 8.7); absent when not. */
  autoTune?: true;
}

/**
 * How a style's instance is applied (roadmap 8.8):
 * - `replace`: it takes the place of the target's instance of its kind at the same rank
 *   (a style's first `replace` instance of a kind replaces the target's first one, its
 *   second the target's second…), or is added if the target has fewer.
 * - `append`: it's added after the target's instances of its kind.
 * Single-instance kinds (filmic…) and partial instances always replace.
 */
export type StyleMode = 'replace' | 'append';

/** A module instance in a style: it gets a fresh id when applied (or the one of the instance it replaces). */
export type StyleInstance = ModuleInstance extends infer M
  ? M extends ModuleInstance
    ? Omit<M, 'id'> & {
        mode: StyleMode;
        /**
         * Only these `PRESET_GROUPS` of its parameters are applied, onto the target's
         * instance (like a module preset; its mask stays). Absent: the whole instance.
         */
        groups?: string[];
      }
    : never
  : never;

export interface StylePayload {
  version: number;
  /** With their masks (whole instances only). */
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
  // Lensfun's profile is one shot's (its focal length, aperture, camera): presets keep the strengths.
  if (kind === 'lens') delete full.lensfun;
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
  autoTune = false,
): ModulePresetPayload<K> {
  return withShapes(kind, presetParams(kind, params, groups), structuredClone(shapes ?? {}), mask, autoTune);
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
  return withShapes(
    kind,
    presetParams(kind, params, 'given'),
    shapes,
    mask,
    isObject(input) && input.autoTune === true,
  );
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
  autoTune = false,
): ModulePresetPayload<K> {
  const exists = (id: string) => (id in available ? id : null);
  const kept = mapShapeRefs(kind, params, exists);
  const payload: ModulePresetPayload<K> = { version: EDIT_PARAMS_VERSION, params: kept };
  if (mask && MASKABLE_KINDS.includes(kind)) payload.mask = structuredClone(mapMaskShapeRefs(mask, exists));
  const used = new Set([...paramShapeRefs(kind, kept), ...maskShapeRefs(payload.mask)]);
  if (used.size) payload.shapes = sortedShapes(Object.fromEntries([...used].map((id) => [id, available[id]!])));
  if (autoTune && AUTO_TUNE_KINDS.includes(kind)) payload.autoTune = true;
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

/**
 * The valid groups of `kind` in `input`, or undefined for the whole instance (no groups,
 * none valid, or all of them).
 */
function styleGroups(kind: ModuleKind, input: unknown): string[] | undefined {
  const defined = Object.keys(PRESET_GROUPS[kind] ?? {});
  if (!Array.isArray(input)) return undefined;
  const groups = defined.filter((g) => input.includes(g));
  return groups.length && groups.length < defined.length ? groups : undefined;
}

/** A style instance's mode, as stored: partial instances and single-instance kinds always replace. */
function styleMode(kind: ModuleKind, mode: unknown, groups: readonly string[] | undefined): StyleMode {
  return mode === 'append' && !groups && !SINGLE_INSTANCE_KINDS.includes(kind) ? 'append' : 'replace';
}

/** A style instance from a recipe's instance: without its id, and its mask if partial. */
function styleInstance(m: ModuleInstance, mode: unknown, groups: unknown): StyleInstance {
  const { id: _, ...rest } = structuredClone(m);
  // As module presets: the strengths, not one shot's lensfun profile.
  if (rest.kind === 'lens') delete (rest.params as Partial<ModuleParams['lens']>).lensfun;
  const kept = styleGroups(m.kind, groups);
  const instance = { ...rest, mode: styleMode(m.kind, mode, kept) } as StyleInstance;
  if (kept) {
    instance.groups = kept;
    delete instance.mask;
  }
  return instance;
}

/** The shapes of `available` that `modules` use, if any. */
function styleShapes(modules: readonly StyleInstance[], available: Record<string, Shape> | undefined) {
  const used = new Set(shapeRefs(modules as unknown as ModuleInstance[]));
  const shapes = Object.entries(available ?? {}).filter(([id]) => used.has(id));
  return shapes.length ? structuredClone(Object.fromEntries(shapes)) : undefined;
}

/**
 * A stored style's payload (untrusted input), migrated like a recipe. Instances without
 * a mode (saved before 8.8) replace.
 */
export function normalizeStyle(input: unknown): StylePayload {
  const raw = isObject(input) ? input : {};
  const version = typeof raw.version === 'number' ? raw.version : EDIT_PARAMS_VERSION;
  const rawModules = (Array.isArray(raw.modules) ? raw.modules : []) as unknown[];
  // Tagged with their index, so that their mode and groups can be found after normalising
  // (which drops invalid instances and sorts them).
  const tagged = rawModules.map((m, i) => (isObject(m) ? { ...m, id: `style-${i}` } : m));
  const { modules, shapes } = normalizeEditParams({ version, modules: tagged, shapes: raw.shapes });
  const styled = modules.map((m) => {
    // Instances added by a migration have no source.
    const source = m.id.startsWith('style-') ? rawModules[Number(m.id.slice(6))] : undefined;
    return isObject(source) ? styleInstance(m, source.mode, source.groups) : styleInstance(m, 'replace', undefined);
  });
  const payload: StylePayload = { version: EDIT_PARAMS_VERSION, modules: styled };
  const kept = styleShapes(styled, shapes);
  if (kept) payload.shapes = kept;
  return payload;
}

/**
 * How an instance of a recipe goes into a style by default: `replace` for its kind's
 * first instance (or a single-instance kind), `append` for the others.
 */
export function defaultStyleMode(recipe: EditParams, id: string): StyleMode {
  const instance = recipe.modules.find((m) => m.id === id);
  if (!instance) return 'replace';
  return recipe.modules.find((m) => m.kind === instance.kind) === instance ? 'replace' : 'append';
}

export interface StylePick {
  /** Each instance's mode; `defaultStyleMode` if absent. */
  modes?: Readonly<Record<string, StyleMode>>;
  /** For kinds with `PRESET_GROUPS`, the groups to take of an instance; all if absent. */
  groups?: Readonly<Record<string, readonly string[]>>;
  /** Instances (of `AUTO_TUNE_KINDS`) to auto-tune once applied. */
  autoTune?: Readonly<Record<string, boolean>>;
}

/** A style made of some of a recipe's instances, by id, in pipeline order. */
export function styleFromRecipe(recipe: EditParams, ids: Iterable<string>, pick: StylePick = {}): StylePayload {
  const wanted = new Set(ids);
  const modules = recipe.modules
    .filter((m) => wanted.has(m.id))
    .map((m) => {
      const instance = styleInstance(m, pick.modes?.[m.id] ?? defaultStyleMode(recipe, m.id), pick.groups?.[m.id]);
      if (pick.autoTune?.[m.id] && AUTO_TUNE_KINDS.includes(m.kind)) instance.autoTune = true;
      else delete instance.autoTune;
      return instance;
    });
  const payload: StylePayload = { version: EDIT_PARAMS_VERSION, modules };
  const shapes = styleShapes(modules, recipe.shapes);
  if (shapes) payload.shapes = shapes;
  return payload;
}

/**
 * Apply a module preset to one instance (adding it if it isn't there), and switch it on.
 * A preset with a mask replaces the instance's; one without leaves it alone. Its shapes
 * come along; those the instance used before go if nothing else uses them. A preset
 * asking for its auto-tune marks the instance for it.
 */
export function applyModulePreset<K extends ModuleKind>(
  recipe: EditParams,
  kind: K,
  id: string,
  payload: Pick<ModulePresetPayload<K>, 'params' | 'shapes' | 'mask' | 'autoTune'>,
): EditParams {
  const { shapes, rename } = importShapes(recipe.shapes ?? {}, payload.shapes);
  const params = mapShapeRefs(kind, structuredClone(payload.params), rename);
  const mask = payload.mask && mapMaskShapeRefs(structuredClone(payload.mask), rename);
  let next = updateInstance(recipe, kind, id, { enabled: true, params, mask });
  // Marked for its auto-tune (resolved by whoever renders it next: `autoTune.ts`).
  if (payload.autoTune && AUTO_TUNE_KINDS.includes(kind)) {
    next = { ...next, modules: next.modules.map((m) => (m.id === id ? { ...m, autoTune: true as const } : m)) };
  }
  return withUsedShapes(Object.keys(shapes).length ? { ...next, shapes } : next);
}

/** The parameters of `groups` of `params`. */
function pickGroups(kind: ModuleKind, params: object, groups: readonly string[]): Record<string, unknown> {
  const p = params as Record<string, unknown>;
  return Object.fromEntries(groupKeys(kind, groups).map((k) => [k, structuredClone(p[k])]));
}

/**
 * Apply a style (roadmap 8.8): each instance by its mode, or, with `appendAll`, all of
 * them appended (except those that always replace). Instances it doesn't replace keep
 * their ids, and so do replaced ones; added ones get fresh ids.
 */
export function applyStyle(recipe: EditParams, style: StylePayload, appendAll = false): EditParams {
  const mode = (m: StyleInstance): StyleMode =>
    appendAll && styleMode(m.kind, 'append', m.groups) === 'append' ? 'append' : m.mode;
  // Which of the recipe's instances each `replace` instance takes the place of.
  const replacing = new Map<string, StyleInstance>();
  const added: StyleInstance[] = [];
  const rank = new Map<ModuleKind, number>();
  for (const m of style.modules) {
    if (mode(m) === 'append') {
      added.push(m);
      continue;
    }
    const n = rank.get(m.kind) ?? 0;
    rank.set(m.kind, n + 1);
    const target = recipe.modules.filter((t) => t.kind === m.kind)[n];
    if (target) replacing.set(target.id, m);
    else added.push(m);
  }
  const whole = (m: StyleInstance | undefined) => !!m && !m.groups;
  // The style's shapes, renamed where the recipe keeps a shape with the same id.
  const taken = new Set(shapeRefs(recipe.modules.filter((t) => !whole(replacing.get(t.id)))));
  const keptShapes = Object.fromEntries(Object.entries(recipe.shapes ?? {}).filter(([id]) => taken.has(id)));
  const { shapes, rename } = importShapes(keptShapes, style.shapes);

  /** A style instance made into a recipe's, `onto` an instance it replaces or a new one. */
  const instance = (m: StyleInstance, onto: ModuleInstance | undefined): ModuleInstance => {
    const { mode: _, groups, ...copy } = structuredClone(m);
    if (groups) {
      const base =
        onto ?? ({ id: '', label: copy.label, kind: m.kind, params: defaultModuleParams[m.kind] } as ModuleInstance);
      const made = {
        ...base,
        enabled: copy.enabled,
        params: { ...base.params, ...pickGroups(m.kind, copy.params, groups) },
      } as ModuleInstance;
      if (copy.autoTune) made.autoTune = true;
      return made;
    }
    const made = { ...copy, id: onto?.id ?? '', params: mapShapeRefs(m.kind, copy.params, rename) } as ModuleInstance;
    if (copy.mask) made.mask = mapMaskShapeRefs(copy.mask, rename);
    // The photo's own lensfun profile stays: a style's lens instance has strengths only.
    const own = onto?.kind === 'lens' ? (onto.params as ModuleParams['lens']).lensfun : undefined;
    if (own) (made.params as ModuleParams['lens']).lensfun = structuredClone(own);
    return made;
  };
  const modules = [
    ...recipe.modules.map((t) => {
      const m = replacing.get(t.id);
      return m ? instance(m, t) : t;
    }),
    ...added.map((m) => instance(m, undefined)),
  ];
  return normalizeEditParams({ version: EDIT_PARAMS_VERSION, modules, shapes });
}

const builtIn = <K extends ModuleKind>(
  kind: K,
  slug: string,
  name: string,
  params: Partial<ModuleParams[K]>,
  autoTune = false,
): ModulePreset => ({
  id: `builtin:${kind}:${slug}`,
  name,
  builtIn: true,
  type: 'module',
  moduleKind: kind,
  payload: { version: EDIT_PARAMS_VERSION, params, ...(autoTune && { autoTune: true as const }) },
});

/** A diffuse or sharpen preset, as Ansel's: every parameter set, from zero. */
interface DiffuseSettings {
  iterations: number;
  radius: number;
  radiusCenter?: number;
  /** Of the four orders. */
  speeds: readonly [number, number, number, number];
  anisotropies: readonly [number, number, number, number];
  edgeSensitivity: number;
  edgeThreshold?: number;
  luminanceThreshold?: number;
}

const diffuse = (slug: string, name: string, p: DiffuseSettings): ModulePreset =>
  builtIn('diffuse', slug, name, {
    iterations: p.iterations,
    radiusCenter: p.radiusCenter ?? 0,
    radius: p.radius,
    speed1: p.speeds[0],
    speed2: p.speeds[1],
    speed3: p.speeds[2],
    speed4: p.speeds[3],
    anisotropy1: p.anisotropies[0],
    anisotropy2: p.anisotropies[1],
    anisotropy3: p.anisotropies[2],
    anisotropy4: p.anisotropies[3],
    sharpness: 0,
    edgeSensitivity: p.edgeSensitivity,
    edgeThreshold: p.edgeThreshold ?? 0,
    luminanceThreshold: p.luminanceThreshold ?? 0,
  });

const DEBLUR: Pick<DiffuseSettings, 'speeds' | 'anisotropies' | 'edgeSensitivity'> = {
  speeds: [-0.25, 0.125, -0.125, 0.0625],
  anisotropies: [2, 0, 2, 0],
  edgeSensitivity: 1,
};
const DENOISE: Pick<DiffuseSettings, 'iterations' | 'anisotropies' | 'edgeSensitivity'> = {
  iterations: 32,
  anisotropies: [2, 0, 2, 0],
  edgeSensitivity: 2.5,
};
const FAST: Omit<DiffuseSettings, 'radius'> = {
  iterations: 1,
  speeds: [0, 0, -0.5, 0],
  anisotropies: [0, 0, 5, 0],
  edgeSensitivity: 0,
};

/**
 * Ansel's diffuse or sharpen presets (`init_presets` in `diffuse.c`), in its units. Its
 * "bloom" is "Soft diffusion" here: glow is what makes light spread from highlights.
 */
const DIFFUSE_PRESETS: readonly ModulePreset[] = [
  diffuse('demosaic-aa', 'Sharpen demosaicing (AA filter)', {
    iterations: 1,
    radius: 8,
    speeds: [-0.25, -0.25, -0.25, -0.25],
    anisotropies: [1, 1, 1, 1],
    edgeSensitivity: 1,
  }),
  diffuse('demosaic-no-aa', 'Sharpen demosaicing (no AA filter)', {
    iterations: 1,
    radius: 4,
    speeds: [-0.25, -0.25, -0.25, -0.25],
    anisotropies: [1, 1, 1, 1],
    edgeSensitivity: 1,
  }),
  diffuse('fast-sharpness', 'Fast sharpness', { ...FAST, radius: 128 }),
  diffuse('deblur-soft', 'Lens deblur: soft', { ...DEBLUR, iterations: 8, radius: 8 }),
  diffuse('deblur-medium', 'Lens deblur: medium', { ...DEBLUR, iterations: 16, radius: 10 }),
  diffuse('deblur-hard', 'Lens deblur: hard', { ...DEBLUR, iterations: 24, radius: 12 }),
  diffuse('local-contrast', 'Add local contrast', {
    iterations: 10,
    radius: 333,
    radiusCenter: 512,
    speeds: [-0.5, 0, 0, -0.5],
    anisotropies: [-2.5, 0, 0, -2.5],
    edgeSensitivity: 0.1,
  }),
  diffuse('fast-local-contrast', 'Fast local contrast', {
    ...FAST,
    radius: 512,
    radiusCenter: 512,
  }),
  diffuse('dehaze', 'Dehaze', {
    iterations: 10,
    radius: 512,
    speeds: [-0.2, 0.1, -0.2, 0.1],
    anisotropies: [2, 0, 2, 0],
    edgeSensitivity: 2.5,
  }),
  // Retuned in Ansel (issue #879) against synthetic sensor noise: fine for ISO 400–800,
  // medium 800–1600, coarse 1600–3200.
  diffuse('denoise-fine', 'Denoise: fine', { ...DENOISE, radius: 1, radiusCenter: 2, speeds: [0.1, 0, 0.1, 0] }),
  diffuse('denoise-medium', 'Denoise: medium', { ...DENOISE, radius: 3, radiusCenter: 4, speeds: [0.1, 0, 0.1, 0] }),
  diffuse('denoise-coarse', 'Denoise: coarse', { ...DENOISE, radius: 6, radiusCenter: 8, speeds: [0, 0, 0.25, 0] }),
  diffuse('inpaint-highlights', 'Inpaint highlights', {
    iterations: 32,
    radius: 4,
    speeds: [0, 0, 0, 0.5],
    anisotropies: [0, 0, 0, 2],
    edgeSensitivity: 0,
    luminanceThreshold: 1.41,
  }),
  diffuse('surface-blur', 'Surface blur', {
    iterations: 2,
    radius: 32,
    speeds: [1, 1, 1, 1],
    anisotropies: [4, 4, 4, 4],
    edgeSensitivity: 4,
  }),
  diffuse('soft-diffusion', 'Soft diffusion', {
    iterations: 1,
    radius: 32,
    speeds: [0.5, 0.5, 0.5, 0.5],
    anisotropies: [0, 0, 0, 0],
    edgeSensitivity: 0,
  }),
  diffuse('watercolor', 'Simulate watercolor', {
    iterations: 4,
    radius: 64,
    speeds: [0, 0, 0.5, 0.5],
    anisotropies: [0, 0, 4, 4],
    edgeSensitivity: 2,
  }),
  diffuse('line-drawing', 'Simulate line drawing', {
    iterations: 50,
    radius: 64,
    speeds: [-1, -1, -1, -1],
    anisotropies: [-5, -5, -5, -5],
    edgeSensitivity: 4,
  }),
];

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
  builtIn('colorBalance', 'vivid', 'Vivid', { chroma: [0.15, 0.15, 0.15], vibrance: 0.3 }),
  builtIn('colorBalance', 'muted', 'Muted', { chroma: [-0.3, -0.3, -0.3], vibrance: 0 }),
  // Ansel's colour balance rgb presets: more saturation, mostly in the shadows.
  builtIn('colorBalance', 'colorfulness-skin', 'Colorfulness: natural skin', { saturation: [0.5, 0.2, 0.2] }),
  builtIn('colorBalance', 'colorfulness-standard', 'Colorfulness: standard', { saturation: [0.45, 0.2, 0.2] }),
  builtIn('colorBalance', 'colorfulness-vibrant', 'Colorfulness: vibrant', { saturation: [0.7, 0.2, 0.2] }),
  // Split-toning: shadows corrected as if lit by a warm light (so cooler), highlights as
  // if lit by a cool one (so warmer).
  builtIn('colorBalance', 'teal-orange', 'Split-toning: teal and orange', {
    shadows: { ...defaultModuleParams.colorBalance.shadows, temperature: 4500 },
    midtones: { ...defaultModuleParams.colorBalance.midtones },
    highlights: { ...defaultModuleParams.colorBalance.highlights, temperature: 9000 },
  }),
  builtIn('filmic', 'high-contrast', 'High contrast', { contrast: 1.45 }),
  builtIn('filmic', 'low-contrast', 'Low contrast', { contrast: 1 }),
  // Diffuse or sharpen: Ansel's presets (`diffuse.c`), each setting every parameter.
  ...DIFFUSE_PRESETS,
  builtIn('contrastEqualizer', 'clarity', 'Clarity', { luma: [0.5, 0.56, 0.6, 0.6, 0.55, 0.5] }),
  // Glow: light around lamps and specular highlights.
  builtIn('glow', 'bloom', 'Bloom', {
    threshold: 1.5,
    softness: 0.5,
    radius: 120,
    falloff: 0.3,
    strength: 2.5,
    saturation: 0,
    shape: 'round',
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
    shape: 'round',
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
    shape: 'round',
  }),
  builtIn('glow', 'black-mist', 'Black mist', {
    threshold: 0.5,
    softness: 1,
    radius: 60,
    falloff: 0,
    strength: 0.6,
    saturation: 0,
    shape: 'round',
  }),
  // Along an axis: an anamorphic lens's blue streaks, and lights trailing as if they moved.
  // Tint hue -145° (215°), within the slider's ±180°. Radius past the slider's range.
  builtIn('glow', 'anamorphic-streak', 'Anamorphic streak', {
    threshold: 2.5,
    softness: 0.2,
    radius: 700,
    falloff: 0.3,
    strength: 2,
    hue: -145,
    saturation: 0.7,
    shape: 'streak',
    angle: 0,
    thickness: 0.01,
  }),
  builtIn('glow', 'motion', 'Motion trail', {
    threshold: 2,
    softness: 0.5,
    radius: 150,
    falloff: 0.3,
    strength: 1.5,
    saturation: 0,
    shape: 'motion',
    angle: 0,
    thickness: 0.05,
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
  // Dynamic range: the tone equalizer's job, keeping the texture of what moves. The node
  // range is fitted to each photo (its auto-tune), so that they act on its own shadows
  // and highlights.
  builtIn(
    'toneCurve',
    'lift-shadows',
    'Lift shadows',
    {
      channels: 'linked',
      preserveDetail: true,
      rgb: [0.5, 0.6, 0.6, 0.45, 0.25, 0.1, 0, 0, 0],
    },
    true,
  ),
  builtIn(
    'toneCurve',
    'compress-highlights',
    'Compress highlights',
    {
      channels: 'linked',
      preserveDetail: true,
      rgb: [0, 0, 0, 0, 0, -0.1, -0.3, -0.6, -0.9],
    },
    true,
  ),
  builtIn(
    'toneCurve',
    'compress-dynamic-range',
    'Compress dynamic range',
    {
      channels: 'linked',
      preserveDetail: true,
      rgb: [0.6, 0.6, 0.5, 0.35, 0.15, 0, -0.2, -0.45, -0.7],
    },
    true,
  ),
];
