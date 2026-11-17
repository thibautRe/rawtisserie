import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SampleStore, formatEv, lch, marked } from './picker.ts';

const near = (a: number, b: number, d = 0.05) => assert.ok(Math.abs(a - b) <= d, `${a} ≉ ${b}`);

test('LCh of known sRGB colours', () => {
  const white = lch([255, 255, 255]);
  near(white.l, 100, 0.01);
  near(white.c, 0, 0.01);
  assert.equal(white.h, 0);
  near(lch([0, 0, 0]).l, 0, 0.01);
  near(lch([119, 119, 119]).l, 50.0, 0.3);
  // sRGB red: L 53.24, C 104.55, h 40.0 (CIE Lab D65).
  const red = lch([255, 0, 0]);
  near(red.l, 53.24, 0.05);
  near(red.c, 104.55, 0.1);
  near(red.h, 40.0, 0.1);
});

test('EV is signed with a real minus', () => {
  assert.equal(formatEv(0.83), '+0.8 EV');
  assert.equal(formatEv(-2.26), '−2.3 EV');
  assert.equal(formatEv(-0.01), '0.0 EV');
});

test('the store tells its listeners', () => {
  const store = new SampleStore();
  let told = 0;
  const off = store.subscribe(() => told++);
  const pixel = {
    at: [0.5, 0.5] as [number, number],
    display: [1, 2, 3] as [number, number, number],
    scene: [0, 0, 0] as [number, number, number],
    sceneEv: 0,
    reads: [],
  };
  store.set(pixel, [null, pixel]);
  assert.equal(told, 1);
  assert.deepEqual(store.get().hover?.display, [1, 2, 3]);
  // Pins numbered from 1 (a pin outside the render has none), the pointer's last.
  assert.deepEqual(
    marked(store.get()).map((m) => m.pin),
    [2, undefined],
  );
  off();
  store.set(null);
  assert.equal(told, 1);
});
