import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ModulePreset,
  type Style,
  defaultEditParams,
  findModule,
  styleFromRecipe,
  updateModule,
} from '@rawtisserie/pipeline';
import { appendChange, presetEdit, styleEdit } from './batchEdit.ts';

const preset: ModulePreset = {
  id: 'p',
  name: 'Bright',
  builtIn: false,
  type: 'module',
  moduleKind: 'exposure',
  payload: { version: 6, params: { ev: 2 } },
};

test('a preset is appended after the current entry, dropping undone ones', () => {
  const change = appendChange({ id: 'v', historyEnd: 2, revision: 7, recipe: defaultEditParams }, presetEdit(preset));
  assert.ok(change);
  assert.equal(change.baseRevision, 7);
  const [op] = change.ops;
  assert.ok(op?.type === 'splice');
  assert.equal(op.from, 3);
  assert.equal(op.end, 3);
  assert.equal(op.entries[0]!.label, 'Exposure: preset Bright');
  assert.equal(findModule(op.entries[0]!.recipe, 'exposure')!.params.ev, 2);
});

test('a module preset adds its module when the recipe has none', () => {
  const sharpen: ModulePreset = { ...preset, moduleKind: 'sharpen', payload: { version: 6, params: { amount: 1 } } };
  const change = appendChange({ id: 'v', historyEnd: 0, revision: 0, recipe: defaultEditParams }, presetEdit(sharpen));
  const op = change?.ops[0];
  assert.ok(op?.type === 'splice');
  assert.equal(findModule(op.entries[0]!.recipe, 'sharpen')?.enabled, true);
});

test('nothing is appended when the recipe already has it', () => {
  const recipe = updateModule(defaultEditParams, 'exposure', { params: { ev: 2 } });
  assert.equal(appendChange({ id: 'v', historyEnd: 1, revision: 1, recipe }, presetEdit(preset)), null);
});

test('styles replace, or append everything with Shift', () => {
  const source = updateModule(defaultEditParams, 'exposure', { params: { ev: 1 } });
  const style: Style = {
    id: 's',
    name: 'Look',
    builtIn: false,
    type: 'style',
    moduleKind: null,
    payload: styleFromRecipe(source, [findModule(source, 'exposure')!.id]),
  };
  const exposures = (appendAll: boolean) => {
    const op = appendChange(
      { id: 'v', historyEnd: 0, revision: 0, recipe: defaultEditParams },
      styleEdit(style, appendAll),
    )?.ops[0];
    assert.ok(op?.type === 'splice');
    return op.entries[0]!.recipe.modules.filter((m) => m.kind === 'exposure').length;
  };
  assert.equal(exposures(false), 1);
  assert.equal(exposures(true), 2);
  assert.equal(styleEdit(style, true).label, 'Style: Look (appended)');
});
