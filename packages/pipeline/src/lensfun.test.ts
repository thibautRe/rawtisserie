import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type LensfunDb, type LensfunLens, Lensfun, fuzzyScore, fuzzyWords } from './lensfun.ts';
import { initPipeline, normalizeParams } from './node.ts';
import { normalizeEditParams } from './params.ts';

const db = JSON.parse(readFileSync(new URL('../lensfun/lensfun.json', import.meta.url), 'utf8')) as LensfunDb;
const lensfun = new Lensfun(db);

test('names split into words as lensfun splits them', () => {
  assert.deepEqual(fuzzyWords('Sony FE 24-105mm f/4 G OSS'), ['105', '24', '4', 'fe', 'g', 'mm', 'oss', 'sony']);
  // ".0" goes, a lone "f" or symbol isn't a word, "+" is.
  assert.deepEqual(fuzzyWords('Zeiss 50mm F2.0 +'), ['+', '2', '50', 'mm', 'zeiss']);
  assert.deepEqual(fuzzyWords('XF35mmF2 R WR'), ['2', '35', 'mmf', 'r', 'wr', 'xf']);
});

test('every word of the pattern must be in a strict match', () => {
  const pattern = fuzzyWords('FE 24-105mm F4 G OSS');
  assert.equal(fuzzyScore(pattern, fuzzyWords('Sony FE 24-105mm f/4 G OSS'), true), Math.trunc((7 * 200) / 15));
  assert.equal(fuzzyScore(pattern, fuzzyWords('Sony FE 24-105mm f/4 G'), true), 0);
  assert.ok(fuzzyScore(pattern, fuzzyWords('Sony FE 24-105mm f/4 G'), false) > 0);
});

/** Golden RAWs' metadata (`crates/pipeline/tests/golden/raws`) and the lenses they get. */
const shots = [
  ['Canon', 'EOS R6', 'RF 70-200mm F2.8L IS USM', 'Canon EOS R6', 'Canon RF 70-200mm F2.8L IS USM'],
  ['Fujifilm', 'X-T30', 'XF35mmF2 R WR', 'X-T30', 'XF35mmF2 R WR'],
  ['Leica', 'M10', 'Summicron-M 1:2/35 ASPH.', 'Leica M10', 'Summicron-M 1:2/35 Asph.'],
  ['Nikon', 'Z 6', 'Nikkor Z 24-70mm f/4 S', 'Nikon Z 6', 'Nikkor Z 24-70mm f/4 S'],
  ['Panasonic', 'DC-GX9', 'G 25mm F1.7 Asph.', 'DC-GX9', 'Lumix G 25mm f/1.7 Asph.'],
  ['Sony', 'ILCE-7M3', 'FE 16-35mm F2.8 GM', 'ILCE-7M3', 'FE 16-35mm f/2.8 GM'],
  ['Sony', 'ILCE-7RM3A', 'FE 24-105mm F4 G OSS', 'ILCE-7RM3A', 'FE 24-105mm f/4 G OSS'],
] as const;

test("golden RAWs' cameras and lenses are found", () => {
  for (const [make, model, lensModel, camera, lens] of shots) {
    const m = lensfun.match({ make, model, lensModel, focalLength: 35, fNumber: 4 });
    assert.equal(m.camera?.model[0], camera, `${make} ${model}`);
    assert.equal(m.lens?.model[0], lens, lensModel);
    assert.equal(m.profile?.lens, lens);
  }
  // Names lensfun doesn't have, or none.
  assert.equal(
    lensfun.match({ make: 'Sony', model: 'ILCE-7M3', lensModel: '----', focalLength: 35, fNumber: 2 }).lens,
    null,
  );
  assert.equal(
    lensfun.match({ make: 'Sony', model: 'ILCE-7M3', lensModel: null, focalLength: 35, fNumber: 2 }).profile,
    null,
  );
});

test('cameras are found by rawler’s names, then fuzzily', () => {
  assert.equal(lensfun.findCamera('Nikon', 'Z 6')?.exact, true);
  // Not a camera rawler names this way: lensfun's maker is "Nikon Corporation".
  const fuzzy = lensfun.findCamera('nikon', 'nikon z 6');
  assert.equal(fuzzy?.camera.model[0], 'Nikon Z 6');
  assert.equal(lensfun.findCamera(null, 'Z 6'), null);
});

const lens = (l: Partial<LensfunLens>): LensfunLens => ({
  maker: ['Test'],
  model: ['Test 10-40mm f/2'],
  mounts: ['Generic'],
  crop: 1,
  ...l,
});

test('distortion and TCA are interpolated by focal length, as lensfun does', () => {
  // Terms that go as 1/f are interpolated as f · term.
  const l = lens({
    distortion: [
      [10, 'poly3', -0.04],
      [20, 'poly3', -0.02],
      [30, 'poly3', -0.01],
      [40, 'poly3', 0],
    ],
    tca: [
      [10, 'linear', 1.001, 0.999],
      [40, 'linear', 1.002, 0.998],
    ],
  });
  const at = (focal: number) => lensfun.profile(l, 1, { focalLength: focal, fNumber: null })!;
  assert.deepEqual(at(20).distortion, { model: 'poly3', terms: [-0.02] });
  // Between 20 and 30, with 10 and 40 around: lensfun's Hermite spline of f·k1 (-0.4, -0.4, -0.3, 0).
  const t = 0.5;
  const [y1, y2, y3, y4] = [-0.4, -0.4, -0.3, 0];
  const h = (2 * t ** 3 - 3 * t ** 2 + 1) * y2 + (t ** 3 - 2 * t ** 2 + t) * ((y3 - y1) / 2);
  const expected = (h + (-2 * t ** 3 + 3 * t ** 2) * y3 + (t ** 3 - t ** 2) * ((y4 - y2) / 2)) / 25;
  assert.ok(Math.abs(at(25).distortion!.terms[0]! - expected) < 1e-7);
  // Linear TCA's terms aren't scaled: halfway is halfway.
  const tca = at(25).tca!.terms;
  assert.ok(Math.abs(tca[0]! - 1.0015) < 1e-7 && Math.abs(tca[1]! - 0.9985) < 1e-7, `${tca}`);
  // Outside the calibrated range: the nearest calibration.
  assert.deepEqual(at(50).distortion, { model: 'poly3', terms: [0] });
});

test('vignetting is weighted by distance in focal length, aperture and focus distance', () => {
  const l = lens({
    vignetting: [
      [10, 2, 1000, -0.4, 0.1, 0],
      [10, 4, 1000, -0.2, 0.05, 0],
    ],
  });
  const at = (fNumber: number) => lensfun.profile(l, 1, { focalLength: 10, fNumber })!.vignetting;
  assert.deepEqual(at(2), [-0.4, 0.1, 0]);
  // f/2.67 is as far from both on the reciprocal aperture axis (4/2 − 4/2.67 = 4/2.67 − 4/4).
  const mid = at(8 / 3)!;
  assert.ok(Math.abs(mid[0] + 0.3) < 1e-6 && Math.abs(mid[1] - 0.075) < 1e-6, `${mid}`);
  // Without an aperture, no vignetting (and nothing else here).
  assert.equal(lensfun.profile(l, 1, { focalLength: 10, fNumber: null }), null);
});

test('a calibration on a smaller sensor than the camera’s is not used', () => {
  const l = lens({ crop: 1.5, distortion: [[10, 'poly3', -0.02]] });
  assert.equal(lensfun.profile(l, 1, { focalLength: 10, fNumber: 2 }), null);
  assert.equal(lensfun.profile(l, 1.6, { focalLength: 10, fNumber: 2 })?.cropFactor, 1.6);
  // An unknown camera: the calibration's sensor.
  assert.equal(lensfun.profile(l, null, { focalLength: 10, fNumber: 2 })?.cropFactor, 1.5);
});

test('Rust reads a matched profile back unchanged', () => {
  initPipeline();
  for (const [make, model, lensModel] of shots) {
    const { profile } = lensfun.match({ make, model, lensModel, focalLength: 50, fNumber: 5.6 });
    const recipe = { version: 8, modules: [{ id: 'lens', kind: 'lens', enabled: true, params: { lensfun: profile } }] };
    assert.deepEqual(JSON.parse(normalizeParams(JSON.stringify(recipe))), normalizeEditParams(recipe), lensModel);
  }
});
