import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export interface RenderJob {
  jobId: number;
  /** The original's key in the object store. */
  sourceKey: string;
  params: EditParams | null;
  /** The version has no history: render the recipe a new image starts with (`defaultRecipe`). */
  autoDefaults: boolean;
  /** With `autoDefaults`: edits from another application, imported on top of the default recipe. */
  importedEdits: string | null;
  extractMetadata: boolean;
  /** Ids of the LUTs the recipe may use (built-in, or the owner's). */
  luts: string[];
  /** Renders to store as AVIF (`quality` on sharp's 1–100 scale), by object key. */
  outputs: { key: string; maxSize: number; quality: number }[];
}

export type RenderResult =
  | {
      jobId: number;
      ok: true;
      metadata: PhotoMetadata | null;
      /** With `autoDefaults`, the recipe rendered: `defaultRecipe`, its auto-tunes run. */
      defaultRecipe: EditParams | null;
      /** With `importedEdits`, their import on top of `defaultRecipe` (what was rendered then). */
      imported: { label: string; recipe: EditParams } | null;
      /** `params` with its pending auto-tunes resolved (what was rendered), if it had any. */
      resolvedRecipe: EditParams | null;
    }
  | { jobId: number; ok: false; error: string };
