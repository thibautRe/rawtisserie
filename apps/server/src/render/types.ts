import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export interface RenderJob {
  jobId: number;
  sourcePath: string;
  params: EditParams | null;
  /** The version has no history: render the recipe a new image starts with (`defaultRecipe`). */
  autoDefaults: boolean;
  extractMetadata: boolean;
  /** Files of the LUTs the recipe may use (built-in, or the owner's), packed. */
  luts: string[];
  outputs: { path: string; maxSize: number; quality: number }[];
}

export type RenderResult =
  | {
      jobId: number;
      ok: true;
      metadata: PhotoMetadata | null;
      /** With `autoDefaults`, the recipe rendered when it isn't the plain default (lens correction). */
      defaultRecipe: EditParams | null;
      /** `params` with its pending auto-tunes resolved (what was rendered), if it had any. */
      resolvedRecipe: EditParams | null;
    }
  | { jobId: number; ok: false; error: string };
