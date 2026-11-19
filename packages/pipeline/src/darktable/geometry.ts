/**
 * darktable's orientation (`flip.c`), rotate and perspective (`ashift.c`) and crop
 * (`crop.c`) as our geometry. Their order: rotate and perspective on the sensor frame,
 * then orientation, then crop; ours: orientation, then straighten and perspective
 * (`ops/perspective.rs`, a camera rotation rather than their lens shifts), then the crop.
 *
 * So it's fitted rather than translated: points of their output are taken back to the
 * sensor through their chain, then forward through ours; our angle, tilt, pan, shear
 * and aspect are those that put them where theirs are, up to a scale and offset per
 * axis, which is the crop (with auto-crop off: the frame is the warped image's bounding
 * box). Lens correction comes before both, and is left out.
 */
import { type ModuleParams, defaultModuleParams } from '../params.ts';
import { Layout } from './struct.ts';
import { type TranslateContext, type Translation, type Translator, instance, unreadable } from './translate.ts';
import type { DarktableEntry } from './xmp.ts';
import { nelderMead } from './tone.ts';

type Geometry = ModuleParams['geometry'];
type Pt = [number, number];
type Mat3 = number[][];

const FLIP = new Layout([['orientation', 'i32']]);
const CROP = new Layout([
  ['cx', 'f32'],
  ['cy', 'f32'],
  ['cw', 'f32'],
  ['ch', 'f32'],
  ['ratio_n', 'i32'],
  ['ratio_d', 'i32'],
]);
const ASHIFT_V5 = new Layout([
  ['rotation', 'f32'],
  ['lensshift_v', 'f32'],
  ['lensshift_h', 'f32'],
  ['shear', 'f32'],
  ['f_length', 'f32'],
  ['crop_factor', 'f32'],
  ['orthocorr', 'f32'],
  ['aspect', 'f32'],
  ['mode', 'i32'],
  ['cropmode', 'i32'],
  ['cl', 'f32'],
  ['cr', 'f32'],
  ['ct', 'f32'],
  ['cb', 'f32'],
  ['last_drawn_lines', { array: 'f32', n: 50 * 4 }],
  ['last_drawn_lines_count', 'i32'],
  ['last_quad_lines', { array: 'f32', n: 8 }],
]);

// ── Matrices ──────────────────────────────────────────────────────────────────

const mul = (a: Mat3, b: Mat3): Mat3 =>
  a.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)));
const apply = (m: Mat3, [x, y]: Pt): Pt => {
  const w = m[2]![0]! * x + m[2]![1]! * y + m[2]![2]!;
  return [(m[0]![0]! * x + m[0]![1]! * y + m[0]![2]!) / w, (m[1]![0]! * x + m[1]![1]! * y + m[1]![2]!) / w];
};
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

// ── Theirs ────────────────────────────────────────────────────────────────────

/** `DEFAULT_F_LENGTH`, and `ASHIFT_MODE_GENERIC`. */
const DT_F_LENGTH = 28;
const MODE_GENERIC = 0;

/** darktable's `_homography`, forward: input pixel → output pixel (the warped image's bounding box from 0). */
function ashiftHomography(p: Record<string, number>, width: number, height: number): Mat3 {
  const generic = p.mode === MODE_GENERIC;
  const f = generic ? DT_F_LENGTH : p.f_length! * p.crop_factor!;
  const orthocorr = generic ? 0 : p.orthocorr!;
  const aspect = generic ? 1 : p.aspect!;
  const [u, v] = [width, height];
  const phi = (p.rotation! * Math.PI) / 180;
  const [cosi, sini] = [Math.cos(phi), Math.sin(phi)];
  const ascale = Math.sqrt(aspect);
  const factor = 1 - orthocorr / 100;
  const side = (shift: number, a: number, b: number) => {
    const e = Math.exp(shift);
    const fdb = f / (14.4 + (a / b - 1) * 7.2);
    const alpha = Math.min(1.5, Math.max(-1.5, Math.atan((fdb * (e - 1)) / (e + 1))));
    const rt = Math.sin(0.5 * alpha);
    return { e, r: Math.max(0.1, 2 * (factor - 1) * rt * rt + 1) };
  };
  const sv = side(p.lensshift_v!, v, u);
  const sh = side(p.lensshift_h!, u, v);
  let m: Mat3 = [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  const steps: Mat3[] = [
    [
      [cosi, -sini, -0.5 * v * cosi + 0.5 * u * sini + 0.5 * v],
      [sini, cosi, -0.5 * v * sini - 0.5 * u * cosi + 0.5 * u],
      [0, 0, 1],
    ],
    [
      [1, p.shear!, 0],
      [p.shear!, 1, 0],
      [0, 0, 1],
    ],
    [
      [sv.e, 0, 0],
      [(0.5 * ((sv.e - 1) * u)) / v, (2 * sv.e) / (sv.e + 1), (-0.5 * ((sv.e - 1) * u)) / (sv.e + 1)],
      [(sv.e - 1) / v, 0, 1],
    ],
    [
      [1, 0, 0],
      [0, sv.r, 0.5 * u * (1 - sv.r)],
      [0, 0, 1],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [sh.e, 0, 0],
      [(0.5 * ((sh.e - 1) * v)) / u, (2 * sh.e) / (sh.e + 1), (-0.5 * ((sh.e - 1) * v)) / (sh.e + 1)],
      [(sh.e - 1) / u, 0, 1],
    ],
    [
      [1, 0, 0],
      [0, sh.r, 0.5 * v * (1 - sh.r)],
      [0, 0, 1],
    ],
    [
      [ascale, 0, 0],
      [0, 1 / ascale, 0],
      [0, 0, 1],
    ],
  ];
  for (const step of steps) m = mul(step, m);
  const corners = [0, width - 1].flatMap((x) => [0, height - 1].map((y) => apply(m, [x, y])));
  const [umin, vmin] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1]))];
  return mul(
    [
      [1, 0, -umin],
      [0, 1, -vmin],
      [0, 0, 1],
    ],
    m,
  );
}

/** darktable's `dt_image_orientation_to_flip_bits` (EXIF → FLIP_Y 1, FLIP_X 2, SWAP_XY 4). */
const EXIF_TO_FLIP = [0, 0, 2, 3, 1, 4, 5, 7, 6];

/** Their output (normalised) → sensor pixel: their crop, orientation and perspective, undone. */
interface TheirChain {
  toSensor: (q: Pt) => Pt;
  /** Their output's size, pixels. */
  size: Pt;
  /** Their orientation flags (`ORIENTATION_*`). */
  orientation: number;
}

function theirChain(
  width: number,
  height: number,
  ashift: Record<string, number> | null,
  orientation: number,
  crop: Record<string, number> | null,
): TheirChain {
  // Rotate and perspective: its output frame, cropped by cl…cb.
  let undoAshift = (p: Pt): Pt => p;
  let [w, h] = [width, height];
  if (ashift) {
    const m = ashiftHomography(ashift, width, height);
    const corners = [0, width - 1].flatMap((x) => [0, height - 1].map((y) => apply(m, [x, y])));
    const fullW = Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0])) + 1;
    const fullH = Math.max(...corners.map((c) => c[1])) - Math.min(...corners.map((c) => c[1])) + 1;
    const [cl, ct] = [ashift.cl!, ashift.ct!];
    const back = invert(m);
    undoAshift = ([x, y]) => apply(back, [x + fullW * cl, y + fullH * ct]);
    [w, h] = [fullW * (ashift.cr! - cl), fullH * (ashift.cb! - ct)];
  }
  // Orientation: x mirrored (FLIP_X), y (FLIP_Y), then transposed (SWAP_XY).
  const swap = (orientation & 4) !== 0;
  const [ow, oh] = swap ? [h, w] : [w, h];
  const undoFlip = ([x, y]: Pt): Pt => {
    let [a, b] = swap ? [y, x] : [x, y];
    if (orientation & 2) a = w - a;
    if (orientation & 1) b = h - b;
    return [a, b];
  };
  // Crop: cx, cy the top-left corner, cw, ch the bottom-right one.
  const c = crop ?? { cx: 0, cy: 0, cw: 1, ch: 1 };
  const undoCrop = ([x, y]: Pt): Pt => [(c.cx! + x * (c.cw! - c.cx!)) * ow, (c.cy! + y * (c.ch! - c.cy!)) * oh];
  return {
    toSensor: (q) => undoAshift(undoFlip(undoCrop(q))),
    size: [(c.cw! - c.cx!) * ow, (c.ch! - c.cy!) * oh],
    orientation,
  };
}

// ── Ours ──────────────────────────────────────────────────────────────────────

/** Our orientation (`decode::Orient`): mirror, then quarter turns clockwise. */
interface Orient {
  flip: boolean;
  turns: number;
}
const ORIENT_FROM_EXIF: Orient[] = [
  { flip: false, turns: 0 },
  { flip: false, turns: 0 },
  { flip: true, turns: 0 },
  { flip: false, turns: 2 },
  { flip: true, turns: 2 },
  { flip: true, turns: 3 },
  { flip: false, turns: 1 },
  { flip: true, turns: 1 },
  { flip: false, turns: 3 },
];
/** `Orient::then`: `turns` more clockwise, then mirrored if `flip`. */
function then(o: Orient, turns: number, flip: boolean): Orient {
  const q = (o.turns + turns) % 4;
  return flip ? { flip: !o.flip, turns: (4 - q) % 4 } : { flip: o.flip, turns: q };
}
/** Sensor pixel (w × h) → oriented pixel. */
function orient(o: Orient, [u, v]: Pt, w: number, h: number): Pt {
  let [x, y, fw, fh] = [o.flip ? w - u : u, v, w, h];
  for (let i = 0; i < o.turns; i++) [x, y, fw, fh] = [fh - y, x, fh, fw];
  return [x, y];
}

const rotZ = (r: number): Mat3 => [
  [Math.cos(r), -Math.sin(r), 0],
  [Math.sin(r), Math.cos(r), 0],
  [0, 0, 1],
];
const rotX = (t: number): Mat3 => [
  [1, 0, 0],
  [0, Math.cos(t), -Math.sin(t)],
  [0, Math.sin(t), Math.cos(t)],
];
const rotY = (r: number): Mat3 => [
  [Math.cos(r), 0, -Math.sin(r)],
  [0, 1, 0],
  [Math.sin(r), 0, Math.cos(r)],
];

/** `Perspective::warp`: oriented frame → corrected frame (both centred). */
function warp(
  g: Pick<Geometry, 'angle' | 'vertical' | 'horizontal' | 'shear' | 'aspect'>,
  focal: number,
  ow: number,
  oh: number,
): Mat3 {
  const f = Math.max(focal * Math.max(ow, oh), 1);
  const deg = Math.PI / 180;
  const rotation = mul(mul(rotX(g.vertical * deg), rotY(g.horizontal * deg)), rotZ(g.angle * deg));
  const k: Mat3 = [
    [f, 0, 0],
    [0, f, 0],
    [0, 0, 1],
  ];
  const kInv: Mat3 = [
    [1 / f, 0, 0],
    [0, 1 / f, 0],
    [0, 0, 1],
  ];
  const shear: Mat3 = [
    [1, 0, 0],
    [g.shear, 1, 0],
    [0, 0, 1],
  ];
  const a = 2 ** (g.aspect / 2);
  const stretch: Mat3 = [
    [a, 0, 0],
    [0, 1 / a, 0],
    [0, 0, 1],
  ];
  return mul(mul(mul(stretch, shear), mul(k, rotation)), kInv);
}

// ── Fitting ───────────────────────────────────────────────────────────────────

const GRID = Array.from({ length: 7 }, (_, i) => i / 6);

/** Their output points (normalised), their sensor positions, and our oriented frame. */
interface Samples {
  q: Pt[];
  sensor: Pt[];
  /** Their output's size, pixels: the crop keeps its proportions. */
  size: Pt;
}

/**
 * Our corrected frame position of each sample, for these parameters, and how well an
 * axis-aligned scale and offset of their output gives it: the residual (a share of
 * the frame) and that scale and offset.
 */
function residual(s: Samples, g: Geometry, o: Orient, focal: number, width: number, height: number) {
  const [ow, oh] = o.turns % 2 ? [height, width] : [width, height];
  const m = warp(g, focal, ow, oh);
  const r = s.sensor.map((p) => {
    const [x, y] = orient(o, p, width, height);
    return apply(m, [x - ow / 2, y - oh / 2]);
  });
  // Least squares: r = k·(q × their size) + b, one scale (their proportions kept).
  const n = s.q.length;
  const Q = s.q.map((q): Pt => [q[0] * s.size[0], q[1] * s.size[1]]);
  const mean = (ps: Pt[]): Pt => [ps.reduce((t, p) => t + p[0], 0) / n, ps.reduce((t, p) => t + p[1], 0) / n];
  const [mq, mr] = [mean(Q), mean(r)];
  let [num, den] = [0, 0];
  for (const [i, q] of Q.entries()) {
    num += (q[0] - mq[0]) * (r[i]![0] - mr[0]) + (q[1] - mq[1]) * (r[i]![1] - mr[1]);
    den += (q[0] - mq[0]) ** 2 + (q[1] - mq[1]) ** 2;
  }
  const k = num / den;
  const b: Pt = [mr[0] - k * mq[0], mr[1] - k * mq[1]];
  const err = Q.reduce((t, q, i) => t + (k * q[0] + b[0] - r[i]![0]) ** 2 + (k * q[1] + b[1] - r[i]![1]) ** 2, 0);
  const fx = { a: k * s.size[0], b: b[0] };
  const fy = { a: k * s.size[1], b: b[1] };
  return { error: Math.sqrt(err / n) / Math.max(ow, oh), fx, fy, m, ow, oh };
}

/** Our geometry closest to their chain, and how far it is (a share of the frame). */
function fitGeometry(
  chain: TheirChain,
  exifOrientation: number,
  focal: number,
  width: number,
  height: number,
  angleGuess: number,
): { params: Geometry; error: number } | null {
  const q = GRID.flatMap((x) => GRID.map((y): Pt => [x, y]));
  const samples: Samples = { q, sensor: q.map(chain.toSensor), size: chain.size };
  if (samples.sensor.some((p) => !p.every(Number.isFinite))) return null;
  // Their orientation as ours on top of the camera's: whichever lands the corners alike.
  const exif = ORIENT_FROM_EXIF[exifOrientation] ?? ORIENT_FROM_EXIF[0]!;
  const theirs = (p: Pt): Pt => {
    const swap = (chain.orientation & 4) !== 0;
    let [x, y] = [p[0], p[1]];
    if (chain.orientation & 2) x = 1 - x;
    if (chain.orientation & 1) y = 1 - y;
    return swap ? [y, x] : [x, y];
  };
  const corners: Pt[] = [
    [0.1, 0.2],
    [0.9, 0.3],
    [0.4, 0.8],
  ];
  let best: { params: Geometry; error: number } | null = null;
  for (let turns = 0; turns < 4; turns++) {
    for (const flip of [false, true]) {
      const o = then(exif, turns, flip);
      const matches = corners.every((c) => {
        const [x, y] = orient(o, [c[0], c[1]], 1, 1);
        const [tx, ty] = theirs(c);
        return Math.abs(x - tx) < 1e-6 && Math.abs(y - ty) < 1e-6;
      });
      if (!matches) continue;
      const base: Geometry = {
        ...defaultModuleParams.geometry,
        rotation: turns,
        flipHorizontal: flip,
        autoCrop: 'off',
      };
      const make = (x: number[]): Geometry => ({
        ...base,
        angle: Math.max(-45, Math.min(45, x[0]!)),
        vertical: Math.max(-40, Math.min(40, x[1]!)),
        horizontal: Math.max(-40, Math.min(40, x[2]!)),
        shear: Math.max(-0.5, Math.min(0.5, x[3]!)),
        aspect: Math.max(-1, Math.min(1, x[4]!)),
      });
      const loss = (x: number[]) => residual(samples, make(x), o, focal, width, height).error;
      for (const angle of [angleGuess, -angleGuess]) {
        let x = [angle, 0, 0, 0, 0];
        for (let round = 0; round < 3; round++) x = nelderMead(loss, x, [1, 2, 2, 0.05, 0.1], 1500);
        const g = make(x);
        const r = residual(samples, g, o, focal, width, height);
        // The frame: the warped image's bounding box; the crop, their output in it.
        const box = [
          [0, 0],
          [r.ow, 0],
          [r.ow, r.oh],
          [0, r.oh],
        ].map(([x, y]) => apply(r.m, [x! - r.ow / 2, y! - r.oh / 2]));
        const [x0, y0] = [Math.min(...box.map((p) => p[0])), Math.min(...box.map((p) => p[1]))];
        const [w0, h0] = [Math.max(...box.map((p) => p[0])) - x0, Math.max(...box.map((p) => p[1])) - y0];
        if (r.fx.a <= 0 || r.fy.a <= 0) continue;
        const crop = { x: (r.fx.b - x0) / w0, y: (r.fy.b - y0) / h0, width: r.fx.a / w0, height: r.fy.a / h0 };
        const params = { ...g, crop };
        if (!best || r.error < best.error) best = { params, error: r.error };
      }
    }
  }
  return best;
}

// ── The translator ────────────────────────────────────────────────────────────

const OPERATIONS = ['flip', 'ashift', 'crop'];

function read(ctx: TranslateContext, operation: string, layout: Layout, version: number | null) {
  const e = ctx.active.find((x) => x.operation === operation && x.enabled);
  if (!e) return { entry: null, params: null };
  const bytes = ctx.paramsOf(e);
  const p = bytes && (version === null || e.modversion === version) ? layout.read(bytes) : null;
  return { entry: e, params: p as Record<string, number> | null };
}

/** Their orientation, rotate and perspective, and crop as one geometry instance, given with the last of them. */
const geometry: Translator = {
  operations: OPERATIONS,
  kinds: ['geometry'],
  translate(entry: DarktableEntry, _bytes, ctx): Translation {
    const enabled = ctx.active.filter((e) => e.enabled && OPERATIONS.includes(e.operation));
    if (!entry.enabled) return { instance: null, status: 'mapped' };
    const flip = read(ctx, 'flip', FLIP, null);
    const ashift = read(ctx, 'ashift', ASHIFT_V5, 5);
    const crop = read(ctx, 'crop', CROP, null);
    const mine = [flip, ashift, crop].find((x) => x.entry === entry)!;
    if (!mine.params) return unreadable(entry);
    if (entry !== enabled.at(-1)) return { instance: null, status: 'mapped' };

    const { width: mw, height: mh, orientation: exifOrientation, focalLength } = ctx.metadata;
    if (!mw || !mh) return { instance: null, status: 'skipped', note: "The photo's size isn't known" };
    const exif = exifOrientation ?? 1;
    // The metadata's size is oriented; theirs and ours start from the sensor's.
    const [width, height] = exif >= 5 && exif <= 8 ? [mh, mw] : [mw, mh];
    const flags = flip.params && flip.params.orientation !== -1 ? flip.params.orientation! : (EXIF_TO_FLIP[exif] ?? 0);
    const chain = theirChain(width, height, ashift.params, flags, crop.params);
    const focal = (focalLength && focalLength >= 8 ? focalLength : 28) / 36;
    const fit = fitGeometry(chain, exif, focal, width, height, ashift.params?.rotation ?? 0);
    if (!fit) return { instance: null, status: 'skipped', note: 'Its geometry could not be fitted' };
    const off = Math.round(fit.error * 1000) / 10;
    // Nothing but the orientation: our default framing.
    const plain = !ashift.params && !crop.params;
    const params = plain
      ? { ...defaultModuleParams.geometry, rotation: fit.params.rotation, flipHorizontal: fit.params.flipHorizontal }
      : fit.params;
    return {
      instance: instance('geometry', params),
      status: off > 0.2 ? 'approximated' : 'mapped',
      ...(off > 0.2 && { note: `Perspective fitted with ours (within ${off} % of the frame)` }),
    };
  },
};

export const GEOMETRY_TRANSLATORS: readonly Translator[] = [geometry];
