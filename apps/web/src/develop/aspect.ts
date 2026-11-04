import type { CropRect } from '@rawtisserie/pipeline';

/** The crop tool's aspect ratio setting. */
export interface CropAspect {
  /** A value of `ASPECTS`. */
  preset: string;
  /** The ratio typed for the `custom` preset, e.g. `51:48` or `16/9`. */
  custom: string;
  /** Height and width swapped (portrait for the landscape presets). */
  flipped: boolean;
}

export const FREE_ASPECT: CropAspect = { preset: 'free', custom: '', flipped: false };

/** Ratios are width / height, landscape: `CropAspect.flipped` gives the portrait ones. */
export const ASPECTS = [
  { value: 'free', label: 'Free', ratio: null },
  { value: 'original', label: 'Original', ratio: 'original' },
  { value: '1:1', label: '1:1', ratio: 1 },
  { value: '5:4', label: '5:4', ratio: 5 / 4 },
  { value: '4:3', label: '4:3', ratio: 4 / 3 },
  { value: '7:5', label: '7:5', ratio: 7 / 5 },
  { value: '3:2', label: '3:2', ratio: 3 / 2 },
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  // The Hasselblad XPan's 24×65 mm panoramic frame.
  { value: 'xpan', label: 'XPan (65:24)', ratio: 65 / 24 },
  { value: 'custom', label: 'Custom…', ratio: 'custom' },
] as const;

/** Parse a typed ratio: `51:48`, `16/9`, `16x9`, `16*9` or a plain number such as `2.39`. */
export function parseAspect(text: string): number | null {
  const num = String.raw`(\d+(?:[.,]\d+)?|[.,]\d+)`;
  const m = new RegExp(String.raw`^\s*${num}\s*(?:[:/x×*]\s*${num}\s*)?$`, 'i').exec(text);
  if (!m) return null;
  const w = Number(m[1]!.replace(',', '.'));
  const h = m[2] === undefined ? 1 : Number(m[2].replace(',', '.'));
  const ratio = w / h;
  // Beyond 1:100, the crop would be a line.
  return Number.isFinite(ratio) && ratio >= 0.01 && ratio <= 100 ? ratio : null;
}

/** The width / height ratio in pixels the crop must keep, or null for free-form. */
export function aspectRatio(aspect: CropAspect, frameAspect: number): number | null {
  const preset = ASPECTS.find((a) => a.value === aspect.preset)?.ratio ?? null;
  const ratio = preset === 'original' ? frameAspect : preset === 'custom' ? parseAspect(aspect.custom) : preset;
  return ratio && aspect.flipped ? 1 / ratio : ratio;
}

/** A preset's label, with its ratio written the other way round when flipped. */
export function aspectLabel(label: string, flipped: boolean): string {
  return flipped ? label.replace(/(\d+):(\d+)/, '$2:$1') : label;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fit `rect` to an aspect ratio, keeping its centre and area, and staying in the frame. */
export function constrainAspect(rect: CropRect, aspect: number | null, frameAspect: number): CropRect {
  if (!aspect) return rect;
  // In normalised units, width/height must equal aspect / frameAspect.
  const k = aspect / frameAspect;
  let w = Math.sqrt(rect.width * rect.height * k);
  let h = w / k;
  const scale = Math.min(1, 1 / w, 1 / h);
  w *= scale;
  h *= scale;
  return place(rect, w, h);
}

/** Swap the crop's width and height in pixels, around its centre, shrinking it to fit the frame. */
export function flipCrop(rect: CropRect, frameAspect: number): CropRect {
  let w = rect.height / frameAspect;
  let h = rect.width * frameAspect;
  const scale = Math.min(1, 1 / w, 1 / h);
  w *= scale;
  h *= scale;
  return place(rect, w, h);
}

/** A `w` × `h` rectangle centred on `rect`'s centre, moved into the frame. */
function place(rect: CropRect, w: number, h: number): CropRect {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), width: w, height: h };
}

/** Whether the crop is taller than wide, in pixels. */
export const isPortrait = (rect: CropRect, frameAspect: number) => rect.height > rect.width * frameAspect;
