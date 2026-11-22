import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type SpotlightView, matchSlider, parseQuery, prefixMatches, wordsOf } from './spotlight.ts';

const modules = [
  { id: 'm1', kind: 'exposure', title: 'Exposure' },
  { id: 'm2', kind: 'colorCalibration', title: 'Color calibration' },
  { id: 'm3', kind: 'colorBalance', title: 'Color balance' },
  { id: 'm4', kind: 'filmic', title: 'Filmic' },
  { id: 'multipleExposure', kind: 'multipleExposure', title: 'Multiple exposure' },
];
const views: Record<string, SpotlightView[]> = {
  colorBalance: [
    { field: 'balance', value: 'master', labels: ['Master'], isDefault: true },
    { field: 'balance', value: 'mixer', labels: ['Mixer'] },
    { field: 'balance', value: 'settings', labels: ['Settings'] },
    { field: 'balanceRange', value: 'shadows', labels: ['Shadows'] },
  ],
  colorCalibration: [{ field: 'calibration', value: 'mixer', labels: ['Mixer'] }],
};
const top = (q: string) => {
  const [t] = parseQuery(q, modules, views);
  return t && [t.module.id, ...t.views.map((v) => v.value), t.rest].join(' ');
};

test('words are prefixes in order', () => {
  assert.deepEqual(wordsOf('Mid-tones range'), ['mid', 'tones', 'range']);
  assert.deepEqual([...prefixMatches('cb', ['color', 'balance']).keys()], [1, 2]);
  assert.equal(prefixMatches('bc', ['color', 'balance']).get(2), undefined);
});

test('a module, its tabs, then what is left for a slider', () => {
  assert.equal(top('exp'), 'm1 ');
  assert.equal(top('filcon'), 'm4 con');
  assert.equal(top('fito'), 'm4 to');
  assert.equal(top('cbm'), 'm3 mixer ');
  assert.equal(top('cbmix'), 'm3 mixer ');
  assert.equal(top('cbmb'), 'm3 mixer b');
  assert.equal(top('cbmsh'), 'm3 mixer shadows ');
  assert.equal(top('ccm'), 'm2 mixer ');
  assert.equal(top('mexp'), 'multipleExposure ');
  assert.equal(top('zzz'), undefined);
});

test('the slider is the one whose words the rest abbreviates', () => {
  const filmic = ['White relative exposure', 'Black relative exposure', 'Contrast', 'Toe', 'Shoulder'];
  assert.equal(matchSlider('', filmic), 0);
  assert.equal(matchSlider('con', filmic), 2);
  assert.equal(matchSlider('to', filmic), 3);
  assert.equal(matchSlider('bre', filmic), 1);
  assert.equal(matchSlider('x', filmic), null);
  assert.equal(matchSlider('b', ['Red hue', 'Red purity', 'Blue hue', 'Blue purity']), 2);
});
