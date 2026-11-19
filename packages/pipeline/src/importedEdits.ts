/**
 * Edits made in another application, imported with the photo (roadmap: darktable and
 * Ansel now; Lightroom and Capture One later). They come as text (an XMP sidecar),
 * kept with the version (`versions.imported_edits`), and become the recipe of a history
 * entry labelled `importLabel(app)`, after the starting one: best effort, never the same
 * pixels, so the developer warns while that entry is the current one, with the report
 * (`importEdits` again, the same function of the text and the photo).
 *
 * Whoever records a new version's first history entries calls `startingHistory`: the
 * render worker, and the developer when it's opened first.
 */
import { type DarktableApp, hasDarktableHistory, parseDarktableXmp } from './darktable/xmp.ts';
import { importDarktable } from './darktable/import.ts';
import type { PhotoMetadata } from './metadata.ts';
import { type EditParams, forPhoto } from './params.ts';

export type ImportApp = DarktableApp;

export const IMPORT_APP_NAMES: Readonly<Record<ImportApp, string>> = { darktable: 'darktable', ansel: 'Ansel' };

/**
 * The longest edits kept with a version (characters). darktable sidecars are tens of KB
 * (65 KB at most in a corpus of a hundred, with drawn masks); sent within the upload's JSON.
 */
export const MAX_IMPORTED_EDITS_LENGTH = 1024 * 1024;

const LABEL_PREFIX = 'Imported from ';

/** The label of the history entry an import makes. */
export const importLabel = (app: ImportApp) => `${LABEL_PREFIX}${IMPORT_APP_NAMES[app]}`;

/** Whether a history entry is an import (`importLabel`). */
export const isImportLabel = (label: string) =>
  Object.values(IMPORT_APP_NAMES).some((name) => label === `${LABEL_PREFIX}${name}`);

/**
 * How a module of the other application came through:
 * - `mapped`: our module does the same, with its settings;
 * - `approximated`: something like it, or with some settings left out (`note` says which);
 * - `needsFile`: ours, waiting for a file the user hasn't added (a LUT, `file`);
 * - `skipped`: nothing of ours does it, or its settings couldn't be read;
 * - `builtIn`: our pipeline does that step its own way (demosaicing, colour profiles…).
 */
export type ImportStatus = 'mapped' | 'approximated' | 'needsFile' | 'skipped' | 'builtIn';

export interface ImportReportItem {
  /** The module's name in the other application. */
  module: string;
  /** The instance's name there, for a module used more than once. */
  instance: string | null;
  status: ImportStatus;
  note: string | null;
  /** With `needsFile`: the file to add, and where the other application found it. */
  file?: { name: string; path: string };
}

export interface ImportReport {
  app: ImportApp;
  /** The modules the other application applied (enabled ones), in its pipeline order. */
  items: ImportReportItem[];
}

/** What translators may read of the photo. */
export type ImportMetadata = Partial<
  Pick<PhotoMetadata, 'make' | 'model' | 'lensModel' | 'focalLength' | 'fNumber' | 'exposureBias' | 'imageFormat'>
>;

export interface ImportContext {
  /** The recipe the photo starts with (`defaultRecipe`): what nothing imported replaces stays. */
  base: EditParams;
  metadata: ImportMetadata;
  /** The user's LUTs, for those the edits refer to by name (`resolveLutRefs`). */
  luts?: readonly { id: string; name: string }[];
}

export interface ImportedEdits {
  label: string;
  recipe: EditParams;
  report: ImportReport;
}

/** The application whose edits `text` (a sidecar's) holds, if we import them. */
export function detectImportedEdits(text: string): ImportApp | null {
  return hasDarktableHistory(text) ? (parseDarktableXmp(text)?.app ?? null) : null;
}

/** The recipe and report of the edits in `text`, or null if it has none we import. */
export async function importEdits(text: string, ctx: ImportContext): Promise<ImportedEdits | null> {
  if (!hasDarktableHistory(text)) return null;
  const xmp = parseDarktableXmp(text);
  if (!xmp) return null;
  const { recipe, items } = await importDarktable(xmp, ctx);
  return {
    label: importLabel(xmp.app),
    recipe: forPhoto(recipe, ctx.metadata),
    report: { app: xmp.app, items },
  };
}

/**
 * The history a new version starts with: the starting recipe (`base`, labelled
 * `baseLabel`), then the import of `importedEdits`, if any and readable. An import that
 * fails leaves the starting recipe alone.
 */
export async function startingHistory(
  base: EditParams,
  baseLabel: string,
  importedEdits: string | null | undefined,
  metadata: ImportMetadata,
  luts: ImportContext['luts'] = [],
): Promise<{ label: string; recipe: EditParams }[]> {
  const entries = [{ label: baseLabel, recipe: base }];
  if (!importedEdits) return entries;
  const imported = await importEdits(importedEdits, { base, metadata, luts }).catch(() => null);
  if (imported) entries.push({ label: imported.label, recipe: imported.recipe });
  return entries;
}
