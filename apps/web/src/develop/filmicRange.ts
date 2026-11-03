/**
 * Filmic's white and black relative exposures and its dynamic range scaling move each
 * other. The scaling says how much the range differs from an unscaled one (what
 * auto-tune measures):
 *
 *   white = unscaled white × (1 + scaling / 100), and the same for black.
 *
 * Moving the scaling rescales white and black around middle grey, as Ansel does.
 * Moving white or black keeps the unscaled dynamic range and updates the scaling.
 */
export type FilmicRange = { whiteExposure: number; blackExposure: number; dynamicRangeScaling: number };

// The sliders' hard limits (and auto-tune's for the scaling).
const WHITE = [0.1, 16] as const;
const BLACK = [-16, -0.1] as const;
const SCALING = [-50, 200] as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const factor = (scaling: number) => 1 + scaling / 100;

export function pickRange(p: FilmicRange): FilmicRange {
  return { whiteExposure: p.whiteExposure, blackExposure: p.blackExposure, dynamicRangeScaling: p.dynamicRangeScaling };
}

/** The range after setting `key` to `value`, starting from `from`. */
export function moveRange(from: FilmicRange, key: keyof FilmicRange, value: number): FilmicRange {
  if (key === 'dynamicRangeScaling') {
    const scaling = clamp(value, SCALING);
    const ratio = factor(scaling) / factor(from.dynamicRangeScaling);
    return {
      whiteExposure: round(clamp(from.whiteExposure * ratio, WHITE), 3),
      blackExposure: round(clamp(from.blackExposure * ratio, BLACK), 3),
      dynamicRangeScaling: scaling,
    };
  }
  const next = { ...from, [key]: value };
  const unscaled = (from.whiteExposure - from.blackExposure) / factor(from.dynamicRangeScaling);
  const scaling = ((next.whiteExposure - next.blackExposure) / unscaled - 1) * 100;
  return { ...next, dynamicRangeScaling: round(clamp(scaling, SCALING), 2) };
}
