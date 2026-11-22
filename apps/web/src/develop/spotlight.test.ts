import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ControlIndex,
  type ShownControls,
  type SpotlightView,
  abbreviationScore,
  buildEntries,
  rankEntries,
  wordsOf,
} from './spotlight.ts';

const modules = [
  { id: 'm1', kind: 'exposure', title: 'Exposure' },
  { id: 'm2', kind: 'colorCalibration', title: 'Color calibration' },
  { id: 'm3', kind: 'colorBalance', title: 'Color balance' },
  { id: 'm4', kind: 'filmic', title: 'Filmic' },
  { id: 'toneCurve', kind: 'toneCurve', title: 'Tones' },
  { id: 'multipleExposure', kind: 'multipleExposure', title: 'Multiple exposure' },
];
const mixerViews: SpotlightView[] = [
  { field: 'mixer', value: 'primaries', labels: ['Primaries'], isDefault: true },
  { field: 'mixer', value: 'channels', labels: ['Channels'] },
];
const views: Record<string, SpotlightView[]> = {
  colorBalance: [
    { field: 'balance', value: 'master', labels: ['Master'], isDefault: true },
    { field: 'balance', value: 'mixer', labels: ['Mixer'] },
    { field: 'balance', value: 'settings', labels: ['Settings'] },
    ...mixerViews.map((v) => ({ ...v, under: { field: 'balance', value: 'mixer' } })),
  ],
  colorCalibration: [
    { field: 'calibration', value: 'illuminant', labels: ['CAT', 'White balance'], isDefault: true },
    { field: 'calibration', value: 'mixer', labels: ['Mixer'] },
    ...mixerViews.map((v) => ({ ...v, under: { field: 'calibration', value: 'mixer' } })),
  ],
};
const sliders = (views: Record<string, string>, ...labels: string[]): [string, ShownControls] => [
  JSON.stringify(views),
  { views, controls: labels.map((label) => ({ kind: 'slider' as const, label, nth: 0 })) },
];
const index: ControlIndex = new Map([
  ['m1', new Map([sliders({}, 'Exposure', 'Black level')])],
  ['m2', new Map([sliders({ calibration: 'illuminant', mixer: 'primaries' }, 'Temperature', 'Gamut compression')])],
  [
    'm3',
    new Map([
      sliders({ balance: 'master', mixer: 'primaries' }, 'Hue shift', 'Vibrance'),
      sliders({ balance: 'mixer', mixer: 'primaries' }, 'Temperature', 'Blue hue', 'Blue purity'),
    ]),
  ],
  ['m4', new Map([sliders({}, 'White relative exposure', 'Contrast', 'Toe', 'Shoulder')])],
]);
const entries = buildEntries(modules, views, index);
const top = (q: string) => {
  const e = rankEntries(q, entries)[0]?.entry;
  return e && [e.module.id, ...e.views.map((v) => v.value), e.control?.label ?? ''].join(' ').trim();
};

test('words are prefixes in order, skipping some', () => {
  assert.deepEqual(wordsOf('Mid-tones range'), ['mid', 'tones', 'range']);
  assert.notEqual(abbreviationScore('cb', ['color', 'balance']), null);
  assert.equal(abbreviationScore('bc', ['color', 'balance']), null);
  assert.notEqual(abbreviationScore('temp', ['color', 'calibration', 'temperature']), null);
});

test('a module, a tab, or a control', () => {
  assert.equal(top('exp'), 'm1');
  assert.equal(top('expbl'), 'm1 Black level');
  assert.equal(top('filcon'), 'm4 Contrast');
  assert.equal(top('fito'), 'm4 Toe');
  assert.equal(top('cbm'), 'm3 mixer');
  assert.equal(top('cbmix'), 'm3 mixer');
  assert.equal(top('cbmb'), 'm3 mixer primaries Blue hue');
  assert.equal(top('cbmch'), 'm3 mixer channels');
  assert.equal(top('ccmix'), 'm2 mixer');
  assert.equal(top('ccwb'), 'm2 illuminant');
  assert.equal(top('mexp'), 'multipleExposure');
  assert.equal(top('zzz'), undefined);
});

test('a control without its module, the nearest first', () => {
  // Calibration's has one word to skip less than colour balance's mixer one.
  assert.equal(top('temperature'), 'm2 illuminant Temperature');
  assert.equal(top('temp'), 'm2 illuminant Temperature');
  assert.deepEqual(
    rankEntries('temp', entries)
      .slice(0, 2)
      .map((m) => m.entry.module.id),
    ['m2', 'm3'],
  );
  assert.equal(top('vib'), 'm3 master Vibrance');
});
