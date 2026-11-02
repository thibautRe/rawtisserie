import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MODULE_KINDS,
  defaultEditParams,
  defaultRecipe,
  addInstance,
  defaultModuleParams,
  findModule,
  isDefaultEdit,
  isInstanceModified,
  isModuleModified,
  moveInstance,
  normalizeEditParams,
  removeInstance,
  resetInstance,
  resetModule,
  updateInstance,
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
  { version: 6, modules: MODULE_KINDS.map((kind) => ({ kind })) },
  // White balance (warmth/tint) becomes colour calibration.
  { version: 5, modules: [{ kind: 'whiteBalance', params: { warmth: -0.35, tint: 0.12 } }, { kind: 'filmic' }] },
  {
    version: 4,
    modules: [
      { kind: 'whiteBalance', params: { warmth: 0.3 } },
      { kind: 'whiteBalance', enabled: false, params: { tint: 1 } },
      { kind: 'whiteBalance', label: 'x', params: { tint: -2, warmth: 'hot' } },
    ],
  },
  { version: 2, whiteBalance: { warmth: 0.25, tint: -0.1 }, exposure: { ev: 1 } },
  { version: 5, modules: [{ kind: 'whiteBalance', params: { warmth: 0, tint: 0 } }] },
  {
    version: 6,
    modules: [
      { kind: 'colorCalibration', params: { illuminant: 'daylight', temperature: 4200, adaptation: 'linearBradford', gamut: 2.5 } },
      { kind: 'colorCalibration', label: 'mono', params: { adaptation: 'none', grey: [0.3, 0.6, 0.1], normalizeGrey: true, clip: false } },
      { kind: 'colorCalibration', params: { illuminant: 'fluorescent', fluorescent: 'f11', red: [1.1, -0.1, 0], colorfulness: [0.2, 0, -0.1] } },
      { kind: 'colorCalibration', params: { illuminant: 'custom', x: 0.4, y: 0.38, led: 'rgb1', brightness: [0, 0.1, 0] } },
    ],
  },
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
    ['exposure', 'colorCalibration', 'color', 'filmic'],
  );
  assert.deepEqual(findModule(p, 'exposure')!.params, { ev: 2, black: 0 });
  assert.deepEqual(findModule(p, 'color')!.params, defaultModuleParams.color);
  assert.equal(findModule(p, 'filmic')!.params.bleach, 'medium');
  const c = normalizeEditParams({ version: 6, modules: [{ kind: 'colorCalibration', params: { illuminant: 'moon', adaptation: 'magic', red: [1, 2] } }] });
  assert.deepEqual(findModule(c, 'colorCalibration')!.params, defaultModuleParams.colorCalibration);
});

test('v1–v5 recipes get colour calibration, with their warmth/tint', () => {
  assert.deepEqual(normalizeEditParams({ version: 5, modules: [{ kind: 'exposure' }, { kind: 'filmic' }] }), defaultEditParams);
  assert.deepEqual(normalizeEditParams({}), defaultEditParams);
  const p = normalizeEditParams({ version: 5, modules: [{ kind: 'whiteBalance', params: { warmth: 0.5 } }] });
  assert.deepEqual(p.modules.map((m) => m.kind), ['colorCalibration']);
  const c = findModule(p, 'colorCalibration')!.params;
  assert.equal(c.illuminant, 'asShot');
  assert.equal(c.normalizeRed, false);
  assert.ok(c.red[0]! > 1 && c.blue[2]! < 1, JSON.stringify(c));
  // Later recipes keep what they have.
  assert.deepEqual(normalizeEditParams({ version: 6, modules: [] }).modules, []);
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
  assert.equal(p.version, 6);
  assert.deepEqual(
    p.modules.map((m) => [m.id, m.enabled]),
    [
      ['geometry', true],
      ['exposure', true],
      ['colorCalibration', true],
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
    ['sharpen', 'exposure', 'colorCalibration', 'color', 'filmic'],
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

test('instances can be duplicated, moved, renamed, reset and removed', () => {
  const base = updateModule(defaultEditParams, 'exposure', { params: { ev: 1 } });
  const two = addInstance(base, 'exposure');
  assert.deepEqual(two.modules.map((m) => m.id), ['exposure', 'exposure-2', 'colorCalibration', 'filmic']);
  // Starts from scratch, and a new exposure doesn't change the image.
  assert.deepEqual(two.modules[1]!.params, { ev: 0, black: 0 });
  assert.ok(!isInstanceModified(two, 'exposure', 'exposure-2'));
  assert.equal(findModule(two, 'exposure')!.params.ev, 1);
  // The id of a removed instance can be reused.
  assert.deepEqual(addInstance(removeInstance(two, 'exposure-2'), 'exposure'), two);
  // Single-instance kinds get no others.
  assert.equal(addInstance(two, 'filmic'), two);
  // Other kinds start from their defaults.
  const color = updateInstance(defaultEditParams, 'color', 'color', { params: { saturation: 0.5 } });
  assert.deepEqual(addInstance(color, 'color').modules[3]!.params, defaultModuleParams.color);
  // A second colour calibration doesn't adapt again.
  const calibrations = addInstance(defaultEditParams, 'colorCalibration');
  assert.equal(findModule(calibrations, 'colorCalibration')!.params.adaptation, 'cat16');
  assert.deepEqual(calibrations.modules[2]!.params, { ...defaultModuleParams.colorCalibration, adaptation: 'none', gamut: 0, clip: false });
  assert.ok(!isInstanceModified(calibrations, 'colorCalibration', 'colorCalibration-2'));

  const moved = moveInstance(two, 'exposure-2', -1);
  assert.deepEqual(moved.modules.map((m) => m.id), ['exposure-2', 'exposure', 'colorCalibration', 'filmic']);
  // Only within its kind.
  assert.equal(moveInstance(two, 'exposure-2', 1), two);
  assert.equal(moveInstance(two, 'exposure', -1), two);
  assert.deepEqual(normalizeEditParams(moved), moved);

  const named = updateInstance(two, 'exposure', 'exposure-2', { label: 'sky', params: { ev: 2 } });
  assert.equal(named.modules[1]!.label, 'sky');
  assert.ok(isInstanceModified(named, 'exposure', 'exposure-2'));
  const reset = resetInstance(named, 'exposure', 'exposure-2');
  assert.deepEqual(reset.modules[1], { ...named.modules[1], params: { ev: 0, black: 0 } });
  assert.ok(!isInstanceModified(reset, 'exposure', 'exposure-2'));
  // The only instance goes back to the default recipe.
  assert.deepEqual(resetInstance(base, 'exposure', 'exposure'), defaultEditParams);
  // An instance that doesn't exist yet is added after its kind.
  const added = updateInstance(defaultEditParams, 'color', 'color', { enabled: true, params: { saturation: 0.5 } });
  assert.deepEqual(added.modules.map((m) => m.id), ['exposure', 'colorCalibration', 'color', 'filmic']);
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
