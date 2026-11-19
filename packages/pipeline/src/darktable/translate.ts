/**
 * What a translator is (`modules.ts` lists them): it turns a darktable module's
 * parameters into our module instances, with how well that went.
 */
import type { EditParams, ModuleInstance, ModuleKind, ModuleParams } from '../params.ts';
import type { ImportMetadata, ImportStatus } from '../importedEdits.ts';
import type { DarktableApp, DarktableEntry } from './xmp.ts';

/** What a translator is given for the photo. */
export interface TranslateContext {
  app: DarktableApp;
  metadata: ImportMetadata;
  /** The user's LUTs (`resolveLutRefs`). */
  luts: readonly { id: string; name: string }[];
  /** The recipe the photo starts with: what our own defaults chose for it (its lens correction). */
  base: EditParams;
  /** The history as it applies (`activeEntries`), and each entry's parameters (null if damaged). */
  active: readonly DarktableEntry[];
  paramsOf: (entry: DarktableEntry) => Uint8Array | null;
}

/** One entry's import: its instance (null: nothing of ours), and how well it went. */
export interface Translation {
  instance: ModuleInstance | null;
  status: Exclude<ImportStatus, 'builtIn'>;
  note?: string;
  file?: { name: string; path: string };
  /** More instances it needs (an exposure that a fitted tone curve shifts by). */
  extra?: ModuleInstance[];
}

/**
 * Turns a darktable module (or several, of one job) into ours. It decides `kinds`: what
 * the photo's starting recipe has of those is replaced by what it gives, nothing when
 * the history doesn't have its modules (darktable didn't apply them).
 */
export interface Translator {
  operations: readonly string[];
  kinds: readonly ModuleKind[];
  translate(entry: DarktableEntry, params: Uint8Array, ctx: TranslateContext): Translation;
}

export const instance = <K extends ModuleKind>(kind: K, params: ModuleParams[K]): ModuleInstance<K> =>
  ({ id: '', label: null, enabled: true, kind, params }) as ModuleInstance<K>;

export const unreadable = (entry: DarktableEntry): Translation => ({
  instance: null,
  status: 'skipped',
  note: `Version ${entry.modversion} of its settings isn't supported`,
});
