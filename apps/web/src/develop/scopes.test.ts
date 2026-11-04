import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeScope, vectorscopePoint } from './scopes.ts';

/** A `width × height` RGBA8 image, coloured by `f(x, y)`. */
function image(width: number, height: number, f: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return data;
}

const pixel = (out: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(out.subarray((y * width + x) * 4, (y * width + x) * 4 + 3));
const lit = (out: Uint8ClampedArray, width: number, x: number, y: number) =>
  pixel(out, width, x, y).some((v) => v > 18);

test('waveform: a horizontal ramp of greys is a white diagonal', () => {
  const img = image(256, 10, (x) => [x, x, x]);
  const W = 64;
  const H = 32;
  const out = computeScope(img, 256, 10, { mode: 'waveform', width: W, height: H });
  // Left is black (bottom row), right is white (top row).
  assert.ok(lit(out, W, 0, H - 1));
  assert.ok(lit(out, W, W - 1, 0));
  assert.ok(!lit(out, W, 0, 0));
  assert.ok(!lit(out, W, W - 1, H - 1));
  const [r, g, b] = pixel(out, W, 0, H - 1);
  assert.ok(r! > 100 && Math.abs(r! - g!) < 8 && Math.abs(r! - b!) < 8, 'channels add up to white');
});

test('parade: each channel in its own third', () => {
  // Pure red: R at the top, G and B at the bottom.
  const img = image(30, 30, () => [255, 0, 0]);
  const W = 90;
  const H = 20;
  const out = computeScope(img, 30, 30, { mode: 'parade', width: W, height: H });
  assert.ok(lit(out, W, 10, 0), 'red third, top');
  assert.ok(!lit(out, W, 10, H - 1));
  assert.ok(lit(out, W, 40, H - 1), 'green third, bottom');
  assert.ok(!lit(out, W, 40, 0));
  assert.ok(lit(out, W, 70, H - 1), 'blue third, bottom');
});

test('vectorscope: greys in the centre, red up and to the left', () => {
  const S = 64;
  const grey = computeScope(
    image(20, 20, () => [128, 128, 128]),
    20,
    20,
    { mode: 'vectorscope', width: S, height: S },
  );
  assert.ok(lit(grey, S, S / 2, S / 2));
  assert.equal(
    grey.reduce((n, v, i) => n + (i % 4 === 0 && v > 18 ? 1 : 0), 0),
    1,
    'a single bin',
  );

  const red = computeScope(
    image(20, 20, () => [255, 0, 0]),
    20,
    20,
    { mode: 'vectorscope', width: S, height: S },
  );
  const [x, y] = vectorscopePoint(1, 0, 0, S);
  assert.ok(x < S / 2 && y < S / 2);
  assert.ok(lit(red, S, Math.round(x), Math.round(y)));
  const [r, g, b] = pixel(red, S, Math.round(x), Math.round(y));
  assert.ok(r! > g! && r! > b!, 'drawn in its own colour');
});

test('large images are sampled', () => {
  const img = image(2000, 1500, (x, y) => [x % 256, y % 256, 128]);
  const started = performance.now();
  const out = computeScope(img, 2000, 1500, { mode: 'waveform', width: 400, height: 200 });
  assert.equal(out.length, 400 * 200 * 4);
  assert.ok(performance.now() - started < 200);
});

test('vectorscope zoom: twice as far from the centre, saturated colours left out', () => {
  const S = 64;
  const [x1, y1] = vectorscopePoint(0.6, 0.5, 0.5, S);
  const [x2, y2] = vectorscopePoint(0.6, 0.5, 0.5, S, 2);
  assert.ok(Math.abs(x2 - S / 2 - 2 * (x1 - S / 2)) < 1e-9 && Math.abs(y2 - S / 2 - 2 * (y1 - S / 2)) < 1e-9);
  const pale = computeScope(
    image(20, 20, () => [153, 128, 128]),
    20,
    20,
    {
      mode: 'vectorscope',
      width: S,
      height: S,
      zoom: 2,
    },
  );
  const [px, py] = vectorscopePoint(153 / 255, 128 / 255, 128 / 255, S, 2);
  assert.ok(lit(pale, S, Math.round(px), Math.round(py)));
  const red = computeScope(
    image(20, 20, () => [255, 0, 0]),
    20,
    20,
    { mode: 'vectorscope', width: S, height: S, zoom: 2 },
  );
  assert.ok(!red.some((v, i) => i % 4 === 0 && v > 18), 'beyond the edge');
});
