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
import { blending, formsAt } from './masks.ts';
import type { Shape } from '../shapes.ts';

export async function importDarktable(
  xmp: DarktableXmp,
  { base, metadata, luts = [] }: ImportContext,
): Promise<{ recipe: EditParams; items: ImportReportItem[] }> {
  const active = activeEntries(xmp);
  // Every entry's parameters first: a translator may read others' (white balance, for
  // colour calibration).
  const bytes = new Map<DarktableEntry, Uint8Array | null>();
  for (const e of active) bytes.set(e, await decodeBlob(e.params));
  const ctx: TranslateContext = { app: xmp.app, metadata, luts, base, active, paramsOf: (e) => bytes.get(e) ?? null };
  const translatorOf = new Map<string, Translator>();
  for (const t of TRANSLATORS) for (const op of t.operations) translatorOf.set(op, t);
  const decided = new Set<ModuleKind>();
  const imported: ModuleInstance[] = [];
  const items: ImportReportItem[] = [];
  for (const t of TRANSLATORS) for (const kind of t.kinds) decided.add(kind);

  // Drawn forms as they stood at the history's end (they're shared by every module).
  const forms = formsAt(xmp.masks, xmp.historyEnd - 1);
  const shapes: Record<string, Shape> = {};
  const { width, height, orientation } = metadata;
  const swap = (orientation ?? 1) >= 5 && (orientation ?? 1) <= 8;
  const aspect = width && height ? (swap ? height / width : width / height) : 1.5;

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
    const blend = result.instance
      ? await blending(
          await decodeBlob(entry.blendopParams ?? ''),
          forms,
          MASKABLE_KINDS.includes(result.instance.kind),
          aspect,
        )
      : null;
    if (blend?.shapes) Object.assign(shapes, blend.shapes);
    const notes = [result.note, ...(blend?.notes ?? [])].filter(Boolean).join('. ');
    item(
      blend?.notes.length && result.status === 'mapped' ? 'approximated' : result.status,
      notes || undefined,
      result.file,
    );
    // What comes with an instance is on when it is (a masked one comes switched off)…
    const on = entry.enabled && !blend?.off;
    // …and, when it's masked, where it is (a tone curve standing for its contrast).
    imported.push(
      ...(result.extra ?? []).map(
        (x) =>
          ({
            ...x,
            enabled: x.enabled && on,
            // Where it applies, blended normally: theirs blends once, after the whole module.
            ...(blend?.mask &&
              MASKABLE_KINDS.includes(x.kind) && {
                mask: { ...blend.mask, blend: 'normal' as const, blendFulcrum: 0 },
              }),
          }) as ModuleInstance,
      ),
    );
    if (!result.instance) continue;
    imported.push({
      ...result.instance,
      enabled: on,
      label: entry.multiName || result.instance.label,
      ...(blend?.mask && { mask: blend.mask }),
    } as ModuleInstance);
  }

  const kept = base.modules.filter((m) => !decided.has(m.kind));
  const recipe = normalizeEditParams({
    version: EDIT_PARAMS_VERSION,
    modules: [...kept, ...imported],
    shapes: { ...base.shapes, ...shapes },
  });
  return { recipe, items };
}
