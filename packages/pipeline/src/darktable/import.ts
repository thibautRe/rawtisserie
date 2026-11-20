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
  freshId,
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

  const ctx: TranslateContext = {
    app: xmp.app,
    metadata,
    luts,
    base,
    active,
    forms,
    aspect,
    paramsOf: (e) => bytes.get(e) ?? null,
  };

  // Ids are given here, for raster masks to name their source: their instance (operation
  // and multi_priority) → ours, or null where it's off there.
  const kept = base.modules.filter((m) => !decided.has(m.kind));
  const taken = new Set(kept.map((m) => m.id));
  const ours = new Map<string, string | null>();
  // Instances masked by a raster mask, to check their source stays before them.
  const rasters: { id: string; source: string; report: ImportReportItem }[] = [];
  const theirs = (operation: string, multiPriority: number) => `${operation}\u0000${multiPriority}`;
  const rasterSource = (operation: string, multiPriority: number) => ours.get(theirs(operation, multiPriority));

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
    const result = await translator.translate(entry, params, ctx);
    const blend = result.instance
      ? await blending(
          await decodeBlob(entry.blendopParams ?? ''),
          forms,
          MASKABLE_KINDS.includes(result.instance.kind),
          aspect,
          rasterSource,
        )
      : null;
    if (blend?.shapes) Object.assign(shapes, blend.shapes);
    if (result.shapes) Object.assign(shapes, result.shapes);
    const notes = [result.note, ...(blend?.notes ?? [])].filter(Boolean).join('. ');
    const reported = items.length;
    item(
      blend?.notes.length && result.status === 'mapped' ? 'approximated' : result.status,
      notes || undefined,
      result.file,
    );
    const report = items.length > reported ? items.at(-1) : undefined;
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
    const id = freshId(result.instance.kind, (x) => taken.has(x));
    taken.add(id);
    ours.set(theirs(entry.operation, entry.multiPriority), entry.enabled ? id : null);
    const raster = Object.values(blend?.shapes ?? {}).find((x) => x.type === 'raster');
    if (raster && report) rasters.push({ id, source: raster.source, report });
    imported.push({
      ...result.instance,
      id,
      enabled: on,
      label: entry.multiName || result.instance.label,
      ...(blend?.mask && { mask: blend.mask }),
    } as ModuleInstance);
  }

  const recipe = normalizeEditParams({
    version: EDIT_PARAMS_VERSION,
    modules: [...kept, ...imported],
    shapes: { ...base.shapes, ...shapes },
  });
  // Our pipeline's order isn't theirs: a raster mask reads modules before it only.
  const at = (id: string) => recipe.modules.findIndex((m) => m.id === id);
  for (const r of rasters) {
    if (at(r.source) >= 0 && at(r.source) < at(r.id)) continue;
    const late = 'Its raster mask comes from a module after it here: it applies nowhere';
    r.report.note = r.report.note ? `${r.report.note}. ${late}` : late;
    r.report.status = r.report.status === 'mapped' ? 'approximated' : r.report.status;
  }
  return { recipe, items };
}
