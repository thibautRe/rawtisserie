import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sorting, defaultSorting, planCollections } from './importCollections.ts';
import type { PickedFile } from './pickedFiles.ts';

const file = (path: string): PickedFile => ({ path, file: new File([], path.split('/').at(-1)!) });
const card = [
  file('DCIM/100MSDCF/DSC1.ARW'),
  file('DCIM/100MSDCF/DSC2.ARW'),
  file('DCIM/100MSDCF/DSC3.ARW'),
  file('DCIM/101MSDCF/DSC4.ARW'),
  file('DCIM/101MSDCF/DSC5.ARW'),
];
// A night out across midnight, then the next afternoon, then the next evening.
const times = new Map(
  card.map((f, i) => [
    f,
    ['2026-11-09T22:10:00', '2026-11-10T01:30:00', '2026-11-10T14:00:00', '2026-11-10T21:00:00', '2026-11-12T09:00:00'][
      i
    ]!,
  ]),
);
const sorting = (s: Partial<Sorting>): Sorting => ({ ...defaultSorting(card), ...s });
const paths = (s: Partial<Sorting>) =>
  card.map((f) => planCollections(card, times, sorting(s)).of.get(f)?.join(' › ') ?? null);

test('a card is sorted by day; folders someone made are kept', () => {
  assert.equal(defaultSorting(card).mode, 'day');
  assert.equal(defaultSorting([file('Trips/Japan/Kyoto/a.NEF')]).mode, 'folders');
  assert.equal(defaultSorting([file('a.NEF')]).mode, 'day');
});

test('by day, under a year if asked, with names given in the review', () => {
  assert.deepEqual(paths({ mode: 'day' }), ['2026-11-09', '2026-11-10', '2026-11-10', '2026-11-10', '2026-11-12']);
  assert.deepEqual(paths({ mode: 'day', byYear: true, names: { 'day:2026-11-10': 'Wedding' } }), [
    '2026 › 2026-11-09',
    '2026 › Wedding',
    '2026 › Wedding',
    '2026 › Wedding',
    '2026 › 2026-11-12',
  ]);
  const plan = planCollections(card, times, sorting({ mode: 'day' }));
  // Newest first, with their counts and spans.
  assert.deepEqual(
    plan.groups.map((g) => [g.path.join(), g.files, g.from, g.to]),
    [
      ['2026-11-12', 1, '2026-11-12T09:00:00', '2026-11-12T09:00:00'],
      ['2026-11-10', 3, '2026-11-10T01:30:00', '2026-11-10T21:00:00'],
      ['2026-11-09', 1, '2026-11-09T22:10:00', '2026-11-09T22:10:00'],
    ],
  );
});

test('by shoot: a night out stays together, a second shoot the same day gets a number', () => {
  assert.deepEqual(paths({ mode: 'gap', gapHours: 4 }), [
    '2026-11-09',
    '2026-11-09',
    '2026-11-10',
    '2026-11-10 (2)',
    '2026-11-12',
  ]);
  // Wide enough, one shoot for the night and the next day.
  assert.deepEqual(paths({ mode: 'gap', gapHours: 13 }).slice(0, 4), Array(4).fill('2026-11-09'));
});

test('folders as they are, all in one, or none', () => {
  assert.deepEqual(paths({ mode: 'folders' }), [
    'DCIM › 100MSDCF',
    'DCIM › 100MSDCF',
    'DCIM › 100MSDCF',
    'DCIM › 101MSDCF',
    'DCIM › 101MSDCF',
  ]);
  assert.deepEqual(paths({ mode: 'one', one: ['Trips', 'Japan'] }), Array(5).fill('Trips › Japan'));
  assert.deepEqual(paths({ mode: 'one', one: [] }), Array(5).fill(null));
  assert.deepEqual(paths({ mode: 'none' }), Array(5).fill(null));
  // Files without a folder: none.
  assert.equal(planCollections([file('a.ARW')], new Map(), sorting({ mode: 'folders' })).of.size, 0);
});

test('`|` in a folder or a name becomes `-` (it may separate levels one day)', () => {
  const f = file('Trips/Japan | Kyoto/a.NEF');
  assert.deepEqual(planCollections([f], new Map(), sorting({ mode: 'folders' })).of.get(f), ['Trips', 'Japan - Kyoto']);
  const named = sorting({ mode: 'day', names: { 'day:2026-11-09': 'Party|Night' } });
  assert.equal(planCollections(card, times, named).of.get(card[0]!)?.join(), 'Party-Night');
});
