//! Tone curve, after Ansel's `rgbcurve.c` (GPL-3.0-or-later; upstream
//! github.com/aurelienpierreeng/ansel, `src/iop/rgbcurve.c` and `src/pixel/rgb_norms.h`
//! at `2b8664f4d3`), drawn like its tone equalizer (`toneequal.c`).
//!
//! Like `rgbcurve.c`: linked or independent RGB curves; linked ones either apply to each
//! channel or scale the pixel by `curve(norm) / norm`, which keeps its hue and saturation.
//!
//! Deviations:
//! * A curve is an exposure offset (EV) as a function of the input exposure (EV relative
//!   to middle grey), through fixed, evenly spaced nodes, as the tone equalizer's is;
//!   not output against input through free nodes on linear 0 … 1. The image is
//!   scene-referred here, with no 1 to stop at, and a flat curve reads as "no change".
//!   It's the contrast equalizer's Catmull-Rom ([`equalizer::curve`]), so the editor
//!   draws what renders; past the end nodes the offset stays the end node's. Unlike
//!   the tone equalizer, it's global: no guided filter. The nodes' range is a
//!   parameter, fitted to the module's input on demand ([`measure`]), as the tone
//!   equalizer's mask exposure and contrast compensations are.
//! * Norms are scaled so that a grey's is its value, so that the curve's axis means
//!   the same with each: "sum" is then "average" and is left out, and "norm" is ÷ √3.
//! * Each curve is baked into a gain table indexed by the input's float bits, as
//!   shadows/highlights is, rather than a 64k table on 0 … 1.
//!
//! Preserving detail (`ToneCurve::preserve_detail`) makes it Ansel's tone equalizer
//! (`toneequal.c`, with `src/pixel/eigf.h` at `2b8664f4d3`): the curve reads, rather
//! than each pixel's norm, a mask of it smoothed by the exposure-independent guided
//! filter (EIGF), its "details" default. Areas then move as a whole and keep their
//! texture. The mask ([`Local::plane`]) needs neighbours: the developer computes its
//! statistics (the smoothed local mean and variance of the norm, [`Local::stats`]) with
//! the spatial stages, on the module's input, and the point pass reads them as planes
//! ([`plane_ids`]) and blends them with the pixel's norm, as upstream's last step does.
//! Deviations from upstream:
//!
//! * No mask exposure and contrast compensations: the nodes' range does that job (the
//!   filter is exposure-independent, so only the contrast compensation would change
//!   what it does, a little). No quantization, a single iteration, and no "averaged"
//!   (geometric mean) variants.
//! * The statistics (mean and mean square of the norm) are averaged over cells of up
//!   to 16×16 pixels, aligned on the frame, before the Gaussian, from a sample per
//!   4×4 block (like upstream's subsampling; only those of the input are computed),
//!   placed by a hash of the block so that fine regular textures don't alias. Cells and
//!   samples are on the frame's grid, so a region of the frame gets the same mask as
//!   the whole.
//! * The Gaussian is the crate's (three box blurs above a sigma of 4).

use crate::color::{LUMA_REC2020, MIDDLE_GREY};
use crate::image::{Image, Rgb};
use crate::ops::lut::{BitsLut, CEILING, FINE, FLOOR, log2_fast};
use crate::ops::{equalizer, filters};
use crate::params::{CurveChannels, RgbNorm, TONE_CURVE_MAX_OFFSET, TONE_CURVE_MIN_RANGE, TONE_CURVE_NODES, TONE_EDGE_RANGE, TONE_SMOOTHING_RANGE, ToneCurve};

/// The offset (EV) a curve gives at input exposure `ev` (EV relative to middle grey),
/// with its first and last nodes at `[lo, hi]`.
pub fn offset(nodes: &[f32; TONE_CURVE_NODES], [lo, hi]: [f32; 2], ev: f32) -> f32 {
    // On 0 … 1 both ways, as the editor draws it.
    let m = TONE_CURVE_MAX_OFFSET;
    let unit = nodes.map(|v| 0.5 + v.clamp(-m, m) / (2.0 * m));
    (equalizer::curve(&unit, (ev - lo) / (hi - lo)) - 0.5) * 2.0 * m
}

/// The curve's gain on linear values, its offsets scaled by `strength`: what to
/// multiply `v` by.
fn gain_table(nodes: &[f32; TONE_CURVE_NODES], range: [f32; 2], strength: f32) -> BitsLut<f32> {
    BitsLut::new(FLOOR, CEILING, FINE, |v| (offset(nodes, range, (v / MIDDLE_GREY).log2()) * strength).exp2())
}

/// The ids of the planes holding the mask statistics of tone curve instance `id` when
/// it preserves detail (the local mean and variance of its norm), among the masks'
/// planes (`crate::ops::mask::MaskPlane`).
pub fn plane_ids(id: &str) -> [String; 2] {
    [format!("{id}#tones-mean"), format!("{id}#tones-var")]
}

/// Smallest value of the mask (Ansel's), so that it has an exposure.
const MASK_FLOOR: f32 = 1.0 / 65536.0;
/// Most halvings of the statistics before the Gaussian (cells of 16×16 pixels).
const MAX_LEVEL: u32 = 4;
/// The narrowest the Gaussian may be on the reduced statistics, in their cells.
const MIN_SIGMA: f32 = 2.0;
/// Most pixels between samples of the input, each way (Ansel's subsampling).
const MAX_STEP: usize = 4;

/// What the mask of a curve preserving detail depends on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Local {
    norm: RgbNorm,
    /// The smoothing diameter, a fraction of the frame's long side.
    smoothing: f32,
    /// Ansel's `feathering` (the inverse of the edge refinement): how much variance an
    /// edge needs to be kept.
    feathering: f32,
}

/// Where the mask's statistics are sampled, over an image at `origin` in its frame:
/// every `step`-th pixel of the frame each way, over cells aligned on the frame and out
/// to whole cells. Samples outside the image repeat its edges.
pub struct Samples {
    /// Columns and rows of the image to sample (with repeats at the edges).
    pub cols: Vec<usize>,
    pub rows: Vec<usize>,
    /// Halvings of the cells (`2^level` pixels a side), and the Gaussian's sigma there.
    level: u32,
    sigma: f32,
    /// The first cell's corner, in the frame.
    corner: (usize, usize),
}

impl Local {
    /// `None` unless `p` preserves detail.
    pub fn of(p: &ToneCurve) -> Option<Self> {
        let [s0, s1] = TONE_SMOOTHING_RANGE;
        let [e0, e1] = TONE_EDGE_RANGE;
        p.preserve_detail.then(|| Local { norm: p.local_norm(), smoothing: p.smoothing.clamp(s0, s1), feathering: 1.0 / p.edge_refinement.clamp(e0, e1) })
    }

    /// The Gaussian's sigma in a frame of `frame` pixels: Ansel's radius, from the
    /// diameter (`(d - 1) / 2`).
    fn sigma(&self, frame: (usize, usize)) -> f32 {
        ((self.smoothing * frame.0.max(frame.1) as f32 - 1.0) / 2.0).max(0.0)
    }

    /// The halvings of the statistics, and the Gaussian's sigma there (reduced by what
    /// averaging and interpolation add, as glow's), or `None` without smoothing (the
    /// mask is then the norm).
    fn levels(&self, frame: (usize, usize)) -> Option<(u32, f32)> {
        let sigma = self.sigma(frame);
        if sigma < 0.5 {
            return None;
        }
        let level = ((sigma / MIN_SIGMA).max(1.0).log2().floor() as u32).min(MAX_LEVEL);
        let d = (1u32 << level) as f32;
        let reduced = if level == 0 { sigma } else { (sigma * sigma - d * d / 4.0).max(0.0).sqrt() / d };
        Some((level, reduced))
    }

    /// How far, in pixels, the mask reads around each pixel in a frame of `frame` pixels.
    pub fn reach(&self, frame: (usize, usize)) -> usize {
        match self.levels(frame) {
            None => 0,
            Some((0, sigma)) => filters::reach(sigma),
            // The blur, the cells, the interpolation's neighbour, and rounding out to cells.
            Some((level, sigma)) => (filters::reach(sigma) + 3) * (1 << level),
        }
    }

    /// Where to sample the input of an image of `size` at `origin` in a frame of `frame`
    /// pixels, or `None` without smoothing.
    pub fn samples(&self, origin: (usize, usize), size: (usize, usize), frame: (usize, usize)) -> Option<Samples> {
        let (level, sigma) = self.levels(frame)?;
        let ((ox, oy), (w, h)) = (origin, size);
        if w == 0 || h == 0 {
            return None;
        }
        let d = 1usize << level;
        let step = d.min(MAX_STEP);
        let (fx0, fy0) = (ox / d * d, oy / d * d);
        let (fx1, fy1) = ((ox + w).next_multiple_of(d), (oy + h).next_multiple_of(d));
        // Each sample somewhere in its `step × step` block of the frame, by a hash of the
        // block's column and row: on a regular grid, a fine regular texture would alias.
        let at = |f0: usize, f1: usize, o: usize, len: usize, salt: u32| {
            let jitter = |block: usize| (hash(block as u32 ^ salt) as usize) % step;
            (f0..f1).step_by(step).map(|f| (f + jitter(f / step)).saturating_sub(o).min(len - 1)).collect::<Vec<_>>()
        };
        let (cols, rows) = (at(fx0, fx1, ox, w, 0), at(fy0, fy1, oy, h, 0x9e37_79b9));
        Some(Samples { cols, rows, level, sigma, corner: (fx0, fy0) })
    }

    /// The mask's statistics over an image of `size` at `origin` in its frame, from
    /// `input`, the module's input at `samples` (row-major, a row per sampled row): the
    /// smoothed mean and variance of the norm at each pixel (see [`Local::mask`]).
    pub fn stats(&self, samples: &Samples, input: &[Rgb], origin: (usize, usize), size: (usize, usize)) -> [Vec<f32>; 2] {
        let ((ox, oy), (w, h)) = (origin, size);
        let d = 1usize << samples.level;
        let per = d / d.min(MAX_STEP);
        let sw = samples.cols.len();
        let (cw, ch) = (sw / per, samples.rows.len() / per);
        let mut mean = vec![0.0f32; cw * ch];
        let mut square = vec![0.0f32; cw * ch];
        let norm = 1.0 / (per * per) as f32;
        for (k, row) in input.chunks_exact(sw).enumerate() {
            let cells = k / per * cw;
            for (cx, block) in row.chunks_exact(per).enumerate() {
                let (mut a, mut b) = (0.0f32, 0.0f32);
                for &c in block {
                    let v = rgb_norm(c, self.norm).max(MASK_FLOOR);
                    a += v;
                    b += v * v;
                }
                mean[cells + cx] += a * norm;
                square[cells + cx] += b * norm;
            }
        }
        filters::blur_plane(&mut mean, cw, ch, samples.sigma);
        filters::blur_plane(&mut square, cw, ch, samples.sigma);
        // Interpolated at each pixel's centre, bilinearly between cell centres.
        let (fx0, fy0) = samples.corner;
        let pos = |i: usize, f0: usize, o: usize, len: usize| {
            let u = (((o + i - f0) as f32 + 0.5) / d as f32 - 0.5).clamp(0.0, (len - 1) as f32);
            let i0 = u as usize;
            (i0, (i0 + 1).min(len - 1), u - i0 as f32)
        };
        let xs: Vec<_> = (0..w).map(|x| pos(x, fx0, ox, cw)).collect();
        let mut out_mean = vec![0.0f32; w * h];
        let mut out_var = vec![0.0f32; w * h];
        let (mut avg, mut sq) = (vec![0.0f32; cw], vec![0.0f32; cw]);
        for y in 0..h {
            let (j0, j1, t) = pos(y, fy0, oy, ch);
            for k in 0..cw {
                let (a, b) = (mean[j0 * cw + k], mean[j1 * cw + k]);
                avg[k] = a + (b - a) * t;
                let (a, b) = (square[j0 * cw + k], square[j1 * cw + k]);
                sq[k] = a + (b - a) * t;
            }
            let rows = out_mean[y * w..][..w].iter_mut().zip(&mut out_var[y * w..][..w]);
            for ((m, v), &(i0, i1, s)) in rows.zip(&xs) {
                *m = avg[i0] + (avg[i1] - avg[i0]) * s;
                *v = (sq[i0] + (sq[i1] - sq[i0]) * s - *m * *m).max(0.0);
            }
        }
        [out_mean, out_var]
    }

    /// The mask at a pixel whose norm is `n`, from the statistics there (Ansel's EIGF
    /// blending): `a` from the variance relative to the mean and the pixel, `b` keeps
    /// the mean. Linear, like the norm, and at least [`MASK_FLOOR`].
    #[inline(always)]
    fn blend(feathering: f32, n: f32, mean: f32, var: f32) -> f32 {
        let n = n.max(MASK_FLOOR);
        let relative = var / (mean * n).max(1e-6);
        let a = relative / (relative + feathering);
        (n * a + mean * (1.0 - a)).max(MASK_FLOOR)
    }

    /// The mask over `input` (the module's input), with its statistics there (`stats`,
    /// or `None` without smoothing).
    pub fn mask(&self, input: &[Rgb], stats: Option<[&[f32]; 2]>) -> Vec<f32> {
        match stats {
            Some([mean, var]) => input.iter().zip(mean).zip(var).map(|((&c, &m), &v)| Self::blend(self.feathering, rgb_norm(c, self.norm), m, v)).collect(),
            None => input.iter().map(|&c| rgb_norm(c, self.norm).max(MASK_FLOOR)).collect(),
        }
    }

    /// The mask over `img` (the module's input), whose top left pixel is at `origin` in
    /// a frame of `frame` pixels: the pixel's norm, smoothed by the exposure-independent
    /// guided filter (EIGF). What the developer computes in two parts ([`stats`](Self::stats)
    /// with the spatial stages, the blend in the point pass).
    pub fn plane(&self, img: &Image, origin: (usize, usize), frame: (usize, usize)) -> Vec<f32> {
        let size = (img.width, img.height);
        let Some(samples) = self.samples(origin, size, frame) else { return self.mask(&img.pixels, None) };
        let input: Vec<Rgb> = samples.rows.iter().flat_map(|&y| samples.cols.iter().map(move |&x| img.pixels[y * img.width + x])).collect();
        let [mean, var] = self.stats(&samples, &input, origin, size);
        self.mask(&img.pixels, Some([&mean, &var]))
    }
}

/// A 32-bit integer hash (Wellons' `lowbias32`).
fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^ (x >> 16)
}

/// Exposures the input histogram covers, EV relative to middle grey.
pub const HISTOGRAM_RANGE: [f32; 2] = [-16.0, 8.0];
/// Bins of the input histogram (0.1 EV each).
pub const HISTOGRAM_BINS: usize = 240;
/// Share of the values left out at each end when fitting the range.
const FIT_TAIL: f64 = 0.005;

/// What a tone curve reads on its input.
pub struct InputHistogram {
    /// One histogram per curve in use (`ToneCurve::curves`: one, or red, green and
    /// blue): the share of the values per bin over [`HISTOGRAM_RANGE`], on a common
    /// scale with the fullest bin of all at 1.
    pub bins: Vec<Vec<f32>>,
    /// The range that holds all but the darkest and brightest 0.5 % of the values
    /// (of all channels), to 0.1 EV, at least [`TONE_CURVE_MIN_RANGE`] wide.
    pub fit: [f32; 2],
}

/// The histogram bin of linear value `v` (`None` unless positive).
#[inline]
fn bin_of(v: f32) -> Option<usize> {
    let [lo, hi] = HISTOGRAM_RANGE;
    let scale = HISTOGRAM_BINS as f32 / (hi - lo);
    (v > 0.0).then(|| ((log2_fast(v) - MIDDLE_GREY.log2() - lo) * scale).clamp(0.0, (HISTOGRAM_BINS - 1) as f32) as usize)
}

/// What a curve reads, by how it reads it.
#[derive(Clone, Copy)]
enum Reads {
    /// Each channel, with its own curve.
    Channels,
    /// Each channel, with the same curve.
    Linked,
    /// The pixel's norm.
    Norm(RgbNorm),
    /// Its mask (preserving detail).
    Mask,
}

fn reads(p: &ToneCurve) -> Reads {
    match (p.preserve_detail, p.channels, p.preserve_colors) {
        (true, ..) => Reads::Mask,
        (false, CurveChannels::Independent, _) => Reads::Channels,
        (false, CurveChannels::Linked, RgbNorm::None) => Reads::Linked,
        (false, CurveChannels::Linked, norm) => Reads::Norm(norm),
    }
}

/// The histograms of what `p` reads on `pixels` (its input): the norm with linked
/// channels that preserve colours; every channel together with a linked curve per
/// channel; each channel apart with independent ones; the mask (`mask`, over the same
/// pixels, [`Local::plane`]) when it preserves detail. `None` without anything positive
/// to measure.
pub fn measure(p: &ToneCurve, pixels: &[Rgb], mask: Option<&[f32]>) -> Option<InputHistogram> {
    let reads = reads(p);
    let mut counts = match reads {
        Reads::Channels => vec![vec![0u32; HISTOGRAM_BINS]; 3],
        _ => vec![vec![0u32; HISTOGRAM_BINS]],
    };
    match reads {
        Reads::Mask => match mask {
            Some(mask) => {
                for &v in mask {
                    if let Some(b) = bin_of(v) {
                        counts[0][b] += 1;
                    }
                }
            }
            // Without its mask, what it's made from.
            None => {
                for &c in pixels {
                    if let Some(b) = bin_of(rgb_norm(c, p.local_norm())) {
                        counts[0][b] += 1;
                    }
                }
            }
        },
        Reads::Channels => {
            for c in pixels {
                for (k, &v) in c.iter().enumerate() {
                    if let Some(b) = bin_of(v) {
                        counts[k][b] += 1;
                    }
                }
            }
        }
        Reads::Linked => {
            for &v in pixels.iter().flatten() {
                if let Some(b) = bin_of(v) {
                    counts[0][b] += 1;
                }
            }
        }
        Reads::Norm(norm) => {
            for &c in pixels {
                if let Some(b) = bin_of(rgb_norm(c, norm)) {
                    counts[0][b] += 1;
                }
            }
        }
    }
    let all: Vec<u64> = (0..HISTOGRAM_BINS).map(|b| counts.iter().map(|h| u64::from(h[b])).sum()).collect();
    let total: u64 = all.iter().sum();
    if total == 0 {
        return None;
    }
    // The bins where the cumulative share passes each tail.
    let edge = |share: f64| {
        let mut seen = 0u64;
        all.iter().position(|&n| {
            seen += n;
            seen as f64 >= share * total as f64
        })
    };
    let (first, last) = (edge(FIT_TAIL)?, edge(1.0 - FIT_TAIL)?);
    let [lo, hi] = HISTOGRAM_RANGE;
    let at = |bin: usize| ((lo + bin as f32 * (hi - lo) / HISTOGRAM_BINS as f32) * 10.0).round() / 10.0;
    let (mut a, mut b) = (at(first), at(last + 1));
    if b - a < TONE_CURVE_MIN_RANGE {
        let mid = (a + b) / 2.0;
        (a, b) = (mid - TONE_CURVE_MIN_RANGE / 2.0, mid + TONE_CURVE_MIN_RANGE / 2.0);
    }
    let max = counts.iter().flatten().copied().max().unwrap_or(1).max(1) as f32;
    Some(InputHistogram { bins: counts.iter().map(|h| h.iter().map(|&n| n as f32 / max).collect()).collect(), fit: [a, b] })
}

/// What `p` reads on one pixel of its input (`input`), in EV relative to middle grey, as
/// [`measure`]'s histograms count it: the norm, the mask's value (`mask`, when it
/// preserves detail), or each channel (a curve per channel, or linked without a norm).
pub fn read_ev(p: &ToneCurve, input: Rgb, mask: Option<f32>) -> Vec<f32> {
    let ev = |v: f32| v.max(1e-12).log2() - MIDDLE_GREY.log2();
    match reads(p) {
        Reads::Mask => vec![ev(mask.unwrap_or_else(|| rgb_norm(input, p.local_norm())))],
        Reads::Channels | Reads::Linked => input.map(ev).to_vec(),
        Reads::Norm(norm) => vec![ev(rgb_norm(input, norm))],
    }
}

/// What `p` reads on `input` (its input), as the overlay paints it (8-bit sRGB): black
/// at the first node and white at the last (as a level, sRGB-encoded), the pixels near
/// `node` tinted like a mask, by how much that node moves them. A curve per channel shows
/// each channel in its own; independent curves show `channel`; a curve preserving
/// detail shows its mask (`mask`, over the same pixels).
pub fn view_colors(p: &ToneCurve, input: &[Rgb], mask: Option<&[f32]>, channel: usize, node: Option<usize>) -> Vec<[u8; 3]> {
    let [lo, hi] = p.range();
    let grey = MIDDLE_GREY.log2();
    let last = (TONE_CURVE_NODES - 1) as f32;
    // Position along the nodes, 0 … TONE_CURVE_NODES - 1.
    let position = |v: f32| ((log2_fast(v.max(1e-12)) - grey - lo) / (hi - lo) * last).clamp(0.0, last);
    let level = |t: f32| (t / last * 255.0 + 0.5) as u8;
    // A node's weight is its Catmull-Rom basis, roughly a hat one node wide either way.
    let weight = |t: f32| node.map_or(0.0, |n| (1.0 - (t - n as f32).abs()).max(0.0));
    let (tint, opacity) = crate::ops::clipping::MASK_TINT;
    let tinted = |rgb: [u8; 3], w: f32| -> [u8; 3] {
        let a = w * opacity;
        std::array::from_fn(|k| (rgb[k] as f32 + (tint[k] - rgb[k] as f32) * a + 0.5) as u8)
    };
    let grey = |v: f32| {
        let t = position(v);
        tinted([level(t); 3], weight(t))
    };
    match (reads(p), mask) {
        (Reads::Mask, Some(mask)) => mask.iter().map(|&v| grey(v)).collect(),
        (Reads::Mask, None) => input.iter().map(|&c| grey(rgb_norm(c, p.local_norm()))).collect(),
        (Reads::Channels, _) => input.iter().map(|&c| grey(c[channel.min(2)])).collect(),
        (Reads::Linked, _) => input
            .iter()
            .map(|&c| {
                let t = c.map(position);
                tinted(t.map(level), t.map(weight).into_iter().fold(0.0, f32::max))
            })
            .collect(),
        (Reads::Norm(norm), _) => input.iter().map(|&c| grey(rgb_norm(c, norm))).collect(),
    }
}

enum Mode {
    /// The same curve on each channel.
    Linked(BitsLut<f32>),
    /// One curve per channel.
    Channels(Box<[BitsLut<f32>; 3]>),
    /// The pixel scaled by the curve's gain at its norm, or at its mask's value when it
    /// preserves detail.
    Norm(RgbNorm, BitsLut<f32>),
}

pub struct ToneCurveStage {
    mode: Mode,
    /// Preserving detail: the ids of the planes with its mask's statistics
    /// ([`plane_ids`]), and Ansel's feathering. Without them, the curve reads the
    /// pixel's norm (as without smoothing).
    pub planes: Option<[String; 2]>,
    feathering: f32,
}

impl ToneCurveStage {
    /// `None` when the curves leave the image alone. `id`: the instance's, which names
    /// its mask's plane when it preserves detail.
    pub fn new(p: &ToneCurve, id: &str) -> Option<Self> {
        if p.is_identity() {
            return None;
        }
        let (r, k) = (p.range(), p.strength());
        let mode = match reads(p) {
            Reads::Channels => Mode::Channels(Box::new([gain_table(&p.red, r, k), gain_table(&p.green, r, k), gain_table(&p.blue, r, k)])),
            Reads::Linked => Mode::Linked(gain_table(&p.rgb, r, k)),
            Reads::Norm(norm) => Mode::Norm(norm, gain_table(&p.rgb, r, k)),
            Reads::Mask => Mode::Norm(p.local_norm(), gain_table(&p.rgb, r, k)),
        };
        let feathering = Local::of(p).map_or(1.0, |l| l.feathering);
        Some(Self { mode, planes: p.preserve_detail.then(|| plane_ids(id)), feathering })
    }

    #[inline(always)]
    pub fn apply(&self, c: Rgb) -> Rgb {
        match &self.mode {
            Mode::Linked(lut) => c.map(|v| v * lut.eval(v)),
            Mode::Channels(luts) => [c[0] * luts[0].eval(c[0]), c[1] * luts[1].eval(c[1]), c[2] * luts[2].eval(c[2])],
            Mode::Norm(norm, lut) => {
                let n = rgb_norm(c, *norm);
                // Upstream leaves pixels without a positive norm alone.
                let gain = if n > 0.0 { lut.eval(n) } else { 1.0 };
                c.map(|v| v * gain)
            }
        }
    }

    /// [`apply`](Self::apply) on many pixels, matching the mode once. `stats`: its mask's
    /// statistics at those pixels ([`Local::stats`]), when it preserves detail.
    pub fn apply_all(&self, pixels: &mut [Rgb], stats: Option<[&[f32]; 2]>) {
        match &self.mode {
            Mode::Norm(norm, lut) if let Some([mean, var]) = stats => {
                let (norm, f) = (*norm, self.feathering);
                for ((c, &m), &v) in pixels.iter_mut().zip(mean).zip(var) {
                    let gain = lut.eval(Local::blend(f, rgb_norm(*c, norm), m, v));
                    *c = c.map(|v| v * gain);
                }
            }
            Mode::Norm(norm, lut) => {
                let norm = *norm;
                for c in pixels {
                    let n = rgb_norm(*c, norm);
                    let gain = if n > 0.0 { lut.eval(n) } else { 1.0 };
                    *c = c.map(|v| v * gain);
                }
            }
            _ => pixels.iter_mut().for_each(|c| *c = self.apply(*c)),
        }
    }
}

/// See [`RgbNorm`]; `None` gives the average (unused: that mode reads each channel).
#[inline(always)]
fn rgb_norm([r, g, b]: Rgb, norm: RgbNorm) -> f32 {
    match norm {
        RgbNorm::Luminance => r * LUMA_REC2020[0] + g * LUMA_REC2020[1] + b * LUMA_REC2020[2],
        RgbNorm::Max => r.max(g).max(b),
        RgbNorm::Norm => (r * r + g * g + b * b).sqrt() * 0.577_350_27,
        RgbNorm::Power => {
            let sq = r * r + g * g + b * b;
            if sq > 0.0 { (r * r * r + g * g * g + b * b * b) / sq } else { 0.0 }
        }
        RgbNorm::Average | RgbNorm::None => (r + g + b) * (1.0 / 3.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::image::Region;
    use crate::params::TONE_CURVE_RANGE;

    const NODE_EV: [f32; TONE_CURVE_NODES] = [-9.0, -7.5, -6.0, -4.5, -3.0, -1.5, 0.0, 1.5, 3.0];
    const R: [f32; 2] = TONE_CURVE_RANGE;

    #[test]
    fn passes_through_nodes_and_keeps_end_offsets() {
        let nodes = [0.3, 0.0, -0.5, 0.0, 1.0, 0.0, 0.25, 0.0, -0.75];
        for (ev, want) in NODE_EV.iter().zip(nodes) {
            assert!((offset(&nodes, R, *ev) - want).abs() < 1e-5, "{ev}");
        }
        assert!((offset(&nodes, R, -14.0) - 0.3).abs() < 1e-5);
        assert!((offset(&nodes, R, 8.0) + 0.75).abs() < 1e-5);
        assert_eq!(offset(&[0.0; TONE_CURVE_NODES], R, 1.3), 0.0);
        // Clamped to the editor's range.
        assert!((offset(&[5.0; TONE_CURVE_NODES], R, 0.0) - TONE_CURVE_MAX_OFFSET).abs() < 1e-6);
    }

    #[test]
    fn strength_scales_the_offsets() {
        let mut p = ToneCurve::default();
        p.rgb[6] = 1.0; // +1 EV at middle grey
        let grey = |p: &ToneCurve| ToneCurveStage::new(p, "t").map_or(MIDDLE_GREY, |s| s.apply([MIDDLE_GREY; 3])[1]);
        let ev = |p: &ToneCurve| (grey(p) / MIDDLE_GREY).log2();
        assert!((ev(&p) - 1.0).abs() < 1e-3);
        assert!((ev(&ToneCurve { strength: 0.5, ..p.clone() }) - 0.5).abs() < 1e-3);
        assert!((ev(&ToneCurve { strength: 2.0, ..p.clone() }) - 2.0).abs() < 1e-3);
        assert!(ToneCurveStage::new(&ToneCurve { strength: 0.0, ..p }, "t").is_none());
    }

    #[test]
    fn nodes_follow_the_range() {
        let mut nodes = [0.0; TONE_CURVE_NODES];
        nodes[8] = 1.0;
        assert!((offset(&nodes, [-4.0, 4.0], 4.0) - 1.0).abs() < 1e-5);
        assert!(offset(&nodes, [-4.0, 4.0], 2.0).abs() < 0.2);
        // Too narrow ranges are widened.
        let p = ToneCurve { range: [1.0, 0.5], ..Default::default() };
        assert_eq!(p.range(), [1.0, 1.0 + TONE_CURVE_MIN_RANGE]);
    }

    #[test]
    fn fits_the_range_to_the_input() {
        // Greys from -5 to +2 EV around middle grey, evenly.
        let pixels: Vec<Rgb> = (0..=700).map(|i| [MIDDLE_GREY * (-5.0 + i as f32 / 100.0).exp2(); 3]).collect();
        let h = measure(&ToneCurve::default(), &pixels, None).unwrap();
        assert_eq!((h.bins.len(), h.bins[0].len()), (1, HISTOGRAM_BINS));
        assert!((h.fit[0] - -5.0).abs() <= 0.11 && (h.fit[1] - 2.0).abs() <= 0.11, "{:?}", h.fit);
        assert_eq!(h.bins[0].iter().cloned().fold(0.0, f32::max), 1.0);
        // Independent channels: one histogram each, on a common scale.
        let reds: Vec<Rgb> = pixels.iter().map(|c| [c[0] * 4.0, c[1], c[2] * 0.25]).collect();
        let p = ToneCurve { channels: CurveChannels::Independent, ..Default::default() };
        let h = measure(&p, &reds, None).unwrap();
        assert_eq!(h.bins.len(), 3);
        let mean = |b: &Vec<f32>| b.iter().enumerate().map(|(i, &v)| i as f32 * v).sum::<f32>() / b.iter().sum::<f32>();
        let (r, g, b) = (mean(&h.bins[0]), mean(&h.bins[1]), mean(&h.bins[2]));
        assert!((r - g - 20.0).abs() < 1.0 && (g - b - 20.0).abs() < 1.0, "{r} {g} {b}");
        assert!((h.fit[0] - -7.0).abs() <= 0.11 && (h.fit[1] - 4.0).abs() <= 0.11, "{:?}", h.fit);
        // A flat image still gets a usable range.
        let h = measure(&ToneCurve::default(), &[[MIDDLE_GREY; 3]; 10], None).unwrap();
        assert!((h.fit[1] - h.fit[0] - TONE_CURVE_MIN_RANGE).abs() < 1e-5 && h.fit[0] < 0.0 && h.fit[1] > 0.0, "{:?}", h.fit);
        assert!(measure(&ToneCurve::default(), &[[0.0; 3]; 4], None).is_none());
    }

    #[test]
    fn view_spans_the_range_and_tints_a_node() {
        let p = ToneCurve { range: [-4.0, 4.0], ..Default::default() };
        let px = |ev: f32| [MIDDLE_GREY * ev.exp2(); 3];
        let out = view_colors(&p, &[px(-6.0), px(-4.0), px(0.0), px(4.0), px(9.0)], None, 0, None);
        let levels: Vec<i32> = out.iter().map(|c| c[0] as i32).collect();
        assert!(levels.iter().zip([0, 0, 128, 255, 255]).all(|(a, b)| (a - b).abs() <= 1), "{levels:?}");
        assert!(out.iter().all(|c| c[0] == c[1] && c[1] == c[2]));
        // Node 4 is at 0 EV: grey there turns yellowish, 2 EV away (two nodes) it doesn't.
        let out = view_colors(&p, &[px(0.0), px(2.0)], None, 0, Some(4));
        assert!(out[0][2] < out[0][0], "{:?}", out[0]);
        assert_eq!(out[1], view_colors(&p, &[px(2.0)], None, 0, None)[0]);
    }

    #[test]
    fn flat_curves_do_nothing() {
        assert!(ToneCurveStage::new(&ToneCurve::default(), "t").is_none());
        let p = ToneCurve { channels: CurveChannels::Independent, rgb: [1.0; TONE_CURVE_NODES], ..Default::default() };
        assert!(ToneCurveStage::new(&p, "t").is_none(), "rgb is unused with independent channels");
    }

    #[test]
    fn luminance_mode_keeps_ratios() {
        // +1 EV everywhere.
        let p = ToneCurve { rgb: [1.0; TONE_CURVE_NODES], ..Default::default() };
        let s = ToneCurveStage::new(&p, "t").unwrap();
        let out = s.apply([0.4, 0.2, 0.1]);
        for (o, i) in out.iter().zip([0.4f32, 0.2, 0.1]) {
            assert!((o / i - 2.0).abs() < 1e-3, "{out:?}");
        }
    }

    #[test]
    fn per_channel_mode_moves_each_channel() {
        // Brightens around grey only: channels 3 EV above it don't move.
        let mut rgb = [0.0; TONE_CURVE_NODES];
        rgb[6] = 1.0;
        let p = ToneCurve { rgb, preserve_colors: RgbNorm::None, ..Default::default() };
        let s = ToneCurveStage::new(&p, "t").unwrap();
        let [r, g, _] = s.apply([MIDDLE_GREY, MIDDLE_GREY * 8.0, 0.0]);
        assert!((r / MIDDLE_GREY - 2.0).abs() < 1e-2, "{r}");
        assert!((g / (MIDDLE_GREY * 8.0) - 1.0).abs() < 1e-2, "{g}");
    }

    /// A `w × h` image: dark left, bright right, both with a fine checker texture.
    fn halves(w: usize, h: usize) -> Image {
        let mut img = Image::new(w, h);
        for (k, px) in img.pixels.iter_mut().enumerate() {
            let (x, y) = (k % w, k / w);
            let base = if x < w / 2 { MIDDLE_GREY / 16.0 } else { MIDDLE_GREY * 2.0 };
            let texture = if (x + y) % 2 == 0 { 1.25 } else { 0.8 };
            *px = [base * texture; 3];
        }
        img
    }

    fn local(smoothing: f32, edge_refinement: f32) -> Local {
        Local::of(&ToneCurve { preserve_detail: true, smoothing, edge_refinement, ..Default::default() }).unwrap()
    }

    #[test]
    fn the_mask_smooths_texture_and_keeps_edges() {
        let (w, h) = (256, 64);
        let img = halves(w, h);
        let mask = local(0.1, 1.0).plane(&img, (0, 0), (w, h));
        let ev = |v: f32| (v / MIDDLE_GREY).log2();
        let row = 32 * w;
        // Inside each half, the checker is gone (it's ±0.32 EV in the image)…
        for x in [40, 41, 200, 201] {
            let want = if x < w / 2 { -4.0 } else { 1.0 };
            assert!((ev(mask[row + x]) - want).abs() < 0.08, "{x}: {} EV", ev(mask[row + x]));
        }
        // …and the 5 EV edge stays sharp (next to it, the mask is the pixel, texture and all).
        assert!(ev(mask[row + w / 2 - 4]) < -2.5 && ev(mask[row + w / 2 + 3]) > 0.3, "{:?}", mask[row + w / 2 - 6..row + w / 2 + 6].iter().map(|&v| ev(v)).collect::<Vec<_>>());
        // Without edge refinement it's a blur: the edge spreads.
        let blurred = local(0.1, 0.01).plane(&img, (0, 0), (w, h));
        assert!(ev(blurred[row + w / 2 - 4]) > -1.0, "{}", ev(blurred[row + w / 2 - 4]));
    }

    #[test]
    fn the_mask_is_exposure_independent() {
        let (w, h) = (128, 48);
        let img = halves(w, h);
        let brighter = Image { pixels: img.pixels.iter().map(|c| c.map(|v| v * 8.0)).collect(), ..img.clone() };
        let l = local(0.08, 1.0);
        let (a, b) = (l.plane(&img, (0, 0), (w, h)), l.plane(&brighter, (0, 0), (w, h)));
        for (x, y) in a.iter().zip(&b) {
            assert!((y / x / 8.0 - 1.0).abs() < 1e-3, "{x} {y}");
        }
    }

    #[test]
    fn a_region_gets_the_same_mask() {
        let (w, h) = (300, 200);
        let mut img = halves(w, h);
        // Something that varies everywhere, so misaligned cells would show.
        for (k, px) in img.pixels.iter_mut().enumerate() {
            let (x, y) = ((k % w) as f32, (k / w) as f32);
            *px = px.map(|v| v * (1.0 + 0.5 * (x * 0.07).sin() * (y * 0.05).cos()));
        }
        let l = local(0.05, 1.0);
        let whole = l.plane(&img, (0, 0), (w, h));
        let reach = l.reach((w, h));
        assert!(reach > 0 && reach < 100, "{reach}");
        // A region with the reach around it, not on a cell boundary.
        let region = Region { x: 101, y: 53, width: 40, height: 30 }.padded(reach, w, h);
        let part = Image { width: region.width, height: region.height, pixels: (region.y..region.bottom()).flat_map(|y| img.pixels[y * w + region.x..y * w + region.right()].to_vec()).collect() };
        let mask = l.plane(&part, (region.x, region.y), (w, h));
        for y in 53..83 {
            for x in 101..141 {
                let (a, b) = (whole[y * w + x], mask[(y - region.y) * region.width + x - region.x]);
                assert!((a - b).abs() <= a * 1e-4, "({x}, {y}): {a} vs {b}");
            }
        }
    }

    #[test]
    fn the_stage_blends_the_statistics_like_the_mask() {
        let (w, h) = (96, 40);
        let img = halves(w, h);
        let p = ToneCurve { preserve_detail: true, rgb: [0.5, 0.4, 0.3, 0.2, 0.0, -0.2, -0.4, -0.5, -0.6], ..Default::default() };
        let l = Local::of(&p).unwrap();
        let samples = l.samples((0, 0), (w, h), (w, h)).unwrap();
        let px = &img.pixels;
        let input: Vec<Rgb> = samples.rows.iter().flat_map(|&y| samples.cols.iter().map(move |&x| px[y * w + x])).collect();
        let [mean, var] = l.stats(&samples, &input, (0, 0), (w, h));
        let mask = l.plane(&img, (0, 0), (w, h));
        let s = ToneCurveStage::new(&p, "t").unwrap();
        let mut got = img.pixels.clone();
        s.apply_all(&mut got, Some([&mean, &var]));
        let lut = gain_table(&p.rgb, p.range(), p.strength());
        for ((g, c), m) in got.iter().zip(&img.pixels).zip(&mask) {
            assert!((g[0] - c[0] * lut.eval(*m)).abs() <= g[0] * 1e-6, "{g:?} {c:?} {m}");
        }
    }

    #[test]
    fn preserving_detail_reads_the_mask() {
        let mut rgb = [0.0; TONE_CURVE_NODES];
        rgb[6] = 1.0;
        let p = ToneCurve { rgb, preserve_detail: true, channels: CurveChannels::Independent, preserve_colors: RgbNorm::None, ..Default::default() };
        let s = ToneCurveStage::new(&p, "t").unwrap();
        assert_eq!(s.planes, Some(["t#tones-mean".into(), "t#tones-var".into()]));
        // A dark pixel in a flat grey area gets the grey's gain (+1 EV), all channels alike.
        let mut px = [[0.02, 0.01, 0.005]];
        s.apply_all(&mut px, Some([&[MIDDLE_GREY], &[0.0]]));
        assert!(px[0].iter().zip([0.02, 0.01, 0.005]).all(|(o, i)| (o / i - 2.0).abs() < 1e-2), "{px:?}");
        // Its histogram is the mask's.
        let h = measure(&p, &[[1.0; 3]; 3], Some(&[MIDDLE_GREY; 3])).unwrap();
        assert_eq!(h.bins.len(), 1);
        assert!(h.fit[0] < 0.0 && h.fit[1] > 0.0, "{:?}", h.fit);
    }

    #[test]
    fn norms_of_grey_are_its_value() {
        for norm in [RgbNorm::Luminance, RgbNorm::Max, RgbNorm::Average, RgbNorm::Norm, RgbNorm::Power] {
            assert!((rgb_norm([0.3; 3], norm) - 0.3).abs() < 1e-6, "{norm:?}");
        }
    }
}
