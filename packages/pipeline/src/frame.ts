/**
 * Frame: borders around an exported image (an export setting, not part of the
 * recipe). Mirrors `crates/pipeline/src/frame.rs`; `frame.test.ts` compares both.
 * Lengths are fractions of the image's shorter side.
 */
export type FrameOrientation = 'auto' | 'portrait' | 'landscape';

export interface Frame {
  /** Border on each side, as a fraction of the image's shorter side. */
  size: number;
  /** Aspect ratio of the framed image, long side over short side (≥ 1), or 0 to keep the image's. */
  aspect: number;
  /** With an aspect ratio: `auto` is the image's (landscape if wider than tall). */
  orientation: FrameOrientation;
  /** Where the image sits in the extra space an aspect ratio adds: 0 left/top, 0.5 centred, 1 right/bottom. */
  position: [number, number];
  /** `#rrggbb`, sRGB. */
  color: string;
  /** Width of a line around the image, as a fraction of its shorter side (0: none). */
  line: number;
  /** Gap between the image and the line, same unit. */
  lineOffset: number;
  lineColor: string;
}

export const DEFAULT_FRAME: Frame = {
  size: 0.05,
  aspect: 0,
  orientation: 'auto',
  position: [0.5, 0.5],
  color: '#ffffff',
  line: 0,
  lineOffset: 0,
  lineColor: '#000000',
};

/** Where everything goes in the framed image, in pixels. */
export interface FrameLayout {
  width: number;
  height: number;
  /** Top-left corner of the image. */
  x: number;
  y: number;
  lineOffset: number;
  /** 0: no line. */
  lineWidth: number;
}

// Rust's `f32::round` rounds halves away from zero; lengths are never negative.
const round = (v: number) => Math.round(Math.fround(Math.max(0, v)));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const f32 = Math.fround;

/** The layout of a `width × height` image in `frame` (`Frame::layout`). */
export function frameLayout(frame: Frame, width: number, height: number): FrameLayout {
  const short = Math.min(width, height);
  const border = round(f32(clamp(frame.size, 0, 10)) * short);
  let w = width + 2 * border;
  let h = height + 2 * border;
  if (frame.aspect >= 1) {
    const landscape = frame.orientation === 'auto' ? width > height : frame.orientation === 'landscape';
    const ratio = f32(landscape ? frame.aspect : f32(1 / f32(frame.aspect)));
    if (w < f32(h * ratio)) w = Math.max(round(f32(h * ratio)), w);
    else h = Math.max(round(f32(w / ratio)), h);
  }
  const place = (extra: number, at: number) => border + Math.min(round(f32(extra * clamp(at, 0, 1))), extra);
  const lineWidth = frame.line > 0 ? Math.max(round(f32(frame.line) * short), 1) : 0;
  return {
    width: w,
    height: h,
    x: place(w - width - 2 * border, frame.position[0]),
    y: place(h - height - 2 * border, frame.position[1]),
    lineOffset: lineWidth > 0 ? round(f32(frame.lineOffset) * short) : 0,
    lineWidth,
  };
}
