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
  type LensfunProfile,
  setLensProfile,
} from './params.ts';
import type { Shape } from './shapes.ts';
import {
  BUILTIN_PRESETS,
  BUILTIN_STYLES,
  type ModulePresetPayload,
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

test('built-in styles are valid and keep what they hold', () => {
  for (const s of BUILTIN_STYLES) assert.deepEqual(normalizeStyle(s.payload), s.payload, s.id);
});

test('the vignette darkens outside an ellipse: as a preset onto exposure, as a style a new instance', () => {
  const preset = BUILTIN_PRESETS.find((p) => p.id === 'builtin:exposure:vignette')!;
  const onExposure = applyModulePreset(
    defaultEditParams,
    'exposure',
    'exposure',
    preset.payload as ModulePresetPayload<'exposure'>,
  );
  const exposure = findModule(onExposure, 'exposure')!;
  assert.equal(exposure.params.ev, -0.6);
  assert.equal(exposure.mask?.invert, true);
  const shape = onExposure.shapes?.[exposure.mask!.drawn[0]!.shape];
  assert.deepEqual(shape && 'center' in shape && shape.center, [0.5, 0.5]);

  const style = BUILTIN_STYLES.find((s) => s.id === 'builtin:style:vignette')!;
  const styled = applyStyle(defaultEditParams, style.payload);
  const exposures = styled.modules.filter((m) => m.kind === 'exposure');
  assert.equal(exposures.length, 2);
  assert.deepEqual(exposures[0], defaultEditParams.modules[0]);
  assert.equal(exposures[1]!.label, 'Vignette');
  assert.equal(exposures[1]!.mask?.drawn.length, 1);
  assert.equal(Object.keys(styled.shapes ?? {}).length, 1);
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
  const p = applyModulePreset(defaultEditParams, 'glow', 'glow', { params: { strength: 0.8 } });
  const glow = findModule(p, 'glow')!;
  assert.equal(glow.enabled, true);
  assert.deepEqual(glow.params, { ...defaultModuleParams.glow, strength: 0.8 });
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
  let source = updateModule(defaultEditParams, 'colorBalance', { params: { chroma: [-1, -1, -1] } });
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

  const replaced = applyStyle(target, style);
  assert.deepEqual(
    replaced.modules.map((m) => [m.id, m.kind]),
    [
      ['exposure', 'exposure'],
      ['colorCalibration', 'colorCalibration'],
      ['colorBalance', 'colorBalance'],
      ['filmic', 'filmic'],
    ],
  );
  assert.deepEqual(findModule(replaced, 'colorBalance')!.params, balance({ chroma: [-1, -1, -1] }));
  assert.equal(findModule(replaced, 'colorBalance')!.label, 'mono');
  assert.equal(findModule(replaced, 'filmic')!.params.contrast, 1.6);

  const appended = applyStyle(target, style, true);
  const colors = appended.modules.filter((m) => m.kind === 'colorBalance');
  assert.deepEqual(
    colors.map((m) => [m.id, m.params]),
    [
      ['colorBalance', balance({ vibrance: 0.5 })],
      ['colorBalance-2', balance({ chroma: [-1, -1, -1] })],
    ],
  );
  assert.equal(appended.modules.filter((m) => m.kind === 'filmic').length, 1, 'filmic is single-instance');
  assert.equal(findModule(appended, 'filmic')!.params.contrast, 1.6);
});

test('a style can be applied twice', () => {
  const style = styleFromRecipe(addInstance(defaultEditParams, 'exposure'), ['exposure', 'exposure-2']);
  const twice = applyStyle(applyStyle(defaultEditParams, style, true), style, true);
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
  const appended = applyStyle(other, style, true);
  assert.deepEqual(appended.shapes, { s1: at(0.8), s2: at(0.3) });
  assert.deepEqual(
    appended.modules.filter((m) => m.kind === 'retouch').map((m) => spotsOf(appended, m.id)[0]!.shape),
    ['s1', 's2'],
  );
  // Replacing: the style's instance takes the place of the recipe's.
  const replaced = applyStyle(other, style);
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
  assert.equal('shapes' in modulePresetPayload('glow', defaultModuleParams.glow, dust.shapes), false);
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
  const appended = applyStyle(taken, style, true);
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

test("a style's raster shapes follow their source instances", () => {
  // exposure-2 masked by where exposure applies (inverted), and by colour balance's mask.
  const two = addInstance(defaultEditParams, 'exposure');
  const [masked] = addMaskShape(two, 'exposure', 'exposure', {
    type: 'ellipse',
    center: [0.5, 0.5],
    radii: [0.1, 0.1],
    rotation: 0,
    feather: 0,
    opacity: 1,
  });
  const [withRaster] = addMaskShape(masked, 'exposure', 'exposure-2', {
    type: 'raster',
    source: 'exposure',
    invert: true,
    opacity: 1,
  });
  const recipe = addMaskShape(withRaster, 'exposure', 'exposure-2', {
    type: 'raster',
    source: 'colorCalibration',
    invert: false,
    opacity: 0.5,
  })[0];
  const style = styleFromRecipe(recipe, ['exposure', 'exposure-2'], { modes: { exposure: 'append' } });
  const sources = (shapes: Record<string, Shape> | undefined) =>
    Object.values(shapes ?? {}).flatMap((s) => (s.type === 'raster' ? [s.source] : []));
  // Its own instance by place; others by id.
  assert.deepEqual(sources(style.shapes), ['style-0', 'colorCalibration']);
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);

  // Appended to a recipe with an exposure already: the raster shape names the new one.
  const applied = applyStyle(defaultEditParams, style, true);
  const exposures = applied.modules.filter((m) => m.kind === 'exposure').map((m) => m.id);
  assert.deepEqual(exposures, ['exposure', 'exposure-2', 'exposure-3']);
  const last = applied.modules.find((m) => m.id === 'exposure-3')!;
  const shapes = last.mask!.drawn.map((d) => applied.shapes![d.shape]!);
  assert.deepEqual(sources(Object.fromEntries(shapes.map((s, i) => [i, s]))), ['exposure-2', 'colorCalibration']);
  // Replacing: the instances keep the recipe's ids.
  const replaced = applyStyle(recipe, { ...style, modules: style.modules.map((m) => ({ ...m, mode: 'replace' })) });
  assert.deepEqual(sources(replaced.shapes), ['exposure', 'colorCalibration']);
});

test('style instances replace by rank or append, each by its own mode', () => {
  // Source: exposure, exposure-2 (a vignette, say), filmic.
  let source = updateModule(defaultEditParams, 'exposure', { params: { ev: 1 } });
  source = addInstance(source, 'exposure');
  source = updateInstance(source, 'exposure', 'exposure-2', { params: { ev: -0.5 }, label: 'vignette' });
  const style = styleFromRecipe(source, ['exposure', 'exposure-2', 'filmic']);
  assert.deepEqual(
    style.modules.map((m) => m.mode),
    ['replace', 'append', 'replace'],
    "a kind's first instance replaces, the others append",
  );
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);

  // Target: two exposures. The first is replaced (keeping its id), the second stays,
  // the vignette is added after them.
  let target = addInstance(defaultEditParams, 'exposure');
  target = updateInstance(target, 'exposure', 'exposure-2', { params: { ev: 0.3 } });
  const applied = applyStyle(target, style);
  assert.deepEqual(
    applied.modules.filter((m) => m.kind === 'exposure').map((m) => [m.id, m.params.ev, m.label]),
    [
      ['exposure', 1, null],
      ['exposure-2', 0.3, null],
      ['exposure-3', -0.5, 'vignette'],
    ],
  );
  // Shift: everything appended (filmic still replaces, being single-instance).
  const all = applyStyle(target, style, true);
  assert.deepEqual(
    all.modules.filter((m) => m.kind === 'exposure').map((m) => m.params.ev),
    [findModule(target, 'exposure')!.params.ev, 0.3, 1, -0.5],
  );
  assert.equal(all.modules.filter((m) => m.kind === 'filmic').length, 1);

  // Two replacing instances replace the first two; modes can be chosen when saving.
  const both = styleFromRecipe(source, ['exposure', 'exposure-2'], { modes: { 'exposure-2': 'replace' } });
  assert.deepEqual(
    applyStyle(target, both)
      .modules.filter((m) => m.kind === 'exposure')
      .map((m) => m.params.ev),
    [1, -0.5],
  );
  // Single-instance kinds can't append.
  assert.equal(styleFromRecipe(source, ['filmic'], { modes: { filmic: 'append' } }).modules[0]!.mode, 'replace');

  // Styles saved before modes existed replace.
  const legacy = normalizeStyle({ version: EDIT_PARAMS_VERSION, modules: [{ kind: 'exposure', params: {} }] });
  assert.equal(legacy.modules[0]!.mode, 'replace');
});

test('a style instance can hold some groups of a module, applied onto the target', () => {
  let source = updateModule(defaultEditParams, 'filmic', { params: { contrast: 1.6, whiteExposure: 2 } });
  const [masked] = addMaskShape(source, 'colorBalance', 'colorBalance', {
    type: 'ellipse',
    center: [0.5, 0.5],
    radii: [0.1, 0.1],
    rotation: 0,
    feather: 0,
    opacity: 1,
  });
  source = updateModule(masked, 'colorBalance', { params: { vibrance: 0.7, fulcrum: 0.3 } });
  const style = styleFromRecipe(source, ['filmic', 'colorBalance'], {
    groups: { filmic: ['look'], colorBalance: ['master'] },
    modes: { colorBalance: 'append' },
  });
  assert.deepEqual(
    style.modules.map((m) => [m.groups, m.mode, 'mask' in m]),
    [
      [['master'], 'replace', false],
      [['look'], 'replace', false],
    ],
    'partial instances replace, without their mask',
  );
  assert.equal(style.shapes, undefined);
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);
  // All the groups: the whole instance.
  assert.equal(
    styleFromRecipe(source, ['filmic'], { groups: { filmic: ['scene', 'look', 'display'] } }).modules[0]!.groups,
    undefined,
  );

  const target = updateModule(defaultEditParams, 'filmic', { params: { contrast: 1, whiteExposure: 5 } });
  const applied = applyStyle(target, style, true);
  assert.equal(findModule(applied, 'filmic')!.params.contrast, 1.6);
  assert.equal(findModule(applied, 'filmic')!.params.whiteExposure, 5, 'other groups stay');
  const balance = applied.modules.filter((m) => m.kind === 'colorBalance');
  assert.equal(balance.length, 1);
  assert.equal(balance[0]!.params.vibrance, 0.7);
  assert.equal(balance[0]!.params.fulcrum, findModule(target, 'colorBalance')!.params.fulcrum);
});

test("v7 presets' global grading is added to each range", () => {
  const payload = normalizeModulePreset('colorBalance', {
    version: 7,
    params: { saturation: [0.2, 0.25, 0, 0], chroma: [0.1, 0.2, 0.3] },
  });
  assert.deepEqual(payload.params, { saturation: [0.45, 0.2, 0.2], chroma: [0.1, 0.2, 0.3] });
});

test("lensfun's profile belongs to its photo: presets and styles keep the strengths", () => {
  const profile: LensfunProfile = {
    lens: 'Test 50mm f/2',
    cropFactor: 1,
    calibCropFactor: 1,
    calibAspectRatio: 1.5,
    focalLength: 50,
    distortion: { model: 'poly3', terms: [-0.01] },
  };
  const other: LensfunProfile = { ...profile, lens: 'Other 35mm f/1.4', focalLength: 35 };
  const source = updateModule(setLensProfile(defaultEditParams, 'lens', profile), 'lens', {
    params: { vignetting: 0.5 },
  });
  const lensParams = findModule(source, 'lens')!.params;
  assert.equal(lensParams.lensfun?.lens, 'Test 50mm f/2');
  assert.equal('lensfun' in modulePresetPayload('lens', lensParams, undefined).params, false);
  const style = styleFromRecipe(source, ['lens']);
  assert.equal('lensfun' in style.modules[0]!.params, false);

  // Applied onto a photo with its own profile, that profile stays; the strengths come.
  const target = setLensProfile(defaultEditParams, 'lens', other);
  const styled = findModule(applyStyle(target, style), 'lens')!.params;
  assert.deepEqual([styled.lensfun?.lens, styled.vignetting], ['Other 35mm f/1.4', 0.5]);
  const preset = findModule(
    applyModulePreset(target, 'lens', 'lens', modulePresetPayload('lens', lensParams, undefined)),
    'lens',
  )!;
  assert.deepEqual([preset.params.lensfun?.lens, preset.params.vignetting], ['Other 35mm f/1.4', 0.5]);

  // Back to the file's embedded data.
  assert.equal('lensfun' in findModule(setLensProfile(target, 'lens', null), 'lens')!.params, false);
});
