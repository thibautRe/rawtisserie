import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WHITE_XY,
  blackBodyXy,
  closestIlluminant,
  daylightXy,
  hueChromaToXy,
  illuminantFromXy,
  illuminantXy,
  switchIlluminant,
  xyToCct,
  xyToHueChroma,
} from './illuminants.ts';
import { defaultModuleParams } from './params.ts';

const near = (a: number, b: number, tol: number, what = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b}`);

test('temperatures', () => {
  near(xyToCct(...WHITE_XY), 6504, 15, 'D65');
  near(xyToCct(...blackBodyXy(2856)!), 2856, 10, 'A');
  near(xyToCct(...daylightXy(5000)!), 5000, 15, 'D50');
  assert.deepEqual(closestIlluminant(daylightXy(5500)!).illuminant, 'daylight');
  assert.deepEqual(closestIlluminant(blackBodyXy(4500)!).illuminant, 'blackBody');
  // Below 4000 K, daylight is the black body: Ansel calls it daylight.
  assert.deepEqual(closestIlluminant(blackBodyXy(2500)!).illuminant, 'daylight');
  assert.deepEqual(closestIlluminant([0.33, 0.4]).illuminant, 'custom');
});

test('hue and chroma round-trip, around the white', () => {
  assert.equal(xyToHueChroma(WHITE_XY).chroma, 0);
  const xy = blackBodyXy(3000)!;
  const { hue, chroma } = xyToHueChroma(xy);
  const back = hueChromaToXy(hue, chroma);
  near(back[0], xy[0], 1e-9);
  near(back[1], xy[1], 1e-9);
});

test('switching illuminants starts from the current light', () => {
  const asShot: [number, number] = [0.4, 0.39];
  const p = defaultModuleParams.colorCalibration;
  const daylight = switchIlluminant(p, 'daylight', asShot);
  assert.equal(daylight.adaptation, 'cat16');
  near(daylight.temperature!, xyToCct(...asShot), 1);
  assert.deepEqual(switchIlluminant(p, 'custom', asShot), {
    illuminant: 'custom',
    adaptation: 'cat16',
    x: 0.4,
    y: 0.39,
  });
  // Between temperature illuminants, the temperature stays.
  const warm = { ...p, illuminant: 'daylight' as const, temperature: 4500 };
  assert.deepEqual(switchIlluminant(warm, 'blackBody', asShot), { illuminant: 'blackBody' });
  const custom = switchIlluminant(warm, 'custom', asShot);
  near(custom.x!, daylightXy(4500)![0], 1e-4);
  assert.deepEqual(illuminantXy({ ...p, ...custom }, asShot), [custom.x, custom.y]);
});

test('detected lights become daylight, black body or custom', () => {
  const d = illuminantFromXy(daylightXy(5200)!);
  assert.equal(d.illuminant, 'daylight');
  near(d.temperature!, 5200, 15);
  assert.equal(illuminantFromXy([0.3, 0.36]).illuminant, 'custom');
});
