/** Load the pipeline WebAssembly module in Node (server-side thumbnails). */
import { readFileSync } from 'node:fs';
import { initSync } from '../wasm/pipeline.js';

export { Developer, readMetadata, defaultParams, defaultRecipe as defaultRecipeWasm, normalizeParams } from '../wasm/pipeline.js';

let initialized = false;

export function initPipeline(): void {
  if (initialized) return;
  const wasm = readFileSync(new URL('../wasm/pipeline_bg.wasm', import.meta.url));
  initSync({ module: wasm });
  initialized = true;
}
