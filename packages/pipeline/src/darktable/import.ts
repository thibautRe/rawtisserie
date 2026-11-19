/**
 * A darktable or Ansel history as a recipe: the instances as they apply
 * (`activeEntries`), each through its module's translator (`modules.ts`), on top of
 * the recipe the photo starts with. What a translator decides comes from the history
 * alone; the rest of the starting recipe stays (our filmic, say, while theirs isn't
 * translated). Every module darktable applied is in the report.
 */
import {
  EDIT_PARAMS_VERSION,
  MASKABLE_KINDS,
  type Mask,
  defaultMask,
  type EditParams,
  type ModuleInstance,
  type ModuleKind,
  normalizeEditParams,
} from '../params.ts';
import type { ImportContext, ImportReportItem } from '../importedEdits.ts';
import {
  BUILT_IN_OPERATIONS,
  TRANSLATORS,
  type TranslateContext,
  type Translator,
  darktableModuleName,
} from './modules.ts';
import { type DarktableEntry, type DarktableXmp, activeEntries, decodeBlob } from './xmp.ts';

/** `dt_develop_blend_params_t`'s mask modes: drawn, parametric, raster (any of them: a mask). */
const MASKED = (1 << 1) | (1 << 2) | (1 << 3);
/** `DEVELOP_BLEND_NORMAL2`, `DEVELOP_BLEND_BOUNDED`. */
const NORMAL_BLENDS = [0x18, 0x19];

/**
 * How an instance blends, from its blending parameters (`blend.h`; the first fields are
 * the same in every version since darktable 3: mask mode, colour space, blend mode,
 * its parameter, opacity). A uniform opacity becomes the mask's; a mask isn't
 * translated yet, so the instance comes switched off rather than applied everywhere.
 */
function blending(
  instance: ModuleInstance,
  bytes: Uint8Array | null,
): { mask?: Mask; off?: boolean; note?: string } | null {
  if (!bytes || bytes.length < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mode = view.getUint32(0, true);
  // Without `DEVELOP_MASK_ENABLED`, the other bits mean nothing (Ansel sets them all).
  if (!(mode & 1)) return null;
  const maskable = MASKABLE_KINDS.includes(instance.kind);
  if (mode & MASKED) return { off: true, note: 'Masked there: imported switched off (its mask isn’t imported)' };
  const opacity = clamp(view.getFloat32(16, true) / 100, 0, 1);
  const notes: string[] = [];
  if (!NORMAL_BLENDS.includes(view.getUint32(8, true) & 0xff)) notes.push('Blend mode not imported');
  if (opacity < 1 && !maskable) notes.push('Opacity not imported');
  return {
    ...(opacity < 1 && maskable && { mask: { ...defaultMask, opacity } }),
    ...(notes.length && { note: notes.join('. ') }),
  };
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export async function importDarktable(
  xmp: DarktableXmp,
  { base, metadata, luts = [] }: ImportContext,
): Promise<{ recipe: EditParams; items: ImportReportItem[] }> {
  const active = activeEntries(xmp);
  // Every entry's parameters first: a translator may read others' (white balance, for
  // colour calibration).
  const bytes = new Map<DarktableEntry, Uint8Array | null>();
  for (const e of active) bytes.set(e, await decodeBlob(e.params));
  const ctx: TranslateContext = { app: xmp.app, metadata, luts, active, paramsOf: (e) => bytes.get(e) ?? null };
  const translatorOf = new Map<string, Translator>();
  for (const t of TRANSLATORS) for (const op of t.operations) translatorOf.set(op, t);
  const decided = new Set<ModuleKind>();
  const imported: ModuleInstance[] = [];
  const items: ImportReportItem[] = [];
  for (const t of TRANSLATORS) for (const kind of t.kinds) decided.add(kind);

  for (const entry of active) {
    const translator = translatorOf.get(entry.operation);
    const item = (status: ImportReportItem['status'], note?: string, file?: ImportReportItem['file']) =>
      entry.enabled &&
      items.push({
        module: darktableModuleName(entry.operation),
        instance: entry.multiName || null,
        status,
        note: note ?? null,
        ...(file && { file }),
      });
    if (!translator) {
      item(BUILT_IN_OPERATIONS.has(entry.operation) ? 'builtIn' : 'skipped');
      continue;
    }
    const params = bytes.get(entry);
    if (!params) {
      item('skipped', 'Its settings are damaged');
      continue;
    }
    const result = translator.translate(entry, params, ctx);
    const blend = result.instance ? blending(result.instance, await decodeBlob(entry.blendopParams ?? '')) : null;
    const notes = [result.note, blend?.note].filter(Boolean).join('. ');
    item(blend?.note && result.status === 'mapped' ? 'approximated' : result.status, notes || undefined, result.file);
    imported.push(...(result.extra ?? []));
    if (!result.instance) continue;
    imported.push({
      ...result.instance,
      enabled: entry.enabled && !blend?.off,
      label: entry.multiName || result.instance.label,
      ...(blend?.mask && { mask: blend.mask }),
    } as ModuleInstance);
  }

  const kept = base.modules.filter((m) => !decided.has(m.kind));
  const recipe = normalizeEditParams({
    version: EDIT_PARAMS_VERSION,
    modules: [...kept, ...imported],
    ...(base.shapes && { shapes: base.shapes }),
  });
  return { recipe, items };
}
