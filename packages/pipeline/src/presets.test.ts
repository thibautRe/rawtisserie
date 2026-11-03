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
  type ModuleKind,
} from './params.ts';
import {
  BUILTIN_PRESETS,
  PRESET_GROUPS,
  applyModulePreset,
  applyStyle,
  normalizeModulePreset,
  normalizeStyle,
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
  const applied = findModule(applyModulePreset(other, 'colorCalibration', id, mixer), 'colorCalibration')!.params;
  assert.equal(applied.temperature, 7000);
  assert.deepEqual(applied.red, [1.2, -0.1, -0.1]);
});

test('applying a preset to a kind without an instance adds one, switched on', () => {
  const p = applyModulePreset(defaultEditParams, 'sharpen', 'sharpen', { amount: 0.8 });
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
  let source = updateModule(defaultEditParams, 'color', { params: { saturation: -1 } });
  source = updateModule(source, 'filmic', { params: { contrast: 1.6 } });
  source = updateInstance(source, 'color', 'color', { label: 'mono' });
  const style = styleFromRecipe(source, ['color', 'filmic']);
  assert.deepEqual(
    style.modules.map((m) => m.kind),
    ['color', 'filmic'],
  );
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);

  let target = updateModule(defaultEditParams, 'color', { params: { vibrance: 0.5 } });
  target = updateModule(target, 'filmic', { params: { contrast: 1 } });

  const replaced = applyStyle(target, style, 'replace');
  assert.deepEqual(
    replaced.modules.map((m) => [m.id, m.kind]),
    [
      ['exposure', 'exposure'],
      ['colorCalibration', 'colorCalibration'],
      ['color', 'color'],
      ['filmic', 'filmic'],
    ],
  );
  assert.deepEqual(findModule(replaced, 'color')!.params, { saturation: -1, vibrance: 0 });
  assert.equal(findModule(replaced, 'color')!.label, 'mono');
  assert.equal(findModule(replaced, 'filmic')!.params.contrast, 1.6);

  const appended = applyStyle(target, style, 'append');
  const colors = appended.modules.filter((m) => m.kind === 'color');
  assert.deepEqual(
    colors.map((m) => [m.id, m.params]),
    [
      ['color', { saturation: 0, vibrance: 0.5 }],
      ['color-2', { saturation: -1, vibrance: 0 }],
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
