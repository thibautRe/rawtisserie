import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MODULE_KINDS,
  defaultEditParams,
  defaultRecipe,
  defaultModuleParams,
  findModule,
  isDefaultEdit,
  isModuleModified,
  normalizeEditParams,
  resetModule,
  updateModule,
} from './params.ts';
import { initPipeline, defaultParams, defaultRecipeWasm, normalizeParams } from './node.ts';

test('TypeScript defaults match the Rust defaults', () => {
  initPipeline();
  assert.deepEqual(JSON.parse(defaultParams()), defaultEditParams);
});

test('defaultRecipe matches Rust', () => {
  initPipeline();
  for (const metadata of [{}, { lensCorrection: null }, { lensCorrection: 'sony' }]) {
    assert.deepEqual(defaultRecipe(metadata), JSON.parse(defaultRecipeWasm(JSON.stringify(metadata))), JSON.stringify(metadata));
  }
  assert.equal(defaultRecipe({ lensCorrection: null }), defaultEditParams);
});

/** Recipes on which TypeScript and Rust must agree. */
const samples: unknown[] = [
  {},
  { version: 1, exposure: { ev: 1 }, toneMap: { contrast: 2 } },
  { version: 2, exposure: { ev: 1.5 }, geometry: { rotation: 1 }, filmic: { enabled: false, bleach: 'extra' }, sharpen: { amount: 0, radius: 2 } },
  {
    version: 2,
    whiteBalance: { warmth: 0.3 },
    color: { vibrance: 0.2 },
    shadowsHighlights: { highlights: -0.4 },
    blur: { radius: 1 },
    geometry: { crop: { x: 0.1 } },
  },
  { version: 3, modules: [] },
  { version: 2, filmic: { latitude: 30, balance: -10 } },
  { version: 3, modules: [{ kind: 'filmic', params: { latitude: 17.3, balance: 12.5, contrast: 1.4 } }] },
  { version: 4, modules: [{ kind: 'filmic', params: { toe: 50, shoulder: 75 } }] },
  { version: 4, modules: [{ kind: 'filmic', params: { toe: 82.7 } }] },
  { version: 5, modules: [{ kind: 'filmic', params: { toe: 50, shoulder: 75 } }] },
  {
    version: 3,
    modules: [
      { kind: 'filmic', params: { contrast: 2 } },
      { id: 'a', kind: 'exposure', label: 'sky', params: { ev: -1 } },
      { id: 'a', kind: 'exposure', enabled: false },
      { kind: 'exposure' },
      { id: 'exposure-2', kind: 'color' },
      { kind: 'filmic', params: { contrast: 3 } },
      { kind: 'geometry', params: { crop: { width: 0.5 } } },
    ],
  },
  { version: 5, modules: [{ kind: 'filmic' }, { kind: 'lens', params: { tca: 0 } }, { kind: 'lens', params: { tca: 2 } }] },
  // Every kind with its defaults.
  { version: 5, modules: MODULE_KINDS.map((kind) => ({ kind })) },
  {
    version: 5,
    modules: [
      { kind: 'colorPrimaries', params: { red: { hue: 12.5 }, blue: { saturation: -20, brightness: 0.05 }, whiteLevel: 2 } },
      { kind: 'contrastEqualizer', params: { luma: [0.5, 0.6, 0.7, 0.6, 0.5, 0.5], lumaDenoise: [0, 0, 0, 0, 0.2, 0.4], mix: 0.5 } },
      { kind: 'contrastEqualizer', label: 'fine', params: { edges: [1, 1, 1, 0.5, 0.5, 0.5] } },
    ],
  },
];

test('normalizeEditParams matches Rust', () => {
  initPipeline();
  for (const sample of samples) {
    assert.deepEqual(normalizeEditParams(sample), JSON.parse(normalizeParams(JSON.stringify(sample))), JSON.stringify(sample));
  }
});

test('normalizeEditParams fills gaps and ignores junk', () => {
  const p = normalizeEditParams({
    version: 3,
    modules: [{ kind: 'exposure', params: { ev: 2 } }, { kind: 'color', params: 'nope' }, { kind: 'teleport' }, 'junk', { kind: 'filmic', params: { bleach: 'neon' } }],
  });
  assert.deepEqual(
    p.modules.map((m) => m.kind),
    ['exposure', 'color', 'filmic'],
  );
  assert.deepEqual(findModule(p, 'exposure')!.params, { ev: 2, black: 0 });
  assert.deepEqual(findModule(p, 'color')!.params, defaultModuleParams.color);
  assert.equal(findModule(p, 'filmic')!.params.bleach, 'medium');
});

test('curves must be whole', () => {
  const p = normalizeEditParams({
    version: 5,
    modules: [{ kind: 'contrastEqualizer', params: { luma: [0.7, 0.7], chroma: [1, 1, 1, 1, 1, 'x'], edges: [1, 1, 1, 1, 1, 1] } }],
  });
  const eq = findModule(p, 'contrastEqualizer')!.params;
  assert.deepEqual(eq.luma, defaultModuleParams.contrastEqualizer.luma);
  assert.deepEqual(eq.chroma, defaultModuleParams.contrastEqualizer.chroma);
  assert.deepEqual(eq.edges, [1, 1, 1, 1, 1, 1]);
  assert.notEqual(eq.lumaDenoise, defaultModuleParams.contrastEqualizer.lumaDenoise, 'defaults are copied');
});

test('v2 recipes become one instance per section', () => {
  const p = normalizeEditParams({ version: 2, exposure: { ev: 2 }, filmic: { enabled: false, contrast: 1.5 }, geometry: { crop: { x: 0.5 } } });
  assert.equal(p.version, 5);
  assert.deepEqual(
    p.modules.map((m) => [m.id, m.enabled]),
    [
      ['geometry', true],
      ['exposure', true],
      ['filmic', false],
    ],
  );
  assert.deepEqual(findModule(p, 'geometry')!.params.crop, { x: 0.5, y: 0, width: 1, height: 1 });
  assert.equal(findModule(p, 'filmic')!.params.contrast, 1.5);
});

test('updateModule adds missing instances in pipeline order', () => {
  let p = updateModule(defaultEditParams, 'sharpen', { params: { amount: 0.5 } });
  p = updateModule(p, 'color', { params: { saturation: 0.2 } });
  p = updateModule(p, 'exposure', { params: { ev: 1 } });
  assert.deepEqual(
    p.modules.map((m) => m.kind),
    ['sharpen', 'exposure', 'color', 'filmic'],
  );
  assert.deepEqual(findModule(p, 'sharpen')!.params, { amount: 0.5, radius: 1 });
  assert.equal(findModule(p, 'exposure')!.params.ev, 1);
  assert.equal(findModule(defaultEditParams, 'exposure')!.params.ev, 0.7, 'the input is not modified');
  assert.deepEqual(normalizeEditParams(p), p);
});

test('resetModule and isModuleModified compare with the default recipe', () => {
  let p = updateModule(defaultEditParams, 'sharpen', { params: { amount: 0.5 } });
  p = updateModule(p, 'filmic', { enabled: false });
  p = updateModule(p, 'exposure', { params: { ev: 0.7 } });
  assert.deepEqual(
    ['sharpen', 'exposure', 'filmic', 'blur'].map((k) => isModuleModified(p, k as 'blur')),
    [true, false, true, false],
  );
  p = resetModule(resetModule(p, 'sharpen'), 'filmic');
  assert.deepEqual(p, defaultEditParams);
  assert.ok(isDefaultEdit(p));
});

test('develops a RAW file when RAWTISSERIE_SAMPLE is set', { skip: !process.env.RAWTISSERIE_SAMPLE }, async () => {
  const { Developer } = await import('./node.ts');
  initPipeline();
  const dev = new Developer(readFileSync(process.env.RAWTISSERIE_SAMPLE!));
  const meta = JSON.parse(dev.metadata());
  assert.ok(meta.width > 0);
  const jpeg = dev.renderJpeg('{}', 256, 256, 80);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  dev.free();
});
