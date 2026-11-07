import {
  type EditParams,
  type ModuleInstance,
  type ModuleKind,
  defaultModuleParams,
  shapeRefs,
} from '@rawtisserie/pipeline';

export const MODULE_TITLES: Record<ModuleKind, string> = {
  retouch: 'Retouch',
  lens: 'Lens correction',
  geometry: 'Geometry',
  blur: 'Blur',
  sharpen: 'Sharpen',
  contrastEqualizer: 'Contrast equalizer',
  exposure: 'Exposure',
  colorCalibration: 'Color calibration',
  color: 'Color',
  shadowsHighlights: 'Shadows & highlights',
  colorPrimaries: 'Color primaries',
  toneCurve: 'Tone curve',
  filmic: 'Filmic',
  lut: 'LUT',
};

export interface Change {
  /** A history label, e.g. "Exposure: ev 0.7". */
  label: string;
  /** The id of the only module instance that changed, or null if several did. */
  moduleId: string | null;
  /** Adds, removes, renames or moves an instance: always its own history entry. */
  structural: boolean;
}

/** An instance's name: "Exposure", "Exposure (sky)", or "Exposure 2" among several unnamed ones. */
export function instanceTitle(recipe: EditParams, m: Pick<ModuleInstance, 'id' | 'kind' | 'label'>): string {
  if (m.label) return `${MODULE_TITLES[m.kind]} (${m.label})`;
  const siblings = recipe.modules.filter((x) => x.kind === m.kind);
  return siblings.length > 1
    ? `${MODULE_TITLES[m.kind]} ${siblings.findIndex((x) => x.id === m.id) + 1}`
    : MODULE_TITLES[m.kind];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** "whiteExposure" → "white exposure". */
const words = (key: string) => key.replace(/([A-Z])/g, ' $1').toLowerCase();

/** How a parameter is named in history labels: its words, or the tone curve's curves. */
const paramName = (kind: ModuleKind, key: string) =>
  kind === 'toneCurve' && ['rgb', 'red', 'green', 'blue'].includes(key)
    ? key === 'rgb'
      ? 'curve'
      : `${key} curve`
    : words(key);

function formatValue(v: unknown): string | null {
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v;
  return null;
}

function describeInstance(
  recipes: { before: EditParams; after: EditParams },
  before: ModuleInstance | undefined,
  after: ModuleInstance | undefined,
): Change {
  const m = (after ?? before)!;
  const hasKind = (r: EditParams) => r.modules.some((x) => x.kind === m.kind);
  const title = instanceTitle(after ? recipes.after : recipes.before, m);
  const structural = (word: string): Change => ({ label: `${title}: ${word}`, moduleId: m.id, structural: true });
  if (!after)
    return hasKind(recipes.after)
      ? structural('removed')
      : { label: `${title}: reset`, moduleId: m.id, structural: false };
  if (!before && hasKind(recipes.before)) return structural('added');
  if (before && before.label !== after.label) return structural('renamed');
  const parts: string[] = [];
  if ((before?.enabled ?? false) !== after.enabled) parts.push(after.enabled ? 'on' : 'off');
  const old = (before?.params ?? defaultModuleParams[after.kind]) as Record<string, unknown>;
  const keys = Object.entries(after.params as Record<string, unknown>).filter(([k, v]) => !same(old[k], v));
  if (keys.length === 1) {
    const [k, v] = keys[0]!;
    const value = formatValue(v);
    parts.push(value === null ? paramName(m.kind, k) : `${paramName(m.kind, k)} ${value}`);
  } else if (keys.length > 1) {
    parts.push(keys.map(([k]) => paramName(m.kind, k)).join(', '));
  }
  if (!same(before?.mask, after.mask)) {
    if (!before?.mask) parts.push('mask added');
    else if (!after.mask) parts.push('mask removed');
    else {
      const old = before.mask as unknown as Record<string, unknown>;
      const changed = Object.entries(after.mask).filter(([k, v]) => !same(old[k], v));
      const [k, v] = changed[0] ?? [];
      const value = changed.length === 1 && k !== 'drawn' ? formatValue(v) : null;
      parts.push(
        changed.length === 1
          ? `mask ${k === 'drawn' ? 'shapes' : words(k!)}${value === null ? '' : ` ${value}`}`
          : 'mask',
      );
    }
  }
  return { label: parts.length ? `${title}: ${parts.join(', ')}` : title, moduleId: m.id, structural: false };
}

/** Describe the change between two recipes, for the history stack. */
export function describeChange(before: EditParams, after: EditParams): Change {
  const prev = new Map(before.modules.map((m) => [m.id, m]));
  const next = new Map(after.modules.map((m) => [m.id, m]));
  const ids = [...new Set([...prev.keys(), ...next.keys()])].filter((id) => !same(prev.get(id), next.get(id)));
  if (ids.length === 0 && !same(before.shapes, after.shapes)) {
    // Only shapes changed: they belong to the instance whose spots or mask use them.
    const changed = Object.keys({ ...before.shapes, ...after.shapes }).filter(
      (id) => !same(before.shapes?.[id], after.shapes?.[id]),
    );
    const owner = after.modules.find((m) => shapeRefs([m]).some((id) => changed.includes(id)));
    const title = owner ? instanceTitle(after, owner) : MODULE_TITLES.retouch;
    const what = owner && owner.kind !== 'retouch' ? 'mask shape' : 'spot';
    return { label: `${title}: ${what} edited`, moduleId: owner?.id ?? null, structural: false };
  }
  if (ids.length === 0) {
    // Same instances: at most their order changed.
    const moved = after.modules.find((m, i) => before.modules[i]?.id !== m.id);
    if (moved) return { label: `${MODULE_TITLES[moved.kind]}: reordered`, moduleId: moved.id, structural: true };
    return { label: 'Edit', moduleId: null, structural: false };
  }
  if (ids.length === 1) return describeInstance({ before, after }, prev.get(ids[0]!), next.get(ids[0]!));
  const titles = [...new Set(ids.map((id) => MODULE_TITLES[(next.get(id) ?? prev.get(id))!.kind]))];
  return { label: titles.join(', '), moduleId: null, structural: false };
}
