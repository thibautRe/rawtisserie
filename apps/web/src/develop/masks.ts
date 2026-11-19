/**
 * Mask editing helpers (roadmap 4.5): the parametric ranges' sliders (`MaskEditor.tsx`)
 * and their tracks. A range `[a, b, c, d]` is 0 below `a`, rises to 1 at `b`, stays 1
 * up to `c` and falls to 0 at `d` (`ops/mask.rs`).
 */
import type { Mask, MaskRange } from '@rawtisserie/pipeline';

export type RangeKey = 'luminance' | 'saturation' | 'hue' | 'red' | 'green' | 'blue';

/** In the order of the editor's tabs. */
export const RANGE_KEYS: readonly RangeKey[] = ['luminance', 'saturation', 'hue', 'red', 'green', 'blue'];

export interface RangeConfig {
  label: string;
  /** On its tab. */
  tab: string;
  /** What the track shows, unless the range goes past it. */
  min: number;
  max: number;
  /** How far handles go, dragged past the ends of the track. */
  hardMin: number;
  hardMax: number;
  step: number;
  /** What switching the range on selects. */
  initial: MaskRange;
  /** Hue: positions wrap around the track. */
  wrap: boolean;
  format: (v: number) => string;
  /** CSS background of the track, when it shows `min` … `max`. */
  track: (min: number, max: number) => string;
  hint: string;
}

/** A linear CSS gradient with `stops` (`[value, colour]`) placed on a `min` … `max` track. */
const gradient = (min: number, max: number, stops: [number, string][]) =>
  `linear-gradient(to right, ${stops.map(([v, c]) => `${c} ${(((v - min) / (max - min)) * 100).toFixed(1)}%`).join(', ')})`;

const signed = (v: number, digits: number) => `${v > 0 ? '+' : ''}${(v + 0).toFixed(digits)}`;

// CIE 1976 u′v′ of the working space's white (D65), as `ops/mask.rs` measures hues.
const WHITE = [0.95047, 1, 1.08883] as const;
const WHITE_D = WHITE[0] + 15 * WHITE[1] + 3 * WHITE[2];
const UN = (4 * WHITE[0]) / WHITE_D;
const VN = (9 * WHITE[1]) / WHITE_D;
const REC709_FROM_XYZ = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

/** A CSS colour of the hue `degrees` as masks measure it. */
export function hueCss(degrees: number): string {
  const t = (degrees * Math.PI) / 180;
  const u = UN + 0.06 * Math.cos(t);
  const v = VN + 0.06 * Math.sin(t);
  const xyz = [(9 * u) / (4 * v), 1, (12 - 3 * u - 20 * v) / (4 * v)];
  const rgb = REC709_FROM_XYZ.map((row) => Math.max(0, row[0]! * xyz[0]! + row[1]! * xyz[1]! + row[2]! * xyz[2]!));
  const max = Math.max(...rgb);
  const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const hex = rgb.map((c) =>
    Math.round(encode(c / max) * 255)
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${hex.join('')}`;
}

const HUE_TRACK = gradient(
  0,
  360,
  Array.from({ length: 25 }, (_, i) => [i * 15, hueCss(i * 15)]),
);

const RANGES_LUMINANCE: RangeConfig = {
  label: 'Luminance',
  tab: 'Luminance',
  min: -12,
  max: 6,
  // The pipeline's luminance tables span 2⁻²⁴ … 2¹⁶.
  hardMin: -21,
  hardMax: 18,
  step: 0.1,
  initial: [-3, -1, 1, 3],
  wrap: false,
  format: (v) => `${signed(v, 1)} EV`,
  // As filmic shows it, roughly: black at -8 EV, white at +3.
  track: (min, max) =>
    gradient(min, max, [
      [min, '#000'],
      [-8, '#000'],
      [3, '#fff'],
      [max, '#fff'],
    ]),
  hint: 'Luminance of the module’s input, in EV from middle gray',
};

export const RANGES: Record<RangeKey, RangeConfig> = {
  luminance: RANGES_LUMINANCE,
  saturation: {
    label: 'Saturation',
    tab: 'Saturation',
    min: 0,
    max: 2,
    hardMin: 0,
    hardMax: 6,
    step: 0.01,
    initial: [0.15, 0.3, 2, 2],
    wrap: false,
    format: (v) => v.toFixed(2),
    track: (min, max) =>
      gradient(min, max, [
        [min, '#8a8a8a'],
        [0.9, '#c46a3c'],
        [Math.max(2, max), '#ff3a00'],
      ]),
    hint: 'Distance from gray (CIE u′v′): about 0.6 for skin, 1 for a blue sky',
  },
  hue: {
    label: 'Hue',
    tab: 'Hue',
    min: 0,
    max: 360,
    hardMin: 0,
    hardMax: 360,
    step: 1,
    initial: [330, 350, 30, 50],
    wrap: true,
    format: (v) => `${Math.round(v)}°`,
    track: () => HUE_TRACK,
    hint: 'Hue around gray (CIE u′v′); grays have none',
  },
  red: channel('Red', '#ff0000'),
  green: channel('Green', '#00ff00'),
  blue: channel('Blue', '#0000ff'),
};

/** A channel's range: in EV from middle gray, like luminance, from black to the channel's colour. */
function channel(name: string, color: string): RangeConfig {
  return {
    ...RANGES_LUMINANCE,
    label: name,
    tab: name[0]!,
    track: (min, max) =>
      gradient(min, max, [
        [min, '#000'],
        [-8, '#000'],
        [3, color],
        [max, color],
      ]),
    hint: `The ${name.toLowerCase()} channel of the module’s input (linear Rec.2020), in EV from middle gray`,
  };
}

/** Index of a range's handles: `a`, `b`, `c`, `d`. */
export type Handle = 0 | 1 | 2 | 3;

const mod = (v: number, n: number) => ((v % n) + n) % n;

/**
 * `range` with handle `h` moved to `value`, keeping `a ≤ b ≤ c ≤ d`: the handles it
 * pushes against move with it. Hue positions are taken around the circle from `a`
 * (the first handle moves the whole range's start, so the others keep their offsets
 * unless pushed).
 */
export function moveHandle(range: MaskRange, h: Handle, value: number, c: RangeConfig): MaskRange {
  if (!c.wrap) {
    const v = round(Math.min(c.hardMax, Math.max(c.hardMin, value)), c.step);
    const r = [...range] as MaskRange;
    r[h] = v;
    for (let i = h + 1; i < 4; i++) r[i] = Math.max(r[i]!, v);
    for (let i = h - 1; i >= 0; i--) r[i] = Math.min(r[i]!, v);
    return r;
  }
  // Offsets from `a`, in [0, 360).
  const v = mod(value, 360);
  const off = range.map((x) => mod(x - range[0], 360)) as MaskRange;
  if (h === 0) {
    // Moving `a` towards `b` pushes it; away, it widens the rise.
    const delta = mod(v - range[0] + 180, 360) - 180;
    const offsets = off.map((o, i) => (i === 0 ? 0 : Math.max(0, o - delta))) as MaskRange;
    for (let i = 2; i < 4; i++) offsets[i] = Math.max(offsets[i]!, offsets[i - 1]!);
    return offsets.map((o) => round(mod(v + o, 360), c.step)) as MaskRange;
  }
  const o = mod(v - range[0], 360);
  // Past the end of the circle (just behind `a`), the handle stays at its end.
  const prev = off[h - 1]!;
  const clamped = o < prev && prev - o < 180 ? prev : o;
  off[h] = clamped;
  for (let i = h + 1; i < 4; i++) off[i] = Math.max(off[i]!, clamped);
  for (let i = h - 1; i >= 1; i--) off[i] = Math.min(off[i]!, clamped);
  return off.map((x) => round(mod(range[0] + x, 360), c.step)) as MaskRange;
}

/** `range` moved by `delta` as a whole, within the hard limits (around the circle, for hues). */
export function shiftRange(range: MaskRange, delta: number, c: RangeConfig): MaskRange {
  if (c.wrap) return range.map((x) => round(mod(x + delta, 360), c.step)) as MaskRange;
  const d = Math.min(c.hardMax - range[3], Math.max(c.hardMin - range[0], delta));
  return range.map((x) => round(x + d, c.step)) as MaskRange;
}

const round = (v: number, step: number) => {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v.toFixed(digits));
};

/**
 * What a track shows of a range: `min` … `max`, widened to the range where it goes past
 * them (not for hues).
 */
export function trackSpan(range: MaskRange | null, c: RangeConfig): [number, number] {
  if (!range || c.wrap) return [c.min, c.max];
  return [Math.min(c.min, range[0]), Math.max(c.max, range[3])];
}

/** How fast a track widens while a handle is held past one of its ends: a share of its usual span per second. */
export const GROW_PER_SECOND = 0.25;

/**
 * `span` widened on one `side` (-1: left, 1: right) for `seconds` of a handle held past
 * that end, within the hard limits. Hue tracks don't widen.
 */
export function growSpan(span: [number, number], side: -1 | 1, seconds: number, c: RangeConfig): [number, number] {
  if (c.wrap) return span;
  const by = GROW_PER_SECOND * (c.max - c.min) * seconds;
  return side > 0 ? [span[0], Math.min(c.hardMax, span[1] + by)] : [Math.max(c.hardMin, span[0] - by), span[1]];
}

/**
 * The outline of a range over a track of `width` × `height` showing `span`: polygons (in
 * pixels, `a`, `b`, `c`, `d`) of where it selects, full height where it is 1. A hue range
 * that wraps gives two.
 */
export function rangePolygons(
  range: MaskRange,
  c: RangeConfig,
  width: number,
  height: number,
  span: [number, number] = [c.min, c.max],
): string[] {
  const x = (v: number) => ((v - span[0]) / (span[1] - span[0])) * width;
  const poly = (r: number[]) =>
    [
      [x(r[0]!), height],
      [x(r[1]!), 0],
      [x(r[2]!), 0],
      [x(r[3]!), height],
    ]
      .map(([px, py]) => `${px!.toFixed(1)},${py}`)
      .join(' ');
  if (!c.wrap) return [poly(range)];
  // Unwrapped from `a`, then drawn again one turn to the left so that the part past 360° shows.
  const a = range[0];
  const unwrapped = range.map((v) => a + mod(v - a, 360));
  return [poly(unwrapped), poly(unwrapped.map((v) => v - 360))];
}

/** Whether a mask does anything (Rust's `Mask::is_identity`, negated): switched off, it doesn't. */
export function maskIsActive(mask: Mask | undefined): boolean {
  return (
    !!mask &&
    mask.enabled &&
    (mask.drawn.length > 0 ||
      RANGE_KEYS.some((k) => mask[k]) ||
      mask.invert ||
      mask.opacity < 1 ||
      mask.blend !== 'normal')
  );
}

/**
 * What a mask does, in a few words (`2 shapes · luminance · 60 %`), for where it's
 * folded or listed: its shapes, ranges, inversion, opacity and blend mode.
 */
export function maskSummary(mask: Mask): string {
  const n = mask.drawn.length;
  const parts = [
    n ? `${n} shape${n === 1 ? '' : 's'}` : null,
    ...RANGE_KEYS.filter((k) => mask[k]).map((k) => RANGES[k].label.toLowerCase()),
    mask.invert ? 'inverted' : null,
    mask.opacity < 1 ? `${Math.round(mask.opacity * 100)} %` : null,
    mask.blend !== 'normal' ? mask.blend.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`) : null,
  ].filter(Boolean);
  if (!mask.enabled) return parts.length ? `off · ${parts.join(' · ')}` : 'off';
  return parts.join(' · ') || 'everywhere';
}
