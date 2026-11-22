import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODULE_KINDS } from '@rawtisserie/pipeline';
import { MODULE_TITLES } from './changes.ts';
import { SPOTLIGHT_SLIDERS, SPOTLIGHT_VIEWS } from './panelCatalog.ts';
import {
  type ControlIndex,
  type SpotlightSlider,
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
const staticSliders: Record<string, SpotlightSlider[]> = {
  exposure: [{ label: 'Exposure' }, { label: 'Black level' }],
  colorCalibration: [
    { label: 'Temperature', views: { calibration: 'illuminant' } },
    { label: 'Gamut compression', views: { calibration: 'illuminant' } },
    { label: 'Blue hue', views: { calibration: 'mixer', mixer: 'primaries' } },
  ],
  colorBalance: [
    { label: 'Hue shift', views: { balance: 'master' } },
    { label: 'Vibrance', views: { balance: 'master' } },
    { label: 'Shadows', group: 'Chroma', nth: 0, views: { balance: 'master' } },
    { label: 'Shadows', group: 'Saturation', nth: 1, views: { balance: 'master' } },
    { label: 'Temperature', views: { balance: 'mixer' } },
    { label: 'Blue hue', views: { balance: 'mixer', mixer: 'primaries' } },
    { label: 'Blue purity', views: { balance: 'mixer', mixer: 'primaries' } },
  ],
  filmic: ['White relative exposure', 'Contrast', 'Toe', 'Shoulder'].map((label) => ({ label })),
};
// Buttons and selects come from the page.
const index: ControlIndex = new Map([
  ['m4', new Map([['{}', { views: {}, controls: [{ kind: 'button' as const, label: 'Auto-tune filmic', nth: 0 }] }]])],
]);
const entries = buildEntries(modules, views, staticSliders, index);
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
  assert.equal(top('fiauto'), 'm4 Auto-tune filmic');
});

test('sliders known up front: on tabs never shown, and named by their group', () => {
  assert.equal(top('ccblue'), 'm2 mixer primaries Blue hue');
  assert.equal(top('ccbh'), 'm2 mixer primaries Blue hue');
  assert.equal(top('cbsatsh'), 'm3 master Shadows');
  const e = rankEntries('cbsatsh', entries)[0]!.entry;
  assert.deepEqual(e.control, { kind: 'slider', label: 'Shadows', nth: 1 });
  assert.deepEqual(rankEntries('cbchsh', entries)[0]!.entry.control, { kind: 'slider', label: 'Shadows', nth: 0 });
});

test('in the real catalogue, every slider typed out in full comes first', () => {
  const all = buildEntries(
    MODULE_KINDS.map((kind) => ({ id: kind, kind, title: MODULE_TITLES[kind] })),
    SPOTLIGHT_VIEWS as Record<string, SpotlightView[]>,
    SPOTLIGHT_SLIDERS as Record<string, SpotlightSlider[]>,
    new Map([
      [
        'exposure',
        new Map([['{}', { views: {}, controls: [{ kind: 'button' as const, label: 'Reset Exposure', nth: 0 }] }]]),
      ],
    ]),
  );
  const sliders = all.filter((e) => e.control?.kind === 'slider');
  assert.ok(sliders.length > 150, `${sliders.length} sliders`);
  const wrong = sliders.filter((e) => rankEntries(e.words.join(''), all)[0]?.entry !== e).map((e) => e.words.join(' '));
  assert.deepEqual(wrong, []);
});
