/**
 * A darktable or Ansel history as a recipe: the instances as they apply
 * (`activeEntries`), each through its module's translator (`modules.ts`), on top of
 * the recipe the photo starts with. What a translator decides comes from the history
 * alone; the rest of the starting recipe stays (our filmic, say, while theirs isn't
 * translated). Every module darktable applied is in the report.
 */
import {
  EDIT_PARAMS_VERSION,
  type EditParams,
  type ModuleInstance,
  type ModuleKind,
  normalizeEditParams,
} from '../params.ts';
import type { ImportContext, ImportReportItem } from '../importedEdits.ts';
import { BUILT_IN_OPERATIONS, TRANSLATORS, type Translator, darktableModuleName } from './modules.ts';
import { type DarktableXmp, activeEntries, decodeBlob } from './xmp.ts';

export async function importDarktable(
  xmp: DarktableXmp,
  { base, metadata }: ImportContext,
): Promise<{ recipe: EditParams; items: ImportReportItem[] }> {
  const ctx = { app: xmp.app, metadata };
  const translatorOf = new Map<string, Translator>();
  for (const t of TRANSLATORS) for (const op of t.operations) translatorOf.set(op, t);
  const decided = new Set<ModuleKind>();
  const imported: ModuleInstance[] = [];
  const items: ImportReportItem[] = [];
  for (const t of TRANSLATORS) for (const kind of t.kinds) decided.add(kind);

  for (const entry of activeEntries(xmp)) {
    const translator = translatorOf.get(entry.operation);
    const item = (status: ImportReportItem['status'], note?: string) =>
      entry.enabled &&
      items.push({
        module: darktableModuleName(entry.operation),
        instance: entry.multiName || null,
        status,
        note: note ?? null,
      });
    if (!translator) {
      item(BUILT_IN_OPERATIONS.has(entry.operation) ? 'builtIn' : 'skipped');
      continue;
    }
    const bytes = await decodeBlob(entry.params);
    if (!bytes) {
      item('skipped', 'Its settings are damaged');
      continue;
    }
    const result = translator.translate(entry, bytes, ctx);
    item(result.status, result.note);
    if (!result.instance) continue;
    // Their blending and masks aren't translated yet: such an instance would apply everywhere.
    imported.push({
      ...result.instance,
      enabled: entry.enabled,
      label: entry.multiName || result.instance.label,
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
