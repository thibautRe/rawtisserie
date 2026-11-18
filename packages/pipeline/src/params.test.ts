import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EDIT_PARAMS_VERSION,
  MODULE_KINDS,
  defaultEditParams,
  originalEditParams,
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
  addSpot,
  defaultSpot,
  removeSpot,
  spotsOf,
  updateShape,
  updateSpot,
  addMaskShape,
  defaultMask,
  maskOf,
  maskParams,
  removeMask,
  removeMaskShape,
  updateMask,
  lutIds,
  toneRangeWeights,
  forPhoto,
  hasKind,
  instanceDefaults,
  originalRecipe,
} from './params.ts';
import type { EllipseShape as Shape } from './shapes.ts';
import { initPipeline, defaultParams, defaultRecipeWasm, normalizeParams } from './node.ts';

test('TypeScript defaults match the Rust defaults', () => {
  initPipeline();
  assert.deepEqual(JSON.parse(defaultParams()), defaultEditParams);
});

test('defaultRecipe matches Rust', () => {
  initPipeline();
  for (const metadata of [{}, { lensCorrection: null }, { lensCorrection: 'sony' }, { imageFormat: 'jpeg' }]) {
    assert.deepEqual(
      defaultRecipe(metadata),
      JSON.parse(defaultRecipeWasm(JSON.stringify(metadata))),
      JSON.stringify(metadata),
    );
  }
  assert.equal(defaultRecipe({ lensCorrection: null }), defaultEditParams);
});

test('an image that is not a RAW file starts empty and has no filmic or lens correction', () => {
  const jpeg = { imageFormat: 'jpeg' };
  assert.deepEqual(defaultRecipe(jpeg).modules, []);
  assert.equal(originalRecipe(jpeg), defaultRecipe(jpeg));
  assert.equal(originalRecipe(null), originalEditParams);
  assert.ok(!hasKind(jpeg, 'filmic') && !hasKind(jpeg, 'lens') && hasKind(jpeg, 'exposure'));
  assert.ok(hasKind({ imageFormat: null }, 'filmic'));

  const raw = defaultRecipe({ lensCorrection: 'sony' });
  assert.equal(forPhoto(raw, {}), raw);
  assert.deepEqual(
    forPhoto(raw, jpeg).modules.map((m) => m.kind),
    raw.modules.map((m) => m.kind).filter((k) => k !== 'lens' && k !== 'filmic'),
  );
  // Compared with the photo's original.
  const exposed = updateModule(defaultRecipe(jpeg), 'exposure', { params: { ev: 1 } });
  assert.ok(isModuleModified(exposed, 'exposure', originalRecipe(jpeg)));
  assert.deepEqual(resetModule(exposed, 'exposure', originalRecipe(jpeg)).modules, []);
  assert.ok(isDefaultEdit(defaultRecipe(jpeg), originalRecipe(jpeg)));
  // Its modules start neutral: no +0.7 EV push, no white balance.
  assert.equal(instanceDefaults('exposure', 0, originalRecipe(jpeg)).ev, 0);
  assert.equal(instanceDefaults('colorCalibration', 0, originalRecipe(jpeg)).adaptation, 'none');
  assert.equal(instanceDefaults('exposure', 0).ev, defaultModuleParams.exposure.ev);
});

/** Recipes on which TypeScript and Rust must agree. */
const samples: unknown[] = [
  {},
  { version: 1, exposure: { ev: 1 }, toneMap: { contrast: 2 } },
  {
    version: 2,
    exposure: { ev: 1.5 },
    geometry: { rotation: 1 },
    filmic: { enabled: false, bleach: 'extra' },
    sharpen: { amount: 0, radius: 2 },
  },
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
  {
    version: 5,
    modules: [{ kind: 'filmic' }, { kind: 'lens', params: { tca: 0 } }, { kind: 'lens', params: { tca: 2 } }],
  },
  {
    version: 8,
    modules: [
      {
        kind: 'lens',
        params: {
          vignetting: 0.5,
          lensfun: {
            lens: 'Canon RF 70-200mm F2.8L IS USM',
            cropFactor: 1,
            calibCropFactor: 1,
            calibAspectRatio: 1.5,
            focalLength: 200,
            fNumber: 2.8,
            distortion: { model: 'ptlens', terms: [0.01, -0.02, 0.005] },
            tca: { model: 'poly3', terms: [1.0002, 0.9998, 0, 0, 0.0001, -0.0001] },
            vignetting: [-0.3, 0.1, -0.05],
          },
        },
      },
    ],
  },
  {
    version: 6,
    modules: [
      { kind: 'toneCurve', params: { rgb: [0, 0, -0.25, -0.5, 0, 0.125, 0.5, 0.75, 0] } },
      {
        kind: 'toneCurve',
        label: 'cross',
        params: {
          channels: 'independent',
          preserveColors: 'power',
          range: [-6.5, 2.4],
          red: [0, 0, 0, 0, 0.25, 0, 0, 0, 0],
        },
      },
      { kind: 'toneCurve', enabled: false, params: { preserveColors: 'none', green: [0, 0, 0, 0, 0, 0, 0, 0, 1.5] } },
    ],
  },
  // Every kind with its defaults.
  { version: 5, modules: MODULE_KINDS.map((kind) => ({ kind })) },
  { version: 6, modules: MODULE_KINDS.map((kind) => ({ kind })) },
  { version: 7, modules: MODULE_KINDS.map((kind) => ({ kind })) },
  // Colour and shadows/highlights become colour balance.
  {
    version: 6,
    modules: [
      { id: 'pop', label: 'pop', kind: 'color', params: { saturation: 0.4, vibrance: -1.5 }, mask: { opacity: 0.5 } },
      { kind: 'shadowsHighlights', enabled: false, params: { shadows: 0.3, highlights: -0.25 } },
      { kind: 'color', params: { saturation: 'lots' } },
      { kind: 'shadowsHighlights' },
    ],
  },
  { version: 2, color: { saturation: 0.1 }, shadowsHighlights: { shadows: 0, highlights: 0 } },
  {
    version: 7,
    modules: [
      {
        kind: 'colorBalance',
        params: {
          hueShift: 12,
          saturation: [0.1, 0.2, 0, -0.3],
          shadows: { temperature: 4000, red: [0.9, 0.1, 0], normalizeRed: false },
          highlights: { blue: [0, 0.2, 0.8] },
          midtonesRange: 2.5,
          whiteFulcrum: 4,
        },
        mask: { luminance: [-4, -3, 0, 1] },
      },
      { kind: 'colorBalance', params: { midtones: { temperature: 12000 }, fulcrum: -1 } },
    ],
  },
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
      {
        kind: 'colorCalibration',
        params: { illuminant: 'daylight', temperature: 4200, adaptation: 'linearBradford', gamut: 2.5 },
      },
      {
        kind: 'colorCalibration',
        label: 'mono',
        params: { adaptation: 'none', grey: [0.3, 0.6, 0.1], normalizeGrey: true, clip: false },
      },
      {
        kind: 'colorCalibration',
        params: { illuminant: 'fluorescent', fluorescent: 'f11', red: [1.1, -0.1, 0], colorfulness: [0.2, 0, -0.1] },
      },
      {
        kind: 'colorCalibration',
        params: { illuminant: 'custom', x: 0.4, y: 0.38, led: 'rgb1', brightness: [0, 0.1, 0] },
      },
    ],
  },
  {
    version: 5,
    modules: [
      {
        kind: 'colorPrimaries',
        params: { red: { hue: 12.5 }, blue: { saturation: -20, brightness: 0.05 }, whiteLevel: 2 },
      },
      {
        kind: 'contrastEqualizer',
        params: { luma: [0.5, 0.6, 0.7, 0.6, 0.5, 0.5], lumaDenoise: [0, 0, 0, 0, 0.2, 0.4], mix: 0.5 },
      },
      { kind: 'contrastEqualizer', label: 'fine', params: { edges: [1, 1, 1, 0.5, 0.5, 0.5] } },
    ],
  },
  // Diffuse or sharpen, partly given (a preset's speeds), one masked.
  {
    version: 8,
    modules: [
      { kind: 'diffuse', params: { iterations: 16, radius: 10, speed2: 0.125, anisotropy2: 0 } },
      { kind: 'diffuse', params: { luminanceThreshold: 1.41 }, mask: { luminance: [-2, 0, 8, 8] } },
    ],
  },
  // Glow, partly given, one masked with a blend mode.
  {
    version: 6,
    modules: [
      { kind: 'glow', params: { threshold: 2, radius: 25, hue: 10, saturation: 1 } },
      {
        kind: 'glow',
        params: { strength: 0.4 },
        mask: { luminance: [-2, 0, 8, 8], blend: 'screen', blendFulcrum: 1 },
      },
    ],
  },
  // Retouch spots and their shapes: spots without a shape and unused shapes go.
  {
    version: 6,
    modules: [
      { kind: 'exposure' },
      {
        kind: 'retouch',
        params: {
          spots: [
            { shape: 's2', mode: 'clone', source: [0.1, -0.02], opacity: 0.5 },
            { shape: 'missing' },
            { shape: 's10', mode: 'fill', color: [0.5, 0.2, 0.1] },
            { shape: 's1', mode: 'blur', radius: 8 },
            { shape: 'a', source: [0.2, 0] },
          ],
        },
      },
      { kind: 'retouch', params: { spots: [{ shape: 'unused' }] } },
    ],
    shapes: {
      unused: { type: 'ellipse', center: [0.1, 0.1], radii: [0.01, 0.01] },
      s2: { type: 'ellipse', center: [0.4, 0.3], radii: [0.05, 0.03], rotation: 0.3, feather: 0.02, opacity: 0.9 },
      s10: {
        type: 'path',
        points: [
          [0.1, 0.1, 0.1, 0.1, 0.15, 0.05],
          [0.2, 0.1, 0.2, 0.1, 0.2, 0.1],
          [0.15, 0.2, 0.15, 0.2, 0.15, 0.2],
        ],
        feather: 0.01,
      },
      s1: {
        type: 'brush',
        points: [
          [0.5, 0.5, 0.02, 0.5],
          [0.6, 0.55, 0.03, 1],
        ],
      },
      a: { type: 'gradient', anchor: [0.5, 0.2], angle: 1.2, feather: 0.1 },
    },
  },
  { version: 6, modules: [{ kind: 'exposure' }], shapes: { s1: { type: 'ellipse', center: [0, 0], radii: [1, 1] } } },
  // Masks: drawn parts without their shape go, and masks on kinds that can't have one.
  {
    version: 6,
    modules: [
      {
        kind: 'exposure',
        mask: {
          drawn: [{ shape: 'a' }, { shape: 'missing', op: 'difference' }, { shape: 'b', op: 'exclusion' }],
          luminance: [-2, -1, 1.5, 3],
          feather: 12.5,
        },
      },
      { kind: 'exposure', mask: null },
      { kind: 'color', params: { saturation: 0.5 }, mask: { hue: [340, 350, 10, 20], invert: true, opacity: 0.4 } },
      { kind: 'sharpen', mask: { drawn: [{ shape: 'b', op: 'intersection' }], edgeAware: false } },
      { kind: 'colorPrimaries', mask: {} },
      { kind: 'toneCurve', mask: { blend: 'softLight', blendFulcrum: 1.5, opacity: 0.6 } },
      { kind: 'colorCalibration', mask: { red: [-1, 0, 2, 3], blue: [-9, -8, -2, -1] } },
      { kind: 'shadowsHighlights', mask: { enabled: false, luminance: [-6, -5, -2, -1], feather: 20 } },
      { kind: 'filmic', mask: { drawn: [{ shape: 'c' }] } },
      { kind: 'retouch', mask: { drawn: [{ shape: 'c' }] } },
    ],
    shapes: {
      a: { type: 'ellipse', center: [0.5, 0.5], radii: [0.1, 0.2] },
      b: { type: 'gradient', anchor: [0.5, 0.3], angle: -1.5 },
      c: { type: 'ellipse', center: [0.2, 0.2], radii: [0.05, 0.05] },
    },
  },
  { version: 6, modules: [{ kind: 'retouch', enabled: false, params: { spots: [{ shape: 's1' }] } }], shapes: null },
  {
    version: 6,
    modules: [
      { kind: 'lut', params: { lut: { id: 'abc', name: 'Vivid' }, interpolation: 'pyramid' } },
      { kind: 'filmic' },
      { kind: 'lut', params: { lut: { id: 'def' } }, mask: { opacity: 0.5, blend: 'multiply' } },
      { kind: 'lut', params: { lut: null } },
      { kind: 'lut', enabled: false },
    ],
  },
  // Pending auto-tunes (roadmap 8.7): only on kinds that have one, and only `true`.
  {
    version: 7,
    modules: [
      { kind: 'filmic', autoTune: true },
      { kind: 'toneCurve', autoTune: true },
      { kind: 'toneCurve', autoTune: 'yes' },
      { kind: 'exposure', autoTune: true },
    ],
  },
];

test('normalizeEditParams matches Rust', () => {
  initPipeline();
  for (const sample of samples) {
    assert.deepEqual(
      normalizeEditParams(sample),
      JSON.parse(normalizeParams(JSON.stringify(sample))),
      JSON.stringify(sample),
    );
  }
});

test('lutIds lists the LUTs of enabled instances once', () => {
  const p = normalizeEditParams({
    version: 6,
    modules: [
      { kind: 'lut', params: { lut: { id: 'b', name: 'B' } } },
      { kind: 'lut', params: { lut: 'junk', interpolation: 'cubic' } },
      { kind: 'lut', params: { lut: { id: 'a' } } },
      { kind: 'lut', params: { lut: { id: 'b', name: 'B again' } } },
      { kind: 'lut', enabled: false, params: { lut: { id: 'c' } } },
    ],
  });
  assert.deepEqual(lutIds(p), ['b', 'a']);
  assert.deepEqual(p.modules[1]!.params, defaultModuleParams.lut);
});

/** Colour balance's defaults with the ranges it had in v7 (which migrated recipes keep). */
const legacyBalance = {
  ...defaultModuleParams.colorBalance,
  fulcrum: 0,
  midtonesRange: 4,
  shadowsFalloff: 2,
  highlightsFalloff: 2,
};

/** The original before colour balance joined it: what old recipes migrate to. */
const defaultWithoutBalance = {
  ...originalEditParams,
  modules: originalEditParams.modules.filter((m) => m.kind !== 'colorBalance'),
};

test('normalizeEditParams fills gaps and ignores junk', () => {
  const p = normalizeEditParams({
    version: 3,
    modules: [
      { kind: 'exposure', params: { ev: 2 } },
      { kind: 'color', params: 'nope' },
      { kind: 'teleport' },
      'junk',
      { kind: 'filmic', params: { bleach: 'neon' } },
    ],
  });
  assert.deepEqual(
    p.modules.map((m) => m.kind),
    ['exposure', 'colorCalibration', 'colorBalance', 'filmic'],
  );
  assert.deepEqual(findModule(p, 'exposure')!.params, { ev: 2, black: 0 });
  // A v3–v6 colour instance with junk becomes a neutral colour balance, with the ranges of v7.
  assert.deepEqual(findModule(p, 'colorBalance')!.params, legacyBalance);
  assert.equal(findModule(p, 'filmic')!.params.bleach, 'medium');
  const c = normalizeEditParams({
    version: 6,
    modules: [{ kind: 'colorCalibration', params: { illuminant: 'moon', adaptation: 'magic', red: [1, 2] } }],
  });
  assert.deepEqual(findModule(c, 'colorCalibration')!.params, defaultModuleParams.colorCalibration);
});

test('v1–v5 recipes get colour calibration, with their warmth/tint', () => {
  assert.deepEqual(
    normalizeEditParams({ version: 5, modules: [{ kind: 'exposure' }, { kind: 'filmic' }] }),
    defaultWithoutBalance,
  );
  assert.deepEqual(normalizeEditParams({}), defaultWithoutBalance);
  const p = normalizeEditParams({ version: 5, modules: [{ kind: 'whiteBalance', params: { warmth: 0.5 } }] });
  assert.deepEqual(
    p.modules.map((m) => m.kind),
    ['colorCalibration'],
  );
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
    modules: [
      {
        kind: 'contrastEqualizer',
        params: { luma: [0.7, 0.7], chroma: [1, 1, 1, 1, 1, 'x'], edges: [1, 1, 1, 1, 1, 1] },
      },
    ],
  });
  const eq = findModule(p, 'contrastEqualizer')!.params;
  assert.deepEqual(eq.luma, defaultModuleParams.contrastEqualizer.luma);
  assert.deepEqual(eq.chroma, defaultModuleParams.contrastEqualizer.chroma);
  assert.deepEqual(eq.edges, [1, 1, 1, 1, 1, 1]);
  assert.notEqual(eq.lumaDenoise, defaultModuleParams.contrastEqualizer.lumaDenoise, 'defaults are copied');
});

test('v2 recipes become one instance per section', () => {
  const p = normalizeEditParams({
    version: 2,
    exposure: { ev: 2 },
    filmic: { enabled: false, contrast: 1.5 },
    geometry: { crop: { x: 0.5 } },
  });
  assert.equal(p.version, EDIT_PARAMS_VERSION);
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
  let p = updateModule(defaultEditParams, 'glow', { params: { strength: 0.5 } });
  p = updateModule(p, 'colorBalance', { params: { vibrance: 0.2 } });
  p = updateModule(p, 'exposure', { params: { ev: 1 } });
  assert.deepEqual(
    p.modules.map((m) => m.kind),
    ['glow', 'exposure', 'colorCalibration', 'colorBalance', 'filmic'],
  );
  assert.deepEqual(findModule(p, 'glow')!.params, { ...defaultModuleParams.glow, strength: 0.5 });
  assert.equal(findModule(p, 'exposure')!.params.ev, 1);
  assert.equal(findModule(defaultEditParams, 'exposure')!.params.ev, 0.7, 'the input is not modified');
  assert.deepEqual(normalizeEditParams(p), p);
});

test('resetModule and isModuleModified compare with the original', () => {
  let p = updateModule(defaultEditParams, 'glow', { params: { strength: 0.5 } });
  p = updateModule(p, 'filmic', { enabled: false });
  p = updateModule(p, 'exposure', { params: { ev: 0.7 } });
  assert.deepEqual(
    ['glow', 'exposure', 'filmic', 'diffuse'].map((k) => isModuleModified(p, k as 'glow')),
    [true, false, true, false],
  );
  p = resetModule(resetModule(p, 'glow'), 'filmic');
  assert.deepEqual(p, originalEditParams);
  assert.ok(isDefaultEdit(p));
});

test('instances can be duplicated, moved, renamed, reset and removed', () => {
  const base = updateModule(defaultEditParams, 'exposure', { params: { ev: 1 } });
  const two = addInstance(base, 'exposure');
  assert.deepEqual(
    two.modules.map((m) => m.id),
    ['exposure', 'exposure-2', 'colorCalibration', 'colorBalance', 'filmic'],
  );
  // Starts from scratch, and a new exposure doesn't change the image.
  assert.deepEqual(two.modules[1]!.params, { ev: 0, black: 0 });
  assert.ok(!isInstanceModified(two, 'exposure', 'exposure-2'));
  assert.equal(findModule(two, 'exposure')!.params.ev, 1);
  // The id of a removed instance can be reused.
  assert.deepEqual(addInstance(removeInstance(two, 'exposure-2'), 'exposure'), two);
  // Single-instance kinds get no others.
  assert.equal(addInstance(two, 'filmic'), two);
  // Other kinds start from their defaults.
  const balance = updateInstance(defaultEditParams, 'colorBalance', 'colorBalance', { params: { vibrance: 0.5 } });
  assert.deepEqual(addInstance(balance, 'colorBalance').modules[3]!.params, defaultModuleParams.colorBalance);
  // A second colour calibration doesn't adapt again.
  const calibrations = addInstance(defaultEditParams, 'colorCalibration');
  assert.equal(findModule(calibrations, 'colorCalibration')!.params.adaptation, 'cat16');
  assert.deepEqual(calibrations.modules[2]!.params, {
    ...defaultModuleParams.colorCalibration,
    adaptation: 'none',
    gamut: 0,
    clip: false,
  });
  assert.ok(!isInstanceModified(calibrations, 'colorCalibration', 'colorCalibration-2'));

  const moved = moveInstance(two, 'exposure-2', -1);
  assert.deepEqual(
    moved.modules.map((m) => m.id),
    ['exposure-2', 'exposure', 'colorCalibration', 'colorBalance', 'filmic'],
  );
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
  const added = updateInstance(defaultEditParams, 'colorBalance', 'colorBalance', {
    enabled: true,
    params: { vibrance: 0.5 },
  });
  assert.deepEqual(
    added.modules.map((m) => m.id),
    ['exposure', 'colorCalibration', 'colorBalance', 'filmic'],
  );
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

test('retouch spots carry their shapes', () => {
  const circle: Shape = {
    type: 'ellipse',
    center: [0.5, 0.5],
    radii: [0.02, 0.02],
    rotation: 0,
    feather: 0,
    opacity: 1,
  };
  const [a, first] = addSpot(
    defaultEditParams,
    'retouch',
    { ...circle, center: [0.5, 0.5] },
    {
      mode: 'clone',
      source: [0.1, 0],
    },
  );
  const [b, second] = addSpot(a, 'retouch', { ...circle, center: [0.2, 0.2] }, {});
  assert.deepEqual([first, second], [0, 1]);
  assert.deepEqual(Object.keys(b.shapes!), ['s1', 's2']);
  assert.deepEqual(
    spotsOf(b, 'retouch').map((s) => [s.shape, s.mode]),
    [
      ['s1', 'clone'],
      ['s2', 'heal'],
    ],
  );
  assert.equal(findModule(b, 'retouch')!.enabled, true);
  assert.deepEqual(normalizeEditParams(JSON.parse(JSON.stringify(b))), b);

  const moved = updateShape(b, 's2', { ...circle, center: [0.3, 0.3] });
  assert.deepEqual(moved.shapes!.s2!.type === 'ellipse' && moved.shapes!.s2!.center, [0.3, 0.3]);
  assert.equal(
    updateSpot(moved, 'retouch', 1, { opacity: 0.5 }).modules.find((m) => m.kind === 'retouch')!.enabled,
    true,
  );

  const removed = removeSpot(b, 'retouch', 0);
  assert.deepEqual(Object.keys(removed.shapes!), ['s2']);
  assert.equal(spotsOf(removed, 'retouch').length, 1);
  assert.equal('shapes' in removeSpot(removed, 'retouch', 0), false);
  // Resetting the module drops the spots and their shapes.
  assert.deepEqual(resetModule(b, 'retouch'), defaultEditParams);
  // A new spot doesn't reuse an id still in use.
  const [c] = addSpot(removed, 'retouch', circle, {});
  assert.deepEqual(Object.keys(c.shapes!), ['s1', 's2']);

  // A second instance has its own spots; removing or resetting it drops its shapes only.
  const two = addInstance(b, 'retouch');
  const [d] = addSpot(two, 'retouch-2', circle, { mode: 'fill' });
  assert.deepEqual(
    spotsOf(d, 'retouch-2').map((s) => [s.shape, s.mode]),
    [['s3', 'fill']],
  );
  assert.equal(spotsOf(d, 'retouch').length, 2);
  assert.deepEqual(normalizeEditParams(JSON.parse(JSON.stringify(d))), d);
  assert.deepEqual(Object.keys(removeInstance(d, 'retouch-2').shapes!), ['s1', 's2']);
  assert.deepEqual(Object.keys(resetInstance(d, 'retouch', 'retouch').shapes!), ['s3']);
});

test('invalid shapes and spots are dropped or defaulted', () => {
  const p = normalizeEditParams({
    version: 6,
    modules: [
      {
        kind: 'retouch',
        params: { spots: [{ shape: 'ok', mode: 'smudge', opacity: 'full' }, { shape: 'bad' }, 'junk'] },
      },
    ],
    shapes: { ok: { type: 'ellipse', center: [0.5, 0.5], radii: [0.1, 0.1] }, bad: { type: 'ellipse', center: [1] } },
  });
  assert.deepEqual(spotsOf(p, 'retouch'), [{ ...defaultSpot, shape: 'ok' }]);
  assert.deepEqual(Object.keys(p.shapes!), ['ok']);
});

test('masks carry their shapes', () => {
  const circle: Shape = { type: 'ellipse', center: [0.5, 0.5], radii: [0.1, 0.1], rotation: 0, feather: 0, opacity: 1 };
  const two = addInstance(defaultEditParams, 'exposure');
  const [a, s1] = addMaskShape(two, 'exposure', 'exposure-2', circle);
  const [b, s2] = addMaskShape(a, 'exposure', 'exposure-2', { ...circle, center: [0.3, 0.3] }, 'difference');
  assert.deepEqual([s1, s2], ['s1', 's2']);
  assert.deepEqual(maskOf(b, 'exposure-2')!.drawn, [
    { shape: 's1', op: 'union' },
    { shape: 's2', op: 'difference' },
  ]);
  assert.deepEqual(normalizeEditParams(JSON.parse(JSON.stringify(b))), b);
  assert.ok(isInstanceModified(b, 'exposure', 'exposure-2'), 'a mask is a change');

  // Parametric parts and settings; the drawn part stays.
  const c = updateMask(b, 'exposure', 'exposure-2', { luminance: [-1, 0, 2, 3], invert: true });
  assert.deepEqual(maskOf(c, 'exposure-2'), {
    ...defaultMask,
    drawn: maskOf(b, 'exposure-2')!.drawn,
    luminance: [-1, 0, 2, 3],
    invert: true,
  });
  // Editing a mask switches its instance on; so does moving one of its shapes.
  const off = updateInstance(c, 'exposure', 'exposure-2', { enabled: false });
  assert.equal(updateMask(off, 'exposure', 'exposure-2', { opacity: 0.5 }).modules[1]!.enabled, true);
  assert.equal(updateShape(off, 's1', { ...circle, center: [0.6, 0.6] }).modules[1]!.enabled, true);

  // Removing a drawn part drops its shape; removing the mask drops them all.
  assert.deepEqual(Object.keys(removeMaskShape(c, 'exposure', 'exposure-2', 0).shapes!), ['s2']);
  const gone = removeMask(c, 'exposure-2');
  assert.equal(maskOf(gone, 'exposure-2'), undefined);
  assert.equal('shapes' in gone, false);
  // So do resetting and removing the instance.
  assert.equal('shapes' in resetInstance(c, 'exposure', 'exposure-2'), false);
  assert.equal(maskOf(resetInstance(c, 'exposure', 'exposure-2'), 'exposure-2'), undefined);
  assert.equal('shapes' in removeInstance(c, 'exposure-2'), false);
  // Spots and masks share the shapes' ids.
  const [d] = addSpot(c, 'retouch', circle, {});
  assert.deepEqual(Object.keys(d.shapes!), ['s1', 's2', 's3']);
  // Kinds that can't be masked keep none.
  assert.equal(maskOf(updateMask(c, 'filmic', 'filmic', { invert: true }), 'filmic'), undefined);
});

test('invalid masks get their defaults', () => {
  assert.deepEqual(
    maskParams({
      drawn: [{ shape: 'a', op: 'xor' }, 'junk', { op: 'union' }],
      luminance: [1, 2, 3],
      green: [1, 2],
      opacity: 'x',
      blend: 'xor',
      blendFulcrum: null,
    }),
    {
      ...defaultMask,
      drawn: [
        { shape: 'a', op: 'union' },
        { shape: '', op: 'union' },
      ],
    },
  );
});

test('colour balance range weights add up to 1, like Rust', () => {
  const p = legacyBalance;
  for (const ev of [-12, -4, -2, -0.5, 0, 1, 2, 3, 8]) {
    const w = toneRangeWeights(p, ev);
    assert.ok(Math.abs(w[0] + w[1] + w[2] - 1) < 1e-12, `${ev}: ${w}`);
  }
  // Half-way at the mid-tones' edges, 90 % → 10 % over the fall-off (as in `color_balance.rs`).
  assert.ok(Math.abs(toneRangeWeights(p, -2)[0] - 0.5) < 0.01);
  assert.ok(Math.abs(toneRangeWeights(p, -3)[0] - 0.9) < 1e-3);
  assert.ok(Math.abs(toneRangeWeights(p, 3)[2] - 0.9) < 0.01);
  assert.deepEqual(toneRangeWeights({ ...p, fulcrum: 1 }, 1), toneRangeWeights(p, 0));
});
