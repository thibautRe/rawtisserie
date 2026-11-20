/**
 * darktable's and Ansel's blending (`blend.h`: `dt_develop_blend_params_t`, darktable's
 * v13/v14 and Ansel's v11, the same 420 bytes) and drawn shapes (`masks_history`,
 * `develop/masks/*.c`) as our mask (`params::Mask`) and shapes (`shapes.ts`).
 *
 * Parametric ranges (scene-referred RGB, `blendif_rgb_jzczhz.c`): each channel is a
 * trapezoid `[a, b, c, d]` on the channel's value, as ours. Grey (the luminance) and R, G,
 * B are linear, ours EV relative to middle grey; Jz, Cz and hz (JzAzBz) become our
 * luminance, saturation and hue (CIE u′v′) by sampling colours through both. A
 * channel's own inversion maps only when one end is open. Channels on the module's
 * output aren't read.
 *
 * Drawn shapes: their circles, ellipses, gradients and paths are ours, in the same
 * coordinates (normalised on the sensor frame, lengths on its shorter side), combined
 * as their group says. Feathering and blur become our feather (edge-aware for their
 * guided feathering). Mask refinement (contrast, brightness, details) and raster
 * masks aren't imported.
 */
import { type BlendMode, type DrawnShape, type Mask, type MaskRange, type ShapeOp, defaultMask } from '../params.ts';
import type { Shape } from '../shapes.ts';
import { Layout } from './struct.ts';
import { type DarktableMaskEntry, decodeBlob } from './xmp.ts';

// ── Blending parameters ───────────────────────────────────────────────────────

export const BLEND_PARAMS = new Layout([
  ['mask_mode', 'u32'],
  ['blend_cst', 'i32'],
  ['blend_mode', 'u32'],
  ['blend_parameter', 'f32'],
  ['opacity', 'f32'],
  ['mask_combine', 'u32'],
  ['mask_id', 'i32'],
  ['blendif', 'u32'],
  ['feathering_radius', 'f32'],
  ['feathering_guide', 'u32'],
  ['blur_radius', 'f32'],
  ['contrast', 'f32'],
  ['brightness', 'f32'],
  ['details', 'f32'],
  // darktable's `feather_version` and reserved[2]; Ansel's reserved[3].
  ['reserved', { array: 'u32', n: 3 }],
  ['blendif_parameters', { array: 'f32', n: 4 * 16 }],
  ['blendif_boost_factors', { array: 'f32', n: 16 }],
  ['raster_mask_source', { char: 20 }],
  ['raster_mask_instance', 'i32'],
  ['raster_mask_id', 'i32'],
  ['raster_mask_invert', 'gboolean'],
]);

const MASK_ENABLED = 1;
const MASK_DRAWN = 2;
const MASK_CONDITIONAL = 4;
const MASK_RASTER = 8;
const COMBINE_INV = 1;
const COMBINE_INCL = 2;
const COMBINE_MASKS_POS = 4;
const CS_RGB_SCENE = 4;
/** `dt_develop_blendif_channels_t` (scene-referred RGB). */
const GRAY = 0;
const RED = 1;
const GREEN = 2;
const BLUE = 3;
const JZ = 8;
const CZ = 9;
const HZ = 10;
const OUTPUT_CHANNELS = [4, 5, 6, 7, 12, 13, 14];

/** Their blend modes (`DEVELOP_BLEND_*`) that are ours. */
const BLEND_MODES: Readonly<Record<number, BlendMode>> = {
  0x00: 'normal',
  0x18: 'normal',
  0x19: 'normal',
  0x02: 'lighten',
  0x03: 'darken',
  0x04: 'multiply',
  0x26: 'divide',
  0x06: 'addition',
  0x07: 'subtraction',
  0x08: 'difference',
  0x17: 'difference',
  0x05: 'average',
  0x28: 'geometricMean',
  0x29: 'harmonicMean',
  0x09: 'screen',
  0x0a: 'overlay',
  0x0b: 'softLight',
  0x0c: 'hardLight',
  0x11: 'chroma',
  0x10: 'luminance',
  0x21: 'red',
  0x22: 'green',
  0x23: 'blue',
};

// ── Colours: their JzAzBz and our u′v′ ────────────────────────────────────────

const GREY = 0.1845;
const XYZ_FROM_REC2020 = [
  [0.636958, 0.1446169, 0.168881],
  [0.2627002, 0.6779981, 0.0593017],
  [0, 0.0280727, 1.0609851],
];
const mulVec = (m: number[][], v: number[]) => m.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!);

/** darktable's `dt_XYZ_2_JzAzBz` then `dt_JzAzBz_2_JzCzhz`, on XYZ (D65) as its blending gives it. */
function jzczhz(xyz: number[]): [number, number, number] {
  const [b, g, c1, c2, c3, n, p, d, d0] = [
    1.15, 0.66, 0.8359375, 18.8515625, 18.6875, 0.159301758, 134.034375, -0.56, 1.6295499532821566e-11,
  ];
  const X = b * xyz[0]! - (b - 1) * xyz[2]!;
  const Y = g * xyz[1]! - (g - 1) * xyz[0]!;
  const Z = xyz[2]!;
  const lms = [
    0.41478972 * X + 0.579999 * Y + 0.014648 * Z,
    -0.20151 * X + 1.120649 * Y + 0.0531008 * Z,
    -0.0166008 * X + 0.2648 * Y + 0.6684799 * Z,
  ].map((v) => {
    const t = Math.max(v / 10000, 0) ** n;
    return ((c1 + c2 * t) / (1 + c3 * t)) ** p;
  });
  const iz = 0.5 * lms[0]! + 0.5 * lms[1]!;
  const az = 3.524 * lms[0]! - 4.066708 * lms[1]! + 0.542708 * lms[2]!;
  const bz = 0.199076 * lms[0]! + 1.096799 * lms[1]! - 1.295875 * lms[2]!;
  const jz = Math.max(((1 + d) * iz) / (1 + d * iz) - d0, 0);
  const h = Math.atan2(bz, az) / (2 * Math.PI);
  return [jz, Math.hypot(az, bz), h >= 0 ? h : 1 + h];
}

/** Our saturation and hue (`ops/mask.rs`): distance from white in u′v′ ×13, and its angle in degrees. */
function uvSatHue(xyz: number[]): [number, number] {
  const den = (v: number[]) => v[0]! + 15 * v[1]! + 3 * v[2]!;
  const white = mulVec(XYZ_FROM_REC2020, [1, 1, 1]);
  const [u, v] = [(4 * xyz[0]!) / den(xyz), (9 * xyz[1]!) / den(xyz)];
  const [uw, vw] = [(4 * white[0]!) / den(white), (9 * white[1]!) / den(white)];
  const deg = (Math.atan2(v - vw, u - uw) * 180) / Math.PI;
  return [13 * Math.hypot(u - uw, v - vw), deg < 0 ? deg + 360 : deg];
}

/** A colour of luminance `y` (linear Rec.2020, white 1) at `hue` (0 … 1 around the RGB wheel) and saturation `s` (0 … 1). */
function wheelColour(y: number, hue: number, s: number): number[] {
  const h = hue * 6;
  const x = 1 - Math.abs((h % 2) - 1);
  const rgb = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x],
  ][Math.floor(h) % 6]!.map((c) => 1 - s + s * c);
  const lum = mulVec(XYZ_FROM_REC2020, rgb)[1]!;
  return rgb.map((c) => (c * y) / lum);
}

/** Pairs (their hue, our hue) around the wheel, in their order: their hue → ours. */
const HUE_TABLE = (() => {
  const pairs = Array.from({ length: 360 }, (_, i) => {
    const xyz = mulVec(XYZ_FROM_REC2020, wheelColour(GREY, i / 360, 0.6));
    return [jzczhz(xyz)[2], uvSatHue(xyz)[1]] as const;
  });
  return pairs.toSorted((a, b) => a[0] - b[0]);
})();
function hueFromJz(hz: number): number {
  const t = ((hz % 1) + 1) % 1;
  const i = HUE_TABLE.findIndex((p) => p[0] >= t);
  const [a, b] = i <= 0 ? [HUE_TABLE.at(-1)!, HUE_TABLE[0]!] : [HUE_TABLE[i - 1]!, HUE_TABLE[i]!];
  const span = (b[0] - a[0] + 1) % 1 || 1e-9;
  const along = ((t - a[0] + 1) % 1) / span;
  let delta = b[1] - a[1];
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return (((a[1] + along * delta) % 360) + 360) % 360;
}

/** Our saturation per unit of their chroma, at middle grey's lightness (averaged around the wheel). */
const CZ_TO_SATURATION = (() => {
  let [num, den] = [0, 0];
  for (let i = 0; i < 36; i++) {
    const xyz = mulVec(XYZ_FROM_REC2020, wheelColour(GREY, i / 36, 0.3));
    const cz = jzczhz(xyz)[1];
    num += cz * uvSatHue(xyz)[0];
    den += cz * cz;
  }
  return num / den;
})();

/** The scene exposure (EV, middle grey 0) of a grey with lightness `jz`. */
function evFromJz(jz: number): number {
  let [lo, hi] = [-30, 30];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const y = GREY * 2 ** mid;
    if (jzczhz(mulVec(XYZ_FROM_REC2020, [y, y, y]))[0] < jz) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Parametric ranges ─────────────────────────────────────────────────────────

const OPEN = 1e9;

/** Their channel's range on its own scale, its open ends as such (`dt_develop_blendif_process_parameters`). */
function channelRange(p: Record<string, unknown>, i: number): (number | null)[] {
  const params = (p.blendif_parameters as number[]).slice(4 * i, 4 * i + 4);
  const boost = 2 ** (p.blendif_boost_factors as number[])[i]!;
  const scaled = params.map((v) => v * boost);
  const out: (number | null)[] = [...scaled];
  if (params[0]! <= 0 && params[1]! <= 0) [out[0], out[1]] = [null, null];
  if (params[2]! >= 1 && params[3]! >= 1) [out[2], out[3]] = [null, null];
  return out;
}

/** A range on their scale, as ours: open ends far away, each bound through `to`; a channel's inversion, where it maps. */
function toRange(
  r: (number | null)[],
  to: (v: number) => number,
  invert: boolean,
  low = -OPEN,
): MaskRange | null | 'unmapped' {
  const [a, b, c, d] = [
    r[0] === null ? low : to(r[0]!),
    r[1] === null ? low : to(r[1]!),
    r[2] === null ? OPEN : to(r[2]!),
    r[3] === null ? OPEN : to(r[3]!),
  ];
  if (!invert) return [a, b, c, d];
  // 1 − trapezoid: a single trapezoid only when one end was open.
  if (r[0] === null && r[3] !== null) return [c, d, OPEN, OPEN];
  if (r[3] === null && r[0] !== null) return [low, low, a, b];
  return 'unmapped';
}

const evOf = (v: number) => (v > 0 ? Math.log2(v / GREY) : -OPEN);

function parametric(p: Record<string, unknown>, notes: string[]): Partial<Mask> {
  const blendif = p.blendif as number;
  const on = (i: number) => (blendif & (1 << i)) !== 0;
  const inverted = (i: number) => (blendif & (1 << (16 + i))) !== 0;
  const out: Partial<Mask> = {};
  const set = (
    key: 'luminance' | 'saturation' | 'hue' | 'red' | 'green' | 'blue',
    range: MaskRange | null | 'unmapped',
  ) => {
    if (range === 'unmapped') return notes.push('A two-sided inverted range left out');
    // Two channels on one of ours (grey and Jz): their intersection.
    const prev = out[key];
    out[key] =
      prev && range
        ? [
            Math.max(prev[0], range[0]),
            Math.max(prev[1], range[1]),
            Math.min(prev[2], range[2]),
            Math.min(prev[3], range[3]),
          ]
        : range;
  };
  if (p.blend_cst !== CS_RGB_SCENE && blendif & 0xffff)
    notes.push('Ranges from another blending colour space read as scene-referred RGB');
  if (on(GRAY)) set('luminance', toRange(channelRange(p, GRAY), evOf, inverted(GRAY)));
  if (on(RED)) set('red', toRange(channelRange(p, RED), evOf, inverted(RED)));
  if (on(GREEN)) set('green', toRange(channelRange(p, GREEN), evOf, inverted(GREEN)));
  if (on(BLUE)) set('blue', toRange(channelRange(p, BLUE), evOf, inverted(BLUE)));
  if (on(JZ))
    set(
      'luminance',
      toRange(channelRange(p, JZ), (v) => (v > 0 ? evFromJz(v) : -OPEN), inverted(JZ)),
    );
  if (on(CZ))
    set(
      'saturation',
      toRange(channelRange(p, CZ), (v) => v * CZ_TO_SATURATION, inverted(CZ), 0),
    );
  if (on(HZ)) {
    const r = channelRange(p, HZ);
    // A hue range open at both ends is no range.
    if (!(r[0] === null && r[3] === null))
      set(
        'hue',
        toRange(
          r.map((v) => (v === null ? null : v)),
          hueFromJz,
          inverted(HZ),
          0,
        ),
      );
  }
  if (OUTPUT_CHANNELS.some(on)) notes.push("Ranges on the module's output read on its input");
  if (blendif & 0xffff) notes.push('Parametric ranges converted');
  return out;
}

// ── Drawn shapes ──────────────────────────────────────────────────────────────

const TYPE_CIRCLE = 1;
const TYPE_PATH = 2;
const TYPE_GROUP = 4;
const TYPE_GRADIENT = 16;
const TYPE_ELLIPSE = 32;
const STATE_USE = 1;
const STATE_INVERSE = 4;
const OPS: [number, ShapeOp][] = [
  [8, 'union'],
  [16, 'intersection'],
  [32, 'difference'],
  [64, 'exclusion'],
  [128, 'union'],
];

const CIRCLE = new Layout([
  ['center', { array: 'f32', n: 2 }],
  ['radius', 'f32'],
  ['border', 'f32'],
]);
const ELLIPSE = new Layout([
  ['center', { array: 'f32', n: 2 }],
  ['radius', { array: 'f32', n: 2 }],
  ['rotation', 'f32'],
  ['border', 'f32'],
  ['flags', 'i32'],
]);
const PATH_POINT = new Layout([
  ['corner', { array: 'f32', n: 2 }],
  ['ctrl1', { array: 'f32', n: 2 }],
  ['ctrl2', { array: 'f32', n: 2 }],
  ['border', { array: 'f32', n: 2 }],
  ['state', 'i32'],
]);
const GRADIENT = new Layout([
  ['anchor', { array: 'f32', n: 2 }],
  ['rotation', 'f32'],
  ['compression', 'f32'],
  ['steepness', 'f32'],
  ['curvature', 'f32'],
  ['state', 'i32'],
]);
const GROUP_POINT = new Layout([
  ['formid', 'i32'],
  ['parentid', 'i32'],
  ['state', 'i32'],
  ['opacity', 'f32'],
]);
const PROPORTIONAL = 1;

/** The forms' points, decoded (`nb` of them). */
async function points(form: DarktableMaskEntry, layout: Layout): Promise<Record<string, unknown>[] | null> {
  const bytes = await decodeBlob(form.points);
  if (!bytes || bytes.length < layout.size * form.nb) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: form.nb }, (_, i) => layout.readAt(view, i * layout.size));
}

/** One of their forms as our shape, or null (and why) if it isn't one we draw. */
async function shapeOf(
  form: DarktableMaskEntry,
  aspect: number,
  opacity: number,
): Promise<{ shape: Shape } | { why: string }> {
  if (form.type & TYPE_CIRCLE) {
    const c = (await points(form, CIRCLE))?.[0];
    if (!c) return { why: 'A damaged circle' };
    const r = c.radius as number;
    return {
      shape: {
        type: 'ellipse',
        center: c.center as [number, number],
        radii: [r, r],
        rotation: 0,
        feather: c.border as number,
        opacity,
      },
    };
  }
  if (form.type & TYPE_ELLIPSE) {
    const e = (await points(form, ELLIPSE))?.[0];
    if (!e) return { why: 'A damaged ellipse' };
    const radii = e.radius as [number, number];
    const border = e.border as number;
    const feather = (e.flags as number) & PROPORTIONAL ? (border * (radii[0] + radii[1])) / 2 : border;
    return {
      shape: {
        type: 'ellipse',
        center: e.center as [number, number],
        radii,
        rotation: ((e.rotation as number) * Math.PI) / 180,
        feather,
        opacity,
      },
    };
  }
  if (form.type & TYPE_GRADIENT) {
    const g = (await points(form, GRADIENT))?.[0];
    if (!g) return { why: 'A damaged gradient' };
    const r = ((g.rotation as number) * Math.PI) / 180;
    // Their transition: an erf over ±compression of the diagonal; ours, linear-ish over `feather` of the shorter side.
    const diagonal = Math.hypot(aspect, 1) / Math.min(aspect, 1);
    const feather = 2 * Math.max(g.compression as number, 0.001) * diagonal;
    return {
      shape: {
        type: 'gradient',
        anchor: g.anchor as [number, number],
        angle: Math.atan2(-Math.cos(r), -Math.sin(r)),
        feather,
        opacity,
      },
    };
  }
  if (form.type & TYPE_PATH) {
    const nodes = await points(form, PATH_POINT);
    if (!nodes?.length) return { why: 'A damaged path' };
    const borders = nodes.flatMap((n) => n.border as number[]);
    return {
      shape: {
        type: 'path',
        points: nodes.map((n) => {
          const [c, i, o] = [n.corner, n.ctrl1, n.ctrl2] as [[number, number], [number, number], [number, number]];
          return [c[0], c[1], i[0], i[1], o[0], o[1]] as [number, number, number, number, number, number];
        }),
        feather: borders.reduce((s, v) => s + v, 0) / borders.length,
        opacity,
      },
    };
  }
  return { why: 'A brush stroke (not imported in masks)' };
}

/** Their drawn mask (the group `id` in the forms as they stood) as our shapes and how they combine. */
async function drawn(
  id: number,
  forms: readonly DarktableMaskEntry[],
  aspect: number,
  notes: string[],
): Promise<{ shapes: Record<string, Shape>; drawn: DrawnShape[]; invert: boolean }> {
  const out = { shapes: {} as Record<string, Shape>, drawn: [] as DrawnShape[], invert: false };
  const byId = new Map(forms.map((f) => [f.id, f]));
  const root = byId.get(id);
  if (!root) {
    notes.push('Its drawn mask is missing');
    return out;
  }
  // A group of forms, or a single one.
  const members =
    root.type & TYPE_GROUP
      ? ((await points(root, GROUP_POINT)) ?? [])
      : [{ formid: root.id, state: STATE_USE | 8, opacity: 1 }];
  for (const [i, m] of members.entries()) {
    const state = m.state as number;
    if (!(state & STATE_USE)) continue;
    const form = byId.get(m.formid as number);
    if (!form) continue;
    if (form.type & TYPE_GROUP) {
      notes.push('A group within the group left out');
      continue;
    }
    const s = await shapeOf(form, aspect, Math.min(1, Math.max(0, m.opacity as number)));
    if ('why' in s) {
      notes.push(s.why);
      continue;
    }
    if (state & STATE_INVERSE) {
      // Inverting the only shape is inverting the drawn part.
      if (members.length === 1) out.invert = true;
      else notes.push('An inverted shape within a group drawn as it is');
    }
    const key = `dt${form.id}`;
    out.shapes[key] = s.shape;
    out.drawn.push({ shape: key, op: OPS.find(([bit]) => state & bit)?.[1] ?? (i === 0 ? 'union' : 'union') });
  }
  return out;
}

// ── The whole ─────────────────────────────────────────────────────────────────

export interface Blending {
  mask?: Mask;
  shapes?: Record<string, Shape>;
  /** Imported switched off: what it masks with isn't something we have. */
  off?: boolean;
  notes: string[];
}

/**
 * How an instance blends, from its blending parameters and the drawn forms as they
 * stood (`forms`); `maskable` whether our kind takes a mask; `aspect` the sensor's
 * width over its height.
 */
export async function blending(
  bytes: Uint8Array | null,
  forms: readonly DarktableMaskEntry[],
  maskable: boolean,
  aspect: number,
): Promise<Blending | null> {
  const p = bytes && BLEND_PARAMS.read(bytes);
  if (!p) return null;
  const mode = p.mask_mode as number;
  // Without `DEVELOP_MASK_ENABLED`, the other bits mean nothing (Ansel sets them all).
  if (!(mode & MASK_ENABLED)) return null;
  const notes: string[] = [];
  const opacity = Math.min(1, Math.max(0, (p.opacity as number) / 100));
  const mode8 = (p.blend_mode as number) & 0xff;
  const blend = BLEND_MODES[mode8];
  if (!blend) notes.push('Its blend mode as normal');
  if ((p.blend_mode as number) & 0x80000000) notes.push('Reversed blending not imported');
  const masked = (mode & (MASK_DRAWN | MASK_CONDITIONAL)) !== 0;
  const uniform = !masked && opacity === 1 && (blend ?? 'normal') === 'normal';
  if (uniform && !(mode & MASK_RASTER && p.raster_mask_source)) return notes.length ? { notes } : null;
  if (!maskable)
    return {
      off: masked,
      notes: [
        masked ? 'Masked there: imported switched off (ours takes no mask)' : 'Its opacity and blend mode not imported',
        ...notes,
      ],
    };
  if (mode & MASK_RASTER && p.raster_mask_source)
    return { off: true, notes: ['A raster mask from another module: imported switched off', ...notes] };

  // Their scene-referred modes scale by p = 2^parameter (multiply: a·b·p); ours divide by
  // the fulcrum, middle grey times 2^blendFulcrum (a·b / fulcrum).
  const blendFulcrum = -(p.blend_parameter as number) - Math.log2(GREY);
  const mask: Mask = { ...defaultMask, opacity, blend: blend ?? 'normal', blendFulcrum };
  let shapes: Record<string, Shape> | undefined;
  const combine = p.mask_combine as number;
  if (mode & MASK_DRAWN && (p.mask_id as number) > 0) {
    const d = await drawn(p.mask_id as number, forms, aspect, notes);
    if (d.drawn.length) {
      shapes = d.shapes;
      mask.drawn = d.drawn;
    }
    // Their drawn mask's polarity, or an inverted lone shape.
    const drawnInverted = d.invert !== ((combine & COMBINE_MASKS_POS) !== 0);
    if (drawnInverted) {
      if (mode & MASK_CONDITIONAL) notes.push('An inverted drawn mask with ranges drawn as it is');
      else mask.invert = !mask.invert;
    }
  }
  if (mode & MASK_CONDITIONAL) Object.assign(mask, parametric(p, notes));
  if (mode & MASK_CONDITIONAL && combine & COMBINE_INCL) notes.push('Ranges combined inclusively read as exclusive');
  if (combine & COMBINE_INV) mask.invert = !mask.invert;
  const [feather, blur] = [p.feathering_radius as number, p.blur_radius as number];
  mask.feather = Math.max(0, feather) + Math.max(0, blur);
  mask.edgeAware = feather > 0;
  if (p.contrast !== 0 || p.brightness !== 0 || p.details !== 0)
    notes.push('Mask refinement (contrast, brightness, details) not imported');
  return { mask, ...(shapes && { shapes }), notes };
}

/** The forms as they stood at history entry `num` (their last state up to it). */
export function formsAt(masks: readonly DarktableMaskEntry[], num: number): DarktableMaskEntry[] {
  const nums = masks.map((m) => m.num).filter((n) => n <= num);
  if (!nums.length) return [];
  const at = Math.max(...nums);
  return masks.filter((m) => m.num === at);
}
