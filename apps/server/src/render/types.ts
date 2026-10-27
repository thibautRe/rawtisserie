import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export interface RenderJob {
  jobId: number;
  sourcePath: string;
  params: EditParams | null;
  /** The version has no history: render the recipe a new image starts with (`defaultRecipe`). */
  autoDefaults: boolean;
  extractMetadata: boolean;
  outputs: { path: string; maxSize: number; quality: number }[];
}

export type RenderResult =
  | {
      jobId: number;
      ok: true;
      metadata: PhotoMetadata | null;
      /** With `autoDefaults`, the recipe rendered when it isn't the plain default (lens correction). */
      defaultRecipe: EditParams | null;
    }
  | { jobId: number; ok: false; error: string };
