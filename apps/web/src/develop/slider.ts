/**
 * The maths of `ParamSlider`. `min`/`max` is the useful range. Only typing and values set
 * from elsewhere (auto-tune) go past it, up to the hard range, and the track then grows to
 * contain the value. Drags and arrow keys stay on the track.
 */

export interface SliderRange {
  min: number;
  max: number;
  step: number;
  /** The Ctrl/⌘ step, see `fineStep`. */
  fine: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Decimals that a step needs: 0.05 → 2, 0.5 → 1, 10 → 0. */
const decimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-6));
const rounded = (v: number, step: number) => Number(v.toFixed(decimals(step)));

/** Shift ×10, Ctrl/⌘ ×0.1. */
export const modifierFactor = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => (e.shiftKey ? 10 : e.ctrlKey || e.metaKey ? 0.1 : 1);

/**
 * A tenth of the step, but no finer than the number shown (a change you can't see isn't
 * an adjustment), and never coarser than the step.
 */
export function fineStep(step: number, format: (v: number) => string, scale: number) {
  const digits = /[.,](\d+)/.exec(format(0))?.[1]?.length ?? 0;
  return Math.max(step / 10, Math.min(step, 10 ** -digits / scale));
}

/**
 * How positions on a track map to values. Both directions are monotonic and inverse to
 * each other; the slider library, the fill and the track gradient work in positions, the
 * rest (steps, snapping, typing) in values.
 */
export interface SliderCurve {
  toPosition(v: number): number;
  toValue(p: number): number;
}

export const LINEAR: SliderCurve = { toPosition: (v) => v, toValue: (p) => p };

/**
 * Finer around 0 and coarser toward ±`range`, which stay in place (and so does 0):
 * `v = range · sinh(k·p/range) / sinh(k)`. With k = 2, a pixel moves the value 0.55× as
 * much as on a linear track in the middle, and 2.07× at ±range.
 */
export function sinhCurve(range: number, k = 2): SliderCurve {
  const s = Math.sinh(k);
  return { toValue: (p) => (range * Math.sinh((k * p) / range)) / s, toPosition: (v) => (range / k) * Math.asinh((v * s) / range) };
}

const stepSize = (factor: number, { step, fine }: SliderRange) => (factor === 1 ? step : factor < 1 ? fine : step * factor);

export type Extent = readonly [number, number];

/**
 * What the track covers: `extent` (the useful range at first) grown to contain the value,
 * or `extent` itself if it already does. It doesn't shrink back, so that the thumb and the
 * scale don't move on their own. Bipolar parameters grow on both sides, which keeps their
 * neutral point in the middle.
 */
export function growExtent(extent: Extent, value: number, { min, max }: Pick<SliderRange, 'min' | 'max'>): Extent {
  if (value >= extent[0] && value <= extent[1]) return extent;
  if (min === -max) {
    const m = Math.abs(value);
    return [-m, m];
  }
  return [Math.min(extent[0], value), Math.max(extent[1], value)];
}

/** `value` moved by `steps` steps, staying on the track. */
export function nudge(value: number, steps: number, factor: number, range: SliderRange, [lo, hi]: Extent) {
  const size = stepSize(factor, range);
  return clamp(rounded(value + steps * size, size), lo, hi);
}

/** A plain drag: the pointer's position on the track, snapped to the step. */
export const snapTo = (raw: number, [lo, hi]: Extent, { min, step }: SliderRange, curve = LINEAR) => {
  const v = curve.toValue(raw);
  return clamp(rounded(min + Math.round((v - min) / step) * step, step), lo, hi);
};

/** Set once a drag is relative to the pointer, because of a modifier. */
export type DragAnchor = { position: number; value: number; factor: number } | null;

/**
 * A relative drag, with `position` in the track's units (`curve` positions). A new factor
 * starts from where the value is, so that neither pressing nor releasing a modifier makes
 * it jump.
 */
export function dragTo(anchor: DragAnchor, position: number, factor: number, value: number, range: SliderRange, [lo, hi]: Extent, curve = LINEAR): { anchor: DragAnchor; value: number } {
  if (anchor?.factor !== factor) return { anchor: { position, value, factor }, value };
  const moved = curve.toValue(curve.toPosition(anchor.value) + (position - anchor.position) * factor);
  return { anchor, value: clamp(rounded(moved, stepSize(factor, range)), lo, hi) };
}

/** The value to start typing from, in display units. */
export const typedText = (value: number, scale: number) => String(Number((value * scale).toFixed(6)));

/**
 * A typed value, in display units, clamped to the module's hard range. Null if it isn't a
 * number. Accepts a decimal comma, a sign and a trailing unit ("+1,5 EV").
 */
export function parseTyped(text: string, scale: number, hardMin: number, hardMax: number) {
  const v = Number.parseFloat(text.trim().replace(',', '.').replace('−', '-'));
  return Number.isFinite(v) ? clamp(v / scale, hardMin, hardMax) : null;
}

const ramp = (...stops: string[]) => `linear-gradient(to right, ${stops.join(', ')})`;

/** Gradient tracks, showing what a value does. */
export const tracks = {
  grey: ramp('#1c1c1c', '#e6e6e6'),
  /** Less (left) or more (right) of a channel. */
  channel: (color: string) => ramp('#4a4a4a', '#b9b9b9', color),
  /** Colour primaries, for a CSS hue. A positive hue shift goes up the CSS hue circle. */
  hue: (hue: number) => ramp(...[-180, -120, -60, 0, 60, 120, 180].map((d) => `hsl(${hue + d} 70% 55%)`)),
  /** Like `hue`, for a slider spanning ±90°, with the colours where `curve` puts them. */
  hueQuarter: (hue: number, curve = LINEAR) => {
    const [lo, hi] = [curve.toPosition(-90), curve.toPosition(90)];
    const at = (d: number) => ((curve.toPosition(d) - lo) / (hi - lo)) * 100;
    return ramp(...Array.from({ length: 13 }, (_, i) => -90 + i * 15).map((d) => `hsl(${hue + d} 70% 55%) ${at(d).toFixed(2)}%`));
  },
  saturation: (hue: number) => ramp('#8a8a8a', `hsl(${hue} 85% 50%)`),
  brightness: (hue: number) => ramp(`hsl(${hue} 70% 18%)`, `hsl(${hue} 70% 72%)`),
};
