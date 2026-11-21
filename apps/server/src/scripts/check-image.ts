/**
 * Checks that what the server reads at runtime is there and works, the way it uses it:
 * the pipeline's WebAssembly, lensfun's database, the built-in LUTs, the denoise models,
 * the web app, the migrations, the API package and sharp. Run as the production image's last build step
 * (`Dockerfile`), so an image missing a file the code needs can't be built: files the
 * image copies are listed there by hand, and one added to the code but not to that list
 * otherwise only fails in production (lensfun's database did, 2026-11-19).
 *
 *   node apps/server/src/scripts/check-image.ts
 *
 * Needs no database, no storage and no settings. Exits non-zero on the first problem.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { COLOR_LABELS } from '@rawtisserie/api';
import { BUILTIN_LUTS, DENOISE_MODEL_BYTES, defaultRecipe } from '@rawtisserie/pipeline';
import { Developer, builtinLutUrl, initPipeline, lensfun, parseLut, readMetadata } from '@rawtisserie/pipeline/node';
import { config } from '../config.ts';

const ok = (what: string) => console.log(`ok  ${what}`);

// The pipeline, as the render worker uses it: an image decoded, its default recipe
// (with lensfun's database, as every new photo's), rendered, encoded by sharp.
initPipeline();
const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c86432' } })
  .jpeg()
  .toBuffer();
const metadata = JSON.parse(readMetadata(jpeg));
const lenses = lensfun();
const recipe = defaultRecipe(metadata, lenses);
const dev = new Developer(jpeg);
try {
  const img = dev.renderFinal(JSON.stringify(recipe), 32, 32);
  const { width, height } = img;
  const avif = await sharp(img.takeData(), { raw: { width, height, channels: 4 } })
    .avif({ effort: 0 })
    .toBuffer();
  img.free();
  if (!avif.length) throw new Error('sharp encoded nothing');
} finally {
  dev.free();
}
ok('pipeline (wasm): decode, default recipe, render, AVIF');

// lensfun's whole database, not just a file: the lens picker and matching read it all.
const sony = lenses.findCamera('Sony', 'ILCE-7RM3');
if (!sony || lenses.lenses(sony.camera).length < 50) throw new Error('lensfun’s database is missing or short');
ok(`lensfun (${lenses.lenses(null).length} lenses)`);

for (const lut of BUILTIN_LUTS) parseLut(readFileSync(builtinLutUrl(lut.id))).free();
ok(`built-in LUTs (${BUILTIN_LUTS.length})`);

for (const [id, bytes] of Object.entries(DENOISE_MODEL_BYTES)) {
  const file = path.join(config.denoiseModelsDir, `${id}.anselnn`);
  if (!existsSync(file) || statSync(file).size !== bytes)
    throw new Error(`denoise model ${id}: missing or not ${bytes} bytes`);
}
ok(`denoise models (${Object.keys(DENOISE_MODEL_BYTES).length})`);

if (!existsSync(path.join(config.webDistDir, 'index.html'))) throw new Error(`no web app in ${config.webDistDir}`);
ok('web app');

const migrations = new URL('../../migrations/', import.meta.url);
if (!readdirSync(migrations).some((f) => f.endsWith('.sql'))) throw new Error('no migrations');
ok('migrations');

// Its values are imported by the routes (`COLOR_LABELS` validates labels).
if (!COLOR_LABELS.length) throw new Error('no colour labels in @rawtisserie/api');
ok('api package');
