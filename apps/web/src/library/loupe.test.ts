import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Photo, ZoomInfo } from '@rawtisserie/api';
import type { ZoomLayout } from '../develop/zoom.ts';
import { advancesOn, loupeOrder, tileLevel, tileUrl, visibleTiles } from './loupe.ts';

const info: ZoomInfo = {
  key: '3',
  tileSize: 512,
  levels: [
    { width: 6000, height: 4000 },
    { width: 3000, height: 2000 },
  ],
  focus: null,
};

// The 6000×4000 photo fitted in 1200×800 CSS pixels at dpr 1, in a 1400×900 window.
const layout: ZoomLayout = {
  windowWidth: 1400,
  windowHeight: 900,
  fitWidth: 1200,
  fitHeight: 800,
  fitScale: 0.2,
  sourceWidth: 6000,
  sourceHeight: 4000,
  dpr: 1,
};

test('the loupe keeps the photos it opened with, in order, and adds later pages', () => {
  const photo = (id: string) => ({ id }) as Photo;
  const opened = ['a', 'b', 'c'];
  // 'b' was rated out of the filter, 'd' and 'e' came with the next page.
  assert.deepEqual(loupeOrder(opened, ['a', 'c', 'd', 'e'].map(photo)), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(loupeOrder(opened, ['c', 'a'].map(photo)), opened);
});

test('ratings and flags advance, colour labels do not', () => {
  assert.ok(advancesOn({ rating: 0 }));
  assert.ok(advancesOn({ flag: null }));
  assert.ok(!advancesOn({ colorLabel: 'red' }));
});

test('tiles come in when the preview is too coarse, at the coarsest level fine enough', () => {
  assert.equal(tileLevel(info, 0.2, 2048), null);
  assert.equal(tileLevel(info, 2048 / 6000, 2048), null);
  assert.equal(tileLevel(info, 0.4, 2048), 1);
  assert.equal(tileLevel(info, 0.5, 2048), 1);
  assert.equal(tileLevel(info, 0.6, 2048), 0);
  // Beyond 100 %, full-resolution tiles are enlarged.
  assert.equal(tileLevel(info, 4, 2048), 0);
});

test('the visible tiles at 100 % cover the window, nearest the centre first', () => {
  // At 100 %, centred: the window shows image pixels 2300…3700 × 1550…2450.
  const tiles = visibleTiles(info, 0, layout, { scale: 1, cx: 0.5, cy: 0.5 });
  const cols = [...new Set(tiles.map((t) => t.col))].sort((a, b) => a - b);
  const rows = [...new Set(tiles.map((t) => t.row))].sort((a, b) => a - b);
  // With half a tile of margin: 2044…3956 and 1294…2706.
  assert.deepEqual(cols, [3, 4, 5, 6, 7]);
  assert.deepEqual(rows, [2, 3, 4, 5]);
  assert.equal(tiles.length, 20);
  // The centre (3000, 2000) is in tile (5, 3).
  assert.deepEqual([tiles[0]!.col, tiles[0]!.row], [5, 3]);
  assert.equal(tiles[0]!.left, 2560 / 6000);
  assert.equal(tiles[0]!.width, 512 / 6000);
});

test('edge tiles are cut to the image', () => {
  const tiles = visibleTiles(info, 0, layout, { scale: 1, cx: 1, cy: 1 });
  const corner = tiles.find((t) => t.col === 11 && t.row === 7);
  assert.ok(corner);
  assert.equal(corner.width, (6000 - 11 * 512) / 6000);
  assert.equal(corner.height, (4000 - 7 * 512) / 4000);
  assert.ok(tiles.every((t) => t.col <= 11 && t.row <= 7));
});

test('tile URLs carry the recipe revision', () => {
  assert.equal(tileUrl('v1', info, { level: 1, col: 2, row: 0 }), '/api/versions/v1/zoom/1/2/0?k=3');
});
