import { type EditParams, type ModuleInstance, type ModuleKind, defaultModuleParams } from '@rawtisserie/pipeline';

export const MODULE_TITLES: Record<ModuleKind, string> = {
  lens: 'Lens correction',
  geometry: 'Geometry',
  blur: 'Blur',
  sharpen: 'Sharpen',
  contrastEqualizer: 'Contrast equalizer',
  exposure: 'Exposure',
  whiteBalance: 'White balance',
  color: 'Color',
  shadowsHighlights: 'Shadows & highlights',
  colorPrimaries: 'Color primaries',
  filmic: 'Filmic',
};

export interface Change {
  /** A history label, e.g. "Exposure: ev 0.7". */
  label: string;
  /** The id of the only module instance that changed, or null if several did. */
  moduleId: string | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** "whiteExposure" → "white exposure". */
const words = (key: string) => key.replace(/([A-Z])/g, ' $1').toLowerCase();

function formatValue(v: unknown): string | null {
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v;
  return null;
}

function describeInstance(before: ModuleInstance | undefined, after: ModuleInstance | undefined): string {
  const m = (after ?? before)!;
  const title = MODULE_TITLES[m.kind] + (m.label ? ` (${m.label})` : '');
  if (!after) return `${title}: reset`;
  const parts: string[] = [];
  if ((before?.enabled ?? false) !== after.enabled) parts.push(after.enabled ? 'on' : 'off');
  const old = (before?.params ?? defaultModuleParams[after.kind]) as Record<string, unknown>;
  const keys = Object.entries(after.params as Record<string, unknown>).filter(([k, v]) => !same(old[k], v));
  if (keys.length === 1) {
    const [k, v] = keys[0]!;
    const value = formatValue(v);
    parts.push(value === null ? words(k) : `${words(k)} ${value}`);
  } else if (keys.length > 1) {
    parts.push(keys.map(([k]) => words(k)).join(', '));
  }
  return parts.length ? `${title}: ${parts.join(', ')}` : title;
}

/** Describe the change between two recipes, for the history stack. */
export function describeChange(before: EditParams, after: EditParams): Change {
  const prev = new Map(before.modules.map((m) => [m.id, m]));
  const next = new Map(after.modules.map((m) => [m.id, m]));
  const ids = [...new Set([...prev.keys(), ...next.keys()])].filter((id) => !same(prev.get(id), next.get(id)));
  if (ids.length === 0) return { label: 'Edit', moduleId: null };
  if (ids.length === 1) return { label: describeInstance(prev.get(ids[0]!), next.get(ids[0]!)), moduleId: ids[0]! };
  const titles = [...new Set(ids.map((id) => MODULE_TITLES[(next.get(id) ?? prev.get(id))!.kind]))];
  return { label: titles.join(', '), moduleId: null };
}
