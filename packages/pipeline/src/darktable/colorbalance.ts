/**
 * darktable's and Ansel's colour balance rgb (`colorbalancergb.c`, v5, the same struct
 * in both) as our colour balance, whose master tab is a port of Ansel's: hue shift,
 * vibrance, and chroma, saturation and brilliance per range.
 *
 * Our ranges add up to 1 (`toneRangeWeights`), theirs overlap: their global setting
 * and each range's add up (as our v7 migration folds global in). Their mask's grey
 * fulcrum moves ours; the weights that shape their masks aren't carried over.
 *
 * Their 4 ways work per channel in Filmlight's grading RGB: a global offset, then
 * shadows and highlights gains, then a mid-tones power. Our split-toning mixers are 3×3
 * matrices in linear Rec.2020: a per-channel gain in grading RGB is one (`G⁻¹ diag G`);
 * the offset and the powers become their gain at middle grey. Their contrast (a
 * luminance power around a fulcrum) is a straight line of EV offsets: a tone curve.
 */
import {
  type ModuleParams,
  type ToneMixer,
  TONE_CURVE_NODES,
  TONE_CURVE_RANGE,
  defaultModuleParams,
} from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

type ColorBalance = ModuleParams['colorBalance'];

const COLORBALANCERGB_V5 = new Layout([
  ...[
    'shadows_Y',
    'shadows_C',
    'shadows_H',
    'midtones_Y',
    'midtones_C',
    'midtones_H',
    'highlights_Y',
    'highlights_C',
    'highlights_H',
    'global_Y',
    'global_C',
    'global_H',
    'shadows_weight',
    'white_fulcrum',
    'highlights_weight',
    'chroma_shadows',
    'chroma_highlights',
    'chroma_global',
    'chroma_midtones',
    'saturation_global',
    'saturation_highlights',
    'saturation_midtones',
    'saturation_shadows',
    'hue_angle',
    'brilliance_global',
    'brilliance_highlights',
    'brilliance_midtones',
    'brilliance_shadows',
    'mask_grey_fulcrum',
    'vibrance',
    'grey_fulcrum',
    'contrast',
  ].map((name) => [name, 'f32'] as const),
  ['saturation_formula', 'i32'],
]);

const GREY = 0.1845;

// ── Grading RGB (Filmlight), as `ops/filmic.rs` and darktable's colorspaces ──────

type Mat3 = number[][];
type Vec3 = [number, number, number];
const XYZ_FROM_REC2020: Mat3 = [
  [0.636958, 0.1446169, 0.168881],
  [0.2627002, 0.6779981, 0.0593017],
  [0, 0.0280727, 1.0609851],
];
const LMS_FROM_XYZ: Mat3 = [
  [0.257085, 0.859943, -0.031061],
  [-0.394427, 1.1758, 0.106423],
  [0.064856, -0.07625, 0.559067],
];
const GRADING_FROM_LMS: Mat3 = [
  [1.0877193, -0.66666667, 0.02061856],
  [-0.0877193, 1.66666667, -0.05154639],
  [0, 0, 1.03092784],
];
const LMS_FROM_GRADING: Mat3 = [
  [0.95, 0.38, 0],
  [0.05, 0.62, 0.03],
  [0, 0, 0.97],
];
const WHITE_R = 0.21902143;
const WHITE_G = 0.54371398;
/** `CONVENTIONAL_DEG_TO_YRG_RAD`'s shift. */
const ANGLE_SHIFT = -30;

const mul = (a: Mat3, b: Mat3): Mat3 =>
  a.map((row) => [0, 1, 2].map((j) => row.reduce((t, v, k) => t + v * b[k]![j]!, 0)));
const mulVec = (m: Mat3, v: number[]): Vec3 =>
  m.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!) as Vec3;
function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m.flat() as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [A, B, C] = [e * i - f * h, f * g - d * i, d * h - e * g];
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
/** Linear Rec.2020 → grading RGB, and back. */
const GRADING_FROM_REC2020 = mul(GRADING_FROM_LMS, mul(LMS_FROM_XYZ, XYZ_FROM_REC2020));
const REC2020_FROM_GRADING = invert(GRADING_FROM_REC2020);

/** darktable's `make_Ych` → `Ych_to_gradingRGB`, at luminance 1. */
function gradingOf(chroma: number, hueDeg: number): Vec3 {
  const h = ((hueDeg + ANGLE_SHIFT) * Math.PI) / 180;
  const [r, g] = [chroma * Math.cos(h) + WHITE_R, chroma * Math.sin(h) + WHITE_G];
  const lms = mulVec(LMS_FROM_GRADING, [r, g, 1 - r - g]);
  const a = 1 / (0.68990272 * lms[0] + 0.34832189 * lms[1]);
  return mulVec(
    GRADING_FROM_LMS,
    lms.map((v) => v * a),
  );
}

/** A mixer that applies `gain` per grading RGB channel. */
function mixer(gain: Vec3): ToneMixer {
  const m = mul(
    REC2020_FROM_GRADING,
    mul(
      [
        [gain[0], 0, 0],
        [0, gain[1], 0],
        [0, 0, gain[2]],
      ],
      GRADING_FROM_REC2020,
    ),
  );
  return {
    ...structuredClone(defaultModuleParams.colorBalance.shadows),
    red: m[0]!,
    green: m[1]!,
    blue: m[2]!,
    normalizeRed: false,
    normalizeGreen: false,
    normalizeBlue: false,
  };
}

/** Their 4 ways as our mixers (shadows, mid-tones, highlights), or null when they do nothing. */
function fourWays(n: (k: string) => number): [ToneMixer, ToneMixer, ToneMixer] | null {
  if (!['shadows', 'midtones', 'highlights', 'global'].some((r) => n(`${r}_Y`) !== 0 || n(`${r}_C`) !== 0)) return null;
  const norm = gradingOf(0, 0);
  const delta = (r: string) => gradingOf(n(`${r}_C`), n(`${r}_H`)).map((v, c) => v - norm[c]!) as Vec3;
  const global = delta('global').map((v, c) => v + norm[c]! * n('global_Y'));
  // The offset as a gain, at middle grey.
  const offsetGain = global.map((o, c) => 1 + o / (GREY * norm[c]!));
  const slope = (r: string) => delta(r).map((v, c) => offsetGain[c]! * (1 + v + n(`${r}_Y`))) as Vec3;
  // The powers as gains at middle grey, on their scale (white at the white fulcrum).
  const white = 2 ** n('white_fulcrum');
  const powerY = 1 / (1 + n('midtones_Y'));
  const mid = delta('midtones').map((v, c) => {
    const x = (GREY * norm[c]!) / white;
    return offsetGain[c]! * x ** (1 / (1 + v) - 1) * (GREY / white) ** (powerY - 1);
  }) as Vec3;
  return [mixer(slope('shadows')), mixer(mid), mixer(slope('highlights'))];
}

/** Their contrast as a tone curve (EV offsets, luminance), or null. */
function contrastCurve(n: (k: string) => number): ModuleParams['toneCurve'] | null {
  const c = n('contrast');
  if (Math.abs(c) < 1e-4) return null;
  const fulcrum = Math.log2(Math.max(n('grey_fulcrum'), 1e-4) / GREY);
  const [lo, hi] = TONE_CURVE_RANGE;
  const rgb = Array.from({ length: TONE_CURVE_NODES }, (_, i) => {
    const ev = lo + ((hi - lo) * i) / (TONE_CURVE_NODES - 1);
    return Math.max(-2, Math.min(2, c * (ev - fulcrum)));
  });
  return { ...structuredClone(defaultModuleParams.toneCurve), channels: 'linked', preserveColors: 'luminance', rgb };
}
/** `DT_COLORBALANCE_SATURATION_DTUCS`, ours. */
const SATURATION_DTUCS = 1;

export const colorBalance: Translator = {
  operations: ['colorbalancergb'],
  kinds: ['colorBalance'],
  translate(entry, bytes): Translation {
    const p = entry.modversion === 5 ? (COLORBALANCERGB_V5.read(bytes) as Record<string, number> | null) : null;
    if (!p) return unreadable(entry);
    const n = (k: string) => p[k]!;
    // Global, then shadows, mid-tones, highlights: ours per range, global added in.
    const ranges = (what: string) =>
      (['shadows', 'midtones', 'highlights'] as const).map((r) => n(`${what}_global`) + n(`${what}_${r}`));
    const params: ColorBalance = {
      ...structuredClone(defaultModuleParams.colorBalance),
      hueShift: n('hue_angle'),
      vibrance: n('vibrance'),
      chroma: ranges('chroma'),
      saturation: ranges('saturation'),
      brilliance: ranges('brilliance'),
      fulcrum: Math.log2(Math.max(n('mask_grey_fulcrum'), 1e-4) / GREY),
      whiteFulcrum: n('white_fulcrum'),
    };
    const notes: string[] = [];
    const mixers = fourWays(n);
    if (mixers) {
      [params.shadows, params.midtones, params.highlights] = mixers;
      notes.push('Its 4 ways as split-toning mixers (the offset and powers taken at middle grey)');
    }
    const curve = contrastCurve(n);
    if (curve) notes.push('Contrast as a tone curve');
    if (n('saturation_formula') !== SATURATION_DTUCS) notes.push('Saturation with the darktable UCS formula');
    if (Math.abs(n('shadows_weight') - 1) > 1e-3 || Math.abs(n('highlights_weight') - 1) > 1e-3)
      notes.push('Range weights not carried over');
    return {
      instance: instance('colorBalance', params),
      ...(curve && { extra: [{ ...instance('toneCurve', curve), label: 'Colour balance contrast' }] }),
      status: notes.length ? 'approximated' : 'mapped',
      ...(notes.length && { note: notes.join('. ') }),
    };
  },
};
