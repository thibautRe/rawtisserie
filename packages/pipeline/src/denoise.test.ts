import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denoiseKeyName } from './denoise.ts';
import { type ModuleParams, defaultRecipe, updateModule } from './params.ts';
import { denoiseKeyNameWasm, initPipeline } from './node.ts';

test('denoised photos are named as Rust names them', () => {
  initPipeline();
  const plain = defaultRecipe({});
  assert.equal(denoiseKeyName(plain), null);
  assert.equal(denoiseKeyNameWasm(JSON.stringify(plain)), undefined);
  const changes: Partial<ModuleParams['rawDenoise']>[] = [
    {},
    { strength: 0.3 },
    { noiseLevel: 1.1, corrections: [3.1, 0.7, 2.25] },
    { strength: 1.5 },
    { model: { version: 1, size: 'large', variant: 'single' } },
  ];
  for (const params of changes) {
    const p = updateModule(plain, 'rawDenoise', { params });
    assert.notEqual(denoiseKeyName(p), null);
    assert.equal(denoiseKeyName(p), denoiseKeyNameWasm(JSON.stringify(p)), JSON.stringify(params));
  }
  assert.equal(denoiseKeyName(updateModule(plain, 'rawDenoise', { params: { strength: 0 } })), null);
  assert.equal(denoiseKeyName(updateModule(plain, 'rawDenoise', { enabled: false })), null);
});
