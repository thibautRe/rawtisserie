import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export interface RenderJob {
  jobId: number;
  sourcePath: string;
  params: EditParams | null;
  extractMetadata: boolean;
  outputs: { path: string; maxSize: number; quality: number }[];
}

export type RenderResult =
  | { jobId: number; ok: true; metadata: PhotoMetadata | null }
  | { jobId: number; ok: false; error: string };
