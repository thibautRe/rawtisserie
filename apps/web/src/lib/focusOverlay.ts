/**
 * How a focus map (roadmap 8.9) is drawn over a photo: its cells as pixels of a small
 * image that the browser stretches smoothly over the photo, tinted where the photo is
 * sharp and clear elsewhere (blurred, or without detail to tell).
 */
import { decodeCells, type FocusView, NO_DETAIL } from '@rawtisserie/pipeline';

/** The tint, in sRGB. */
export const FOCUS_TINT = [64, 224, 120] as const;
/** Cells at least this sharp (0…1) are tinted, fully from `FULL`. */
const FROM = 0.45;
const FULL = 0.85;
/** Opacity of the fully sharp cells. */
const MAX_ALPHA = 0.6;

/** The overlay's pixels (`cols × rows`, RGBA). */
export function focusOverlayPixels(view: FocusView): Uint8ClampedArray<ArrayBuffer> {
  const cells = decodeCells(view.cells);
  const out = new Uint8ClampedArray(view.cols * view.rows * 4);
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]!;
    const s = v === NO_DETAIL ? 0 : v / 254;
    const t = Math.min(1, Math.max(0, (s - FROM) / (FULL - FROM)));
    out[i * 4] = FOCUS_TINT[0];
    out[i * 4 + 1] = FOCUS_TINT[1];
    out[i * 4 + 2] = FOCUS_TINT[2];
    out[i * 4 + 3] = Math.round(255 * MAX_ALPHA * t * t * (3 - 2 * t));
  }
  return out;
}
