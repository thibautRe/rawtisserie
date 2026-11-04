/**
 * Video scopes of a render: waveform (RGB overlay), RGB parade and vectorscope.
 *
 * They are computed in the pipeline worker from the display-referred RGBA8 render
 * (before clipping indicators are painted), and drawn to a small RGBA8 image that
 * the page shows as is: the main thread never touches the pixels. Costs are bounded
 * by sampling at most `MAX_SAMPLES` pixels on a regular grid, which is plenty for a
 * scope a few hundred pixels wide.
 */

export type ScopeMode = 'waveform' | 'parade' | 'vectorscope';

export const SCOPE_MODES: readonly ScopeMode[] = ['waveform', 'parade', 'vectorscope'];

/** A scope to draw, `width × height` device pixels. */
export interface ScopeRequest {
  mode: ScopeMode;
  width: number;
  height: number;
  /** Vectorscope magnification (default 1): 2 spreads out the low-saturation centre. */
  zoom?: number;
}

/** The vectorscope's zoom levels. */
export const VECTORSCOPE_ZOOMS = [1, 2] as const;

/** Pixels sampled at most: ~300 per column of a scope as wide as the sidebar. */
export const MAX_SAMPLES = 150_000;

/** Background of the scope (near black, in both colour modes). */
const BG = 18;

/** BT.709 luma weights, applied to the encoded values as video scopes do. */
const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;

/** Chroma (BT.709 Cb/Cr, for values in 0..1) at the edge of the vectorscope at 1×. */
// Green and magenta are the most saturated 100 % colours (0.596): their targets fit.
export const VECTORSCOPE_RANGE = 0.64;

/** Angle of the skin-tone line, counter-clockwise from +Cb, in degrees. */
export const SKIN_TONE_ANGLE = 123;

/**
 * Where an encoded colour (`r`, `g`, `b` in 0..1) lands on a vectorscope of `size`
 * at `zoom`: Cb to the right, Cr up, the centre for neutral colours.
 */
export function vectorscopePoint(r: number, g: number, b: number, size: number, zoom = 1): [number, number] {
  const y = KR * r + KG * g + KB * b;
  const cb = (b - y) / (2 * (1 - KB));
  const cr = (r - y) / (2 * (1 - KR));
  const k = (size / 2 / VECTORSCOPE_RANGE) * zoom;
  return [size / 2 + cb * k, size / 2 - cr * k];
}

/** Grid step so that a `width × height` image gives at most `MAX_SAMPLES` samples. */
function sampleStep(width: number, height: number) {
  return Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)));
}

/**
 * Brightness of a bin holding `count` samples, relative to the typical (mean) filled
 * bin of `counts`: a square-root curve, so sparse traces stay visible and only dense
 * areas saturate.
 */
function brightnessLut(counts: readonly Uint32Array[]) {
  let maxCount = 0;
  let total = 0;
  let filled = 0;
  for (const a of counts)
    for (let i = 0; i < a.length; i++) {
      const c = a[i]!;
      if (c === 0) continue;
      total += c;
      filled++;
      if (c > maxCount) maxCount = c;
    }
  const ref = Math.max(1, (4 * total) / Math.max(1, filled));
  const lut = new Float32Array(maxCount + 1);
  for (let c = 1; c <= maxCount; c++) lut[c] = Math.min(1, Math.sqrt(c / ref));
  return lut;
}

/** Draw the scope of an RGBA8 render (`width × height`), as RGBA8 pixels. */
export function computeScope(
  data: ArrayLike<number>,
  width: number,
  height: number,
  req: ScopeRequest,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(req.width * req.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = BG;
    out[i + 3] = 255;
  }
  if (width < 1 || height < 1 || req.width < 3 || req.height < 2) return out;
  if (req.mode === 'vectorscope') vectorscope(data, width, height, req, out);
  else waveform(data, width, height, req, out, req.mode === 'parade');
  return out;
}

function waveform(
  data: ArrayLike<number>,
  width: number,
  height: number,
  { width: W, height: H }: ScopeRequest,
  out: Uint8ClampedArray,
  parade: boolean,
) {
  const step = sampleStep(width, height);
  // Columns of the scope for each channel: the whole width, or a third each.
  const sections = parade ? 3 : 1;
  const sectionWidth = Math.floor(W / sections);
  const colOf = new Int32Array(width);
  for (let x = 0; x < width; x++) colOf[x] = Math.min(sectionWidth - 1, Math.floor((x * sectionWidth) / width));
  const offset = parade ? [0, sectionWidth, 2 * sectionWidth] : [0, 0, 0];
  const rowOf = new Int32Array(256);
  for (let v = 0; v < 256; v++) rowOf[v] = Math.round(((255 - v) * (H - 1)) / 255) * W;

  const counts = [new Uint32Array(W * H), new Uint32Array(W * H), new Uint32Array(W * H)] as const;
  const [cr, cg, cb] = counts;
  const [or, og, ob] = offset as [number, number, number];
  for (let y = 0; y < height; y += step) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += step) {
      const i = row + x * 4;
      const col = colOf[x]!;
      cr[rowOf[data[i]!]! + col + or]!++;
      cg[rowOf[data[i + 1]!]! + col + og]!++;
      cb[rowOf[data[i + 2]!]! + col + ob]!++;
    }
  }

  const lut = brightnessLut(counts);
  const span = 255 - BG;
  // Primaries add up to white where the channels agree; blue is lifted a little to
  // stay legible on black (and red and green scaled down to keep greys neutral).
  for (let p = 0; p < W * H; p++) {
    const r = lut[cr[p]!]!;
    const g = lut[cg[p]!]!;
    const b = lut[cb[p]!]!;
    if (r === 0 && g === 0 && b === 0) continue;
    const o = p * 4;
    out[o] = BG + span * Math.min(1, (r + 0.15 * b) / 1.15);
    out[o + 1] = BG + span * Math.min(1, (g + 0.3 * b) / 1.3);
    out[o + 2] = BG + span * b;
  }
}

/**
 * Offsets in [-0.5, 0.5): the render's 8-bit values put colours on a lattice, which
 * shows as a hatched pattern once a code step is wider than a scope pixel (zoomed in).
 * Spreading each sample over a step hides it. Fixed, so a scope doesn't flicker.
 */
const DITHER = (() => {
  const t = new Float32Array(4096);
  let seed = 0x9e3779b9;
  for (let i = 0; i < t.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    t[i] = seed / 2 ** 32 - 0.5;
  }
  return t;
})();

function vectorscope(
  data: ArrayLike<number>,
  width: number,
  height: number,
  { width: W, height: H, zoom = 1 }: ScopeRequest,
  out: Uint8ClampedArray,
) {
  const size = Math.min(W, H);
  const left = Math.floor((W - size) / 2);
  const top = Math.floor((H - size) / 2);
  // Cb and Cr are linear in the encoded values: one table per channel and axis.
  // Colours beyond the edge (more of them when zoomed in) are left out.
  const k = (size / 2 / VECTORSCOPE_RANGE / 255) * zoom;
  const xr = new Float32Array(256);
  const xg = new Float32Array(256);
  const xb = new Float32Array(256);
  const yr = new Float32Array(256);
  const yg = new Float32Array(256);
  const yb = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    // Cb = (B − Y) / 1.8556, Cr = (R − Y) / 1.5748; x = Cb, y = −Cr.
    const cbScale = (v * k) / (2 * (1 - KB));
    const crScale = (v * k) / (2 * (1 - KR));
    xr[v] = -KR * cbScale;
    xg[v] = -KG * cbScale;
    xb[v] = (1 - KB) * cbScale;
    yr[v] = -(1 - KR) * crScale;
    yg[v] = KG * crScale;
    yb[v] = KB * crScale;
  }
  // Rounded to the nearest bin (neutrals fall exactly on the centre).
  const centre = size / 2 + 0.5;
  // About one code step of Cb or Cr, in scope pixels (`k` is per code value).
  const spread = k * 0.6;
  let d = 0;

  const n = size * size;
  const count = new Uint32Array(n);
  const sumR = new Uint32Array(n);
  const sumG = new Uint32Array(n);
  const sumB = new Uint32Array(n);
  const step = sampleStep(width, height);
  for (let y = 0; y < height; y += step) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += step) {
      const i = row + x * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const px = (centre + xr[r]! + xg[g]! + xb[b]! + spread * DITHER[d]!) | 0;
      const py = (centre + yr[r]! + yg[g]! + yb[b]! + spread * DITHER[d + 1]!) | 0;
      d = (d + 2) & 4095;
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const p = py * size + px;
      count[p]!++;
      sumR[p]! += r;
      sumG[p]! += g;
      sumB[p]! += b;
    }
  }

  const lut = brightnessLut([count]);
  const span = 255 - BG;
  for (let p = 0; p < n; p++) {
    const c = count[p]!;
    if (c === 0) continue;
    // The average colour of the bin, at full brightness, dimmed by its density.
    const r = sumR[p]!;
    const g = sumG[p]!;
    const b = sumB[p]!;
    const peak = Math.max(r, g, b, 1);
    const scale = (span * lut[c]!) / peak;
    const o = ((top + Math.floor(p / size)) * W + left + (p % size)) * 4;
    // Neutral greys are whitish, colours their own hue (mixed with a little white so
    // that dark blues stay visible).
    out[o] = BG + Math.min(span, 0.8 * r * scale + 0.2 * span * lut[c]!);
    out[o + 1] = BG + Math.min(span, 0.8 * g * scale + 0.2 * span * lut[c]!);
    out[o + 2] = BG + Math.min(span, 0.8 * b * scale + 0.2 * span * lut[c]!);
  }
}
