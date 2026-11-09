import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasPendingAutoTune, resolveAutoTunes } from './autoTune.ts';
import { defaultEditParams, findModule, normalizeEditParams, updateModule } from './params.ts';
import {
  BUILTIN_PRESETS,
  type ModulePresetPayload,
  applyModulePreset,
  applyStyle,
  modulePresetPayload,
  normalizeModulePreset,
  normalizeStyle,
  styleFromRecipe,
} from './presets.ts';

const lift = BUILTIN_PRESETS.find((p) => p.id === 'builtin:toneCurve:lift-shadows')!;

test('presets and styles mark the instances to auto-tune', () => {
  assert.equal(lift.payload.autoTune, true);
  const applied = applyModulePreset(
    defaultEditParams,
    'toneCurve',
    'toneCurve',
    lift.payload as ModulePresetPayload<'toneCurve'>,
  );
  assert.equal(findModule(applied, 'toneCurve')!.autoTune, true);
  assert.ok(hasPendingAutoTune(applied));
  assert.ok(!hasPendingAutoTune(defaultEditParams));

  // Saved, and read back; not on kinds without an auto-tune.
  const filmic = modulePresetPayload(
    'filmic',
    defaultEditParams.modules.at(-1)!.params as never,
    undefined,
    ['look'],
    undefined,
    true,
  );
  assert.equal(filmic.autoTune, true);
  assert.deepEqual(normalizeModulePreset('filmic', JSON.parse(JSON.stringify(filmic))), filmic);
  assert.equal(
    modulePresetPayload('exposure', { ev: 1, black: 0 }, undefined, undefined, undefined, true).autoTune,
    undefined,
  );
  assert.equal(normalizeModulePreset('exposure', { params: { ev: 1 }, autoTune: true }).autoTune, undefined);

  const style = styleFromRecipe(defaultEditParams, ['filmic', 'exposure'], {
    autoTune: { filmic: true, exposure: true },
  });
  assert.deepEqual(
    style.modules.map((m) => [m.kind, m.autoTune]),
    [
      ['exposure', undefined],
      ['filmic', true],
    ],
  );
  assert.deepEqual(normalizeStyle(JSON.parse(JSON.stringify(style))), style);
  assert.equal(findModule(applyStyle(defaultEditParams, style), 'filmic')!.autoTune, true);
  // Also a partial instance.
  const partial = styleFromRecipe(defaultEditParams, ['filmic'], {
    groups: { filmic: ['look'] },
    autoTune: { filmic: true },
  });
  assert.equal(findModule(applyStyle(defaultEditParams, partial), 'filmic')!.autoTune, true);
  // The mark survives a round trip through JSON and normalising.
  assert.deepEqual(normalizeEditParams(JSON.parse(JSON.stringify(applied))), applied);
});

test('auto-tunes resolve in pipeline order, and clear their marks', async () => {
  let recipe = applyModulePreset(
    defaultEditParams,
    'toneCurve',
    'toneCurve',
    lift.payload as ModulePresetPayload<'toneCurve'>,
  );
  recipe = updateModule(recipe, 'filmic', {});
  recipe = {
    ...recipe,
    modules: recipe.modules.map((m) => (m.kind === 'filmic' ? { ...m, autoTune: true as const } : m)),
  };
  const calls: string[] = [];
  const resolved = await resolveAutoTunes(recipe, {
    toneFit: (r, id) => {
      calls.push(`tone ${id} ${hasPendingAutoTune(r)}`);
      return [-4.83, 2.06];
    },
    filmic: (r) => {
      // Measured after the tone curve was fitted.
      calls.push(`filmic ${findModule(r, 'toneCurve')!.params.range.join(',')}`);
      return Promise.resolve([3.456, -6.789]);
    },
  });
  assert.deepEqual(calls, ['tone toneCurve true', 'filmic -4.8,2.1']);
  assert.ok(!hasPendingAutoTune(resolved));
  assert.deepEqual(findModule(resolved, 'toneCurve')!.params.range, [-4.8, 2.1]);
  assert.equal(findModule(resolved, 'filmic')!.params.whiteExposure, 3.46);
  assert.equal(findModule(resolved, 'filmic')!.params.blackExposure, -6.79);
  assert.deepEqual(normalizeEditParams(JSON.parse(JSON.stringify(resolved))), resolved);

  // Nothing to measure: the mark goes, the values stay.
  const blank = await resolveAutoTunes(recipe, { toneFit: () => null, filmic: () => null });
  assert.ok(!hasPendingAutoTune(blank));
  assert.deepEqual(findModule(blank, 'filmic')!.params, findModule(recipe, 'filmic')!.params);
});
