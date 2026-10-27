import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export type WorkerRequest =
  | { type: 'load'; id: number; bytes: ArrayBuffer }
  | { type: 'render'; id: number; params: EditParams; maxWidth: number; maxHeight: number }
  | { type: 'export'; id: number; params: EditParams; maxSize: number; quality: number }
  | { type: 'autoTuneFilmic'; id: number; params: EditParams; maxWidth: number; maxHeight: number };

export type WorkerResponse =
  | { type: 'loaded'; id: number; metadata: PhotoMetadata; ms: number }
  | { type: 'rendered'; id: number; width: number; height: number; data: ArrayBuffer; ms: number }
  | { type: 'exported'; id: number; jpeg: ArrayBuffer; ms: number }
  | { type: 'autoTunedFilmic'; id: number; white: number | null; black: number | null; ms: number }
  | { type: 'error'; id: number; message: string };
