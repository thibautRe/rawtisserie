import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDIT_PARAMS_VERSION,
  addInstance,
  defaultEditParams,
  defaultModuleParams,
  findModule,
  normalizeEditParams,
  updateInstance,
  updateModule,
  addSpot,
  spotsOf,
  addMaskShape,
  maskOf,
  updateMask,
  type ModuleKind,
} from './params.ts';
import type { Shape } from './shapes.ts';
import {
  BUILTIN_PRESETS,
  PRESET_GROUPS,
  applyModulePreset,
  applyStyle,
  normalizeModulePreset,
  modulePresetPayload,
  normalizeStyle,
  PRESET_KINDS,
  presetGroupsOf,
  presetParams,
  styleFromRecipe,
} from './presets.ts';

test("a kind's preset groups cover each of its parameters once", () => {
  for (const [kind, groups] of Object.entries(PRESET_GROUPS)) {
    const keys = Object.values(groups).flatMap((g) => g.keys as readonly string[]);
    assert.deepEqual([...keys].sort(), Object.keys(defaultModuleParams[kind as ModuleKind]).sort(), kind);
  }
});

test('built-in presets are valid and keep their parameters', () => {
  const ids = new Set<string>();
  for (const p of BUILTIN_PRESETS) {
    assert.ok(!ids.has(p.id), p.id);
    ids.add(p.id);
    assert.deepEqual(normalizeModulePreset(p.moduleKind, p.payload), p.payload, p.id);
  }
});

test('a preset can hold part of a module', () => {
  const recipe = updateModule(defaultEditParams, 'colorCalibration', {
    params: { temperature: 4000, illuminant: 'daylight', red: [1.2, -0.1, -0.1] },
  });
  const calibration = findModule(recipe, 'colorCalibration')!.params;
  const mixer = presetParams('colorCalibration', calibration, ['mixer']);
  assert.deepEqual(Object.keys(mixer).sort(), PRESET_GROUPS.colorCalibration!.mixer!.keys.toSorted());
  assert.deepEqual(mixer.red, [1.2, -0.1, -0.1]);
  assert.deepEqual(presetGroupsOf('colorCalibration', mixer), ['mixer']);
  assert.deepEqual(presetParams('colorCalibration', calibration), calibration, 'all of it by default');

  // Applied elsewhere, it leaves the white balance alone.
  const other = updateModule(defaultEditParams, 'colorCalibration', { params: { temperature: 7000 } });
  const id = findModule(other, 'colorCalibration')!.id;
  const applied = findModule(
    applyModulePreset(other, 'colorCalibration', id, { params: mixer }),
    'colorCalibration',
  )!.params;
  assert.equal(applied.temperature, 7000);
  assert.deepEqual(applied.red, [1.2, -0.1, -0.1]);
});

test('applying a preset to a kind without an instance adds one, switched on', () => {
  const p = applyModulePreset(defaultEditParams, 'sharpen', 'sharpen', { params: { amount: 0.8 } });
  const sharpen = findModule(p, 'sharpen')!;
  assert.equal(sharpen.enabled, true);
  assert.deepEqual(sharpen.params, { ...defaultModuleParams.sharpen, amount: 0.8 });
  assert.deepEqual(normalizeEditParams(p), p, 'in pipeline order');
});

test('stored module presets keep only the valid fields they have', () => {
  const payload = normalizeModulePreset('filmic', {
    version: 1,
    params: { contrast: 1.4, bleach: 'neon', bogus: 3, toe: 'x' },
  });
  assert.equal(payload.version, EDIT_PARAMS_VERSION);
  assert.deepEqual(payload.params, {
    contrast: 1.4,
    toe: defaultModuleParams.filmic.toe,
    bleach: defaultModuleParams.filmic.bleach,
  });
  assert.deepEqual(normalizeModulePreset('filmic', null).params, {});
});

test('styles replace or append instances', () => {
  // The default recipe's colour balance (colorfulness: standard).
  const balance = (p: Partial<(typeof defaultModuleParams)['colorBalance']>) => ({
    ...findModule(defaultEditParams, 'colorBalance')!.params,
    ...p,
  });
  let source = updateModule(defaultEditParams, 'colorBalance', { params: { chroma: [-1, 0, 0, 0] } });
  source = updateModule(source, 'filmic', { params: { contrast: 1.6 } });
  source = updateInstance(source, 'colorBalance', 'colorBalance', { label: 'mono' });
  const style = styleFromRecipe(source, ['colorBalance', 'filmic']);
  assert.deepEqual(
    style.modules.map((m) => m.kind),
    ['colorBalance', 'filmic'],
  );
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);

  let target = updateModule(defaultEditParams, 'colorBalance', { params: { vibrance: 0.5 } });
  target = updateModule(target, 'filmic', { params: { contrast: 1 } });

  const replaced = applyStyle(target, style, 'replace');
  assert.deepEqual(
    replaced.modules.map((m) => [m.id, m.kind]),
    [
      ['exposure', 'exposure'],
      ['colorCalibration', 'colorCalibration'],
      ['colorBalance', 'colorBalance'],
      ['filmic', 'filmic'],
    ],
  );
  assert.deepEqual(findModule(replaced, 'colorBalance')!.params, balance({ chroma: [-1, 0, 0, 0] }));
  assert.equal(findModule(replaced, 'colorBalance')!.label, 'mono');
  assert.equal(findModule(replaced, 'filmic')!.params.contrast, 1.6);

  const appended = applyStyle(target, style, 'append');
  const colors = appended.modules.filter((m) => m.kind === 'colorBalance');
  assert.deepEqual(
    colors.map((m) => [m.id, m.params]),
    [
      ['colorBalance', balance({ vibrance: 0.5 })],
      ['colorBalance-2', balance({ chroma: [-1, 0, 0, 0] })],
    ],
  );
  assert.equal(appended.modules.filter((m) => m.kind === 'filmic').length, 1, 'filmic is single-instance');
  assert.equal(findModule(appended, 'filmic')!.params.contrast, 1.6);
});

test('a style can be applied twice', () => {
  const style = styleFromRecipe(addInstance(defaultEditParams, 'exposure'), ['exposure', 'exposure-2']);
  const twice = applyStyle(applyStyle(defaultEditParams, style, 'append'), style, 'append');
  const ids = twice.modules.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(twice.modules.filter((m) => m.kind === 'exposure').length, 5);
});

test('styles carry the shapes of their retouch spots', () => {
  const at = (x: number): Shape => ({
    type: 'ellipse',
    center: [x, 0.5],
    radii: [0.01, 0.01],
    rotation: 0,
    feather: 0,
    opacity: 1,
  });
  const [withSpot] = addSpot(defaultEditParams, 'retouch', at(0.3), { mode: 'clone', source: [0.05, 0] });
  const retouch = findModule(withSpot, 'retouch')!;
  const style = styleFromRecipe(withSpot, [retouch.id]);
  assert.deepEqual(style.shapes, { s1: at(0.3) });
  assert.deepEqual(styleFromRecipe(withSpot, ['exposure']).shapes, undefined);
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);

  // Appended to a recipe with its own spot: a second instance, its shape renamed.
  const [other] = addSpot(defaultEditParams, 'retouch', at(0.8), {});
  const appended = applyStyle(other, style, 'append');
  assert.deepEqual(appended.shapes, { s1: at(0.8), s2: at(0.3) });
  assert.deepEqual(
    appended.modules.filter((m) => m.kind === 'retouch').map((m) => spotsOf(appended, m.id)[0]!.shape),
    ['s1', 's2'],
  );
  // Replacing: the style's instance takes the place of the recipe's.
  const replaced = applyStyle(other, style, 'replace');
  assert.deepEqual(replaced.shapes, { s1: at(0.3) });
  assert.equal(spotsOf(replaced, 'retouch')[0]!.mode, 'clone');
  assert.equal(PRESET_KINDS.includes('retouch'), true);
});

test('retouch presets carry their shapes', () => {
  const at = (x: number): Shape => ({
    type: 'ellipse',
    center: [x, 0.5],
    radii: [0.01, 0.01],
    rotation: 0,
    feather: 0,
    opacity: 1,
  });
  const [one] = addSpot(defaultEditParams, 'retouch', at(0.2), { mode: 'clone', source: [0.05, 0] });
  const [dust] = addSpot(one, 'retouch', at(0.4), {});
  const payload = modulePresetPayload('retouch', findModule(dust, 'retouch')!.params, dust.shapes);
  assert.deepEqual(payload.shapes, { s1: at(0.2), s2: at(0.4) });
  // Stored and read back: the same; shapes nothing uses and spots without a shape go.
  assert.deepEqual(normalizeModulePreset('retouch', JSON.parse(JSON.stringify(payload))), payload);
  const junk = normalizeModulePreset('retouch', {
    params: { spots: [{ shape: 's1' }, { shape: 'gone' }] },
    shapes: { s1: at(0.1), unused: at(0.9), bad: { type: 'ellipse' } },
  });
  assert.deepEqual(
    junk.params.spots!.map((s) => s.shape),
    ['s1'],
  );
  assert.deepEqual(Object.keys(junk.shapes!), ['s1']);

  // Applied to another photo's retouch instance: it replaces the spots, and the shape
  // ids that are taken there get fresh ones.
  const [other] = addSpot(defaultEditParams, 'retouch', at(0.8), {});
  const [two] = addSpot(addInstance(other, 'retouch'), 'retouch-2', at(0.6), {});
  const applied = applyModulePreset(two, 'retouch', 'retouch', payload);
  assert.deepEqual(
    spotsOf(applied, 'retouch').map((s) => applied.shapes![s.shape]),
    [at(0.2), at(0.4)],
  );
  assert.equal(spotsOf(applied, 'retouch')[0]!.mode, 'clone');
  assert.deepEqual(
    spotsOf(applied, 'retouch-2').map((s) => applied.shapes![s.shape]),
    [at(0.6)],
  );
  // The replaced spot's shape (at 0.8) is gone.
  assert.deepEqual(Object.values(applied.shapes!).length, 3);
  assert.deepEqual(normalizeEditParams(JSON.parse(JSON.stringify(applied))), applied);
  // On a recipe without retouch, it adds an instance.
  assert.deepEqual(applyModulePreset(defaultEditParams, 'retouch', 'retouch', payload).shapes, payload.shapes);
  // Presets of other kinds have no shapes.
  assert.equal('shapes' in modulePresetPayload('sharpen', defaultModuleParams.sharpen, dust.shapes), false);
});

test('masks travel with styles, and with presets when asked', () => {
  const at = (x: number): Shape => ({
    type: 'ellipse',
    center: [x, 0.5],
    radii: [0.1, 0.1],
    rotation: 0,
    feather: 0,
    opacity: 1,
  });
  const [spotted] = addSpot(defaultEditParams, 'retouch', at(0.9), {});
  const [masked] = addMaskShape(spotted, 'exposure', 'exposure', at(0.3));
  const recipe = updateMask(masked, 'exposure', 'exposure', { luminance: [-2, -1, 1, 2] });
  const mask = maskOf(recipe, 'exposure')!;
  assert.deepEqual(mask.drawn, [{ shape: 's2', op: 'union' }]);

  // A style keeps the mask and its shape; appended to a recipe using `s2`, it's renamed.
  const style = styleFromRecipe(recipe, ['exposure']);
  assert.deepEqual(style.shapes, { s2: at(0.3) });
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);
  const [other] = addMaskShape(
    updateModule(defaultEditParams, 'colorBalance', {}),
    'colorBalance',
    'colorBalance',
    at(0.7),
  );
  const [taken] = addMaskShape(other, 'colorBalance', 'colorBalance', at(0.6));
  const appended = applyStyle(taken, style, 'append');
  const added = appended.modules.filter((m) => m.kind === 'exposure').at(-1)!;
  assert.equal(added.mask!.drawn[0]!.shape, 's3');
  assert.deepEqual(appended.shapes!.s3, at(0.3));
  assert.deepEqual(added.mask!.luminance, [-2, -1, 1, 2]);

  // A preset leaves the mask out unless asked.
  const exposure = findModule(recipe, 'exposure')!;
  const plain = modulePresetPayload('exposure', exposure.params, recipe.shapes);
  assert.equal(plain.mask, undefined);
  assert.equal(plain.shapes, undefined);
  assert.deepEqual(maskOf(applyModulePreset(recipe, 'exposure', 'exposure', plain), 'exposure'), mask);
  const withMask = modulePresetPayload('exposure', exposure.params, recipe.shapes, undefined, mask);
  assert.deepEqual(withMask.shapes, { s2: at(0.3) });
  assert.deepEqual(normalizeModulePreset('exposure', JSON.parse(JSON.stringify(withMask))), withMask);
  // Applied elsewhere: the mask comes with its shape, renamed if its id is taken there.
  const applied = applyModulePreset(taken, 'colorBalance', 'colorBalance', { ...withMask, params: {} });
  assert.deepEqual(maskOf(applied, 'colorBalance')!.drawn, [{ shape: 's3', op: 'union' }]);
  assert.deepEqual(applied.shapes, { s3: at(0.3) }, 'the old mask shapes go');
  // Not on kinds that can't be masked.
  assert.equal(
    modulePresetPayload('filmic', defaultModuleParams.filmic, recipe.shapes, undefined, mask).mask,
    undefined,
  );
});
