/** Load the pipeline WebAssembly module in Node (server-side thumbnails). */
import { readFileSync } from 'node:fs';
import { initSync } from '../wasm/pipeline.js';
import { Lensfun } from './lensfun.ts';

export {
  Developer,
  readMetadata,
  defaultParams,
  defaultRecipe as defaultRecipeWasm,
  normalizeParams,
  frameLayout,
  normalizeExport,
  parseLut,
  denoiseKeyName as denoiseKeyNameWasm,
} from '../wasm/pipeline.js';

/** Where a built-in LUT's packed file is (`BUILTIN_LUTS`). */
export const builtinLutUrl = (id: string): URL => new URL(`../luts/${id}.clut`, import.meta.url);

/** lensfun's database (`lensfun/lensfun.json`), read on first use. */
let lensfunDb: Lensfun | null = null;
export function lensfun(): Lensfun {
  lensfunDb ??= new Lensfun(JSON.parse(readFileSync(new URL('../lensfun/lensfun.json', import.meta.url), 'utf8')));
  return lensfunDb;
}

let initialized = false;

export function initPipeline(): void {
  if (initialized) return;
  const wasm = readFileSync(new URL('../wasm/pipeline_bg.wasm', import.meta.url));
  initSync({ module: wasm });
  initialized = true;
}
