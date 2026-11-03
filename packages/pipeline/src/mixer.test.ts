import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDENTITY_PRIMARIES,
  IDENTITY_WHITE_PRESERVING,
  mixerMatrix,
  mixerRows,
  mixerWhite,
  primariesFromMatrix,
  primariesToMatrix,
  roundtripError,
  whitePreservingFromMatrix,
  whitePreservingToMatrix,
  withoutWhiteShift,
} from './mixer.ts';
import { defaultModuleParams, fromWhiteBalance } from './params.ts';

const identity = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;
const near = (a: Record<string, number>, b: Record<string, number>, tol = 1e-6) =>
  Object.keys(b).forEach((k) => assert.ok(Math.abs(a[k]! - b[k]!) <= tol, `${k}: ${a[k]} vs ${b[k]}`));
const mulVec = (m: number[][], v: number[]) => m.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!);
const bases = (['cat16', 'linearBradford', 'xyz', 'none'] as const).map((adaptation) =>
  mixerWhite({ adaptation, illuminant: 'daylight' }),
);

test('the identity mix is the neutral position of both modes', () => {
  for (const white of bases) {
    const m = mixerMatrix(defaultModuleParams.colorCalibration);
    near(primariesFromMatrix(white, m)! as never, IDENTITY_PRIMARIES as never);
    near(whitePreservingFromMatrix(white, m)! as never, IDENTITY_WHITE_PRESERVING as never);
    assert.ok(roundtripError(primariesToMatrix(white, IDENTITY_PRIMARIES)!, identity as never) < 1e-9);
    assert.ok(roundtripError(whitePreservingToMatrix(white, IDENTITY_WHITE_PRESERVING)!, identity as never) < 1e-9);
  }
  assert.deepEqual(
    mixerWhite({ adaptation: 'none', illuminant: 'asShot' }),
    mixerWhite({ adaptation: 'cat16', illuminant: 'pipeline' }),
    'as shot is CAT16',
  );
});

test('primaries round-trip', () => {
  const p = {
    whiteHue: 40,
    whitePurity: 0.1,
    redHue: 12,
    redPurity: 0.8,
    greenHue: -20,
    greenPurity: 1.1,
    blueHue: 5,
    bluePurity: 0.9,
    gain: 1.2,
  };
  for (const white of bases) {
    const m = primariesToMatrix(white, p)!;
    near(primariesFromMatrix(white, m)! as never, p as never);
    // The basis white goes to a white of that hue and purity, scaled by the gain.
    const w = mulVec(m, white);
    assert.ok(Math.abs(w[0]! + w[1]! + w[2]! - 1.2 * (white[0] + white[1] + white[2])) < 1e-9);
  }
  // Warmth/tint migrated from v5 isn't white-preserving, but it is a set of primaries.
  const migrated = mixerMatrix(fromWhiteBalance([[0.4, 0.1]]));
  const white = bases[0]!;
  assert.ok(primariesFromMatrix(white, migrated));
  assert.equal(whitePreservingFromMatrix(white, migrated), null);
});

test('white-preserving primaries keep the white', () => {
  const p = {
    redRotation: 15,
    redSaturation: 0.3,
    greenRotation: -10,
    greenSaturation: -0.2,
    blueRotation: 0,
    blueSaturation: 0.5,
  };
  for (const white of bases) {
    const m = whitePreservingToMatrix(white, p)!;
    mulVec(m, white).forEach((c, i) => assert.ok(Math.abs(c - white[i]!) < 1e-9));
    near(whitePreservingFromMatrix(white, m)! as never, p as never);
  }
  // Collapsing two primaries onto the white is refused.
  assert.equal(whitePreservingToMatrix(bases[0]!, { ...p, redSaturation: -1, greenSaturation: -1 }), null);
});

test('mixer rows are rounded and not normalised', () => {
  const rows = mixerRows(primariesToMatrix(bases[0]!, { ...IDENTITY_PRIMARIES, redPurity: 0.5 })!);
  assert.equal(rows.normalizeRed, false);
  assert.ok(rows.red.every((v) => Math.round(v * 1e6) / 1e6 === v));
});

test('removing the white shift keeps the primaries', () => {
  for (const white of bases) {
    // A cast and a brightness change on top of white-preserving primaries: the columns
    // (primaries) keep their directions, but not the amounts that kept the white.
    const p = {
      redRotation: 10,
      redSaturation: 0.2,
      greenRotation: 0,
      greenSaturation: -0.1,
      blueRotation: -5,
      blueSaturation: 0,
    };
    const kept = whitePreservingToMatrix(white, p)!;
    const shifted = kept.map((row) => row.map((v, j) => v * [1.2, 1, 0.9][j]! * 1.1)) as typeof kept;
    assert.equal(whitePreservingFromMatrix(white, shifted), null);
    const clamped = withoutWhiteShift(white, shifted)!;
    mulVec(clamped, white).forEach((c, i) => assert.ok(Math.abs(c - white[i]!) < 1e-9));
    assert.ok(roundtripError(clamped, kept) < 1e-9, 'back to the white-preserving primaries');
    assert.ok(roundtripError(withoutWhiteShift(white, kept)!, kept) < 1e-9, 'already white-preserving: unchanged');
  }
  // Migrated warmth/tint (a gain per RGB channel) also moves the CAT16 primaries; those stay.
  const white = bases[0]!;
  const clamped = withoutWhiteShift(white, mixerMatrix(fromWhiteBalance([[0.4, 0.1]])))!;
  assert.ok(whitePreservingFromMatrix(white, clamped));
});
