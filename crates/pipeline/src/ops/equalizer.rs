//! Contrast equalizer, after Ansel's `atrous.c` and `pixel/eaw.c` (GPL-3.0-or-later):
//! an edge-aware à-trous wavelet decomposition (B-spline kernel, one band per
//! octave), where each band's detail is boosted and soft-thresholded according to
//! curves over detail size, then summed back.
//!
//! Two deviations, both for speed:
//!
//! * The bands are taken of **log₂ luminance** and of colour relative to luminance,
//!   instead of Lab. Exposure is then an additive constant that only lives in the
//!   residual, so the module (nearly) commutes with exposure and can run in the
//!   cached spatial stage, before the point operations.
//! * Each 5×5 edge-aware filter is applied as a row pass then a column pass (10 taps
//!   instead of 25). The weights are computed on the image being filtered, as in
//!   Ansel, so edges are still kept out of the coarse bands.
//!
//! The band sizes follow Ansel: from 5×5 full-resolution pixels (curve position 1,
//! "fine") to about a fifth of the image (0, "coarse"). Smaller renders skip the
//! bands finer than their pixels, so a preview looks like the full-size render.

use crate::color::LUMA_REC2020;
use crate::image::{Image, Rgb};
use crate::params::{ContrastEqualizer, EQUALIZER_NODES};

const MAX_SCALES: usize = 8;
/// Below this luminance, colour detail fades (deep shadows are mostly noise) and the
/// logarithm stops diving: about 9.5 EV under middle grey.
const NOISE_FLOOR: f32 = 1.0 / 4096.0;
/// Ansel's thresholds and edge weights are in Lab units. Around middle grey one EV
/// is about 12 L*, and our colour unit (relative to luminance) about 50 a*b*.
const L_PER_EV: f32 = 12.0;
const AB_PER_CHROMA: f32 = 50.0;
const FILTER: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

/// What happens to one band, for luminance or for colour.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Band {
    /// Detail gain.
    boost: f32,
    /// Detail below this is removed (soft threshold).
    threshold: f32,
    /// Edge-stopping strength, per squared unit of difference.
    sharpen: f32,
}

impl Band {
    fn is_identity(&self) -> bool {
        self.boost == 1.0 && self.threshold == 0.0
    }
}

/// A Catmull-Rom curve through evenly spaced nodes, clamped to [0, 1], like Ansel's
/// `dt_draw_curve` (one-sided tangents at the ends).
pub fn curve(nodes: &[f32; EQUALIZER_NODES], x: f32) -> f32 {
    let n = EQUALIZER_NODES;
    let h = 1.0 / (n - 1) as f32;
    let x = x.clamp(0.0, 1.0);
    let i = ((x / h) as usize).min(n - 2);
    let tangent = |k: usize| {
        let (a, b) = (k.saturating_sub(1), (k + 1).min(n - 1));
        (nodes[b] - nodes[a]) / ((b - a) as f32 * h)
    };
    let t = (x - i as f32 * h) / h;
    let (t2, t3) = (t * t, t * t * t);
    let y = (2.0 * t3 - 3.0 * t2 + 1.0) * nodes[i]
        + (t3 - 2.0 * t2 + t) * h * tangent(i)
        + (-2.0 * t3 + 3.0 * t2) * nodes[i + 1]
        + (t3 - t2) * h * tangent(i + 1);
    y.clamp(0.0, 1.0)
}

/// The curves with `mix` applied: each node moved away from (or toward) its default.
fn mixed(nodes: &[f32; EQUALIZER_NODES], defaults: &[f32; EQUALIZER_NODES], mix: f32) -> [f32; EQUALIZER_NODES] {
    std::array::from_fn(|k| (nodes[k] + (mix - 1.0) * (nodes[k] - defaults[k])).clamp(0.0, 1.0))
}

/// The bands to process for an image of `width × height` output pixels at `scale`
/// output pixels per full-resolution pixel (Ansel's `get_scales`), from fine to
/// coarse: for luminance, and for colour.
fn bands(p: &ContrastEqualizer, width: usize, height: usize, scale: f32) -> (Vec<Band>, Vec<Band>) {
    let d = ContrastEqualizer::default();
    let luma = mixed(&p.luma, &d.luma, p.mix);
    let chroma = mixed(&p.chroma, &d.chroma, p.mix);
    let edges = mixed(&p.edges, &d.edges, p.mix);
    let luma_denoise = mixed(&p.luma_denoise, &d.luma_denoise, p.mix);
    let chroma_denoise = mixed(&p.chroma_denoise, &d.chroma_denoise, p.mix);

    // The largest filter spans a fifth of the full-resolution image.
    let full = width.max(height) as f32 / scale;
    let largest = ((2 * (2 << (MAX_SCALES - 1)) + 1) as f32).min(full * 0.2);
    let i0 = ((largest - 1.0) * 0.5).log2();
    // The coarsest filter must fit in the image.
    let fit = ((width.min(height) as f32).log2().floor() as isize - 2).max(0) as usize;
    let (mut l, mut c) = (Vec::new(), Vec::new());
    for i in 0..MAX_SCALES.min(fit) {
        let support = (2 * (2 << i) + 1) as f32 / scale;
        let t = 1.0 - (((support - 1.0) * 0.5).log2() - 1.0 + 0.5) / i0;
        if t < 0.0 {
            break;
        }
        let gain = |c: &[f32; EQUALIZER_NODES]| (2.0 * curve(c, t)).powi(2);
        let fade = (-7.0 * (1.0 - t)).exp2();
        let edge = 0.0025 * curve(&edges, t);
        l.push(Band { boost: gain(&luma), threshold: fade * 10.0 * curve(&luma_denoise, t) / L_PER_EV, sharpen: edge * L_PER_EV * L_PER_EV });
        c.push(Band {
            boost: gain(&chroma),
            threshold: fade * 20.0 * curve(&chroma_denoise, t) / AB_PER_CHROMA,
            sharpen: edge * AB_PER_CHROMA * AB_PER_CHROMA,
        });
    }
    (l, c)
}

/// Pixel → `[log₂ luminance, colour relative to luminance]`.
#[inline]
fn split(px: Rgb) -> [f32; 4] {
    let y = (px[0] * LUMA_REC2020[0] + px[1] * LUMA_REC2020[1] + px[2] * LUMA_REC2020[2]).max(0.0);
    let k = 1.0 / (y + NOISE_FLOOR);
    [(y + NOISE_FLOOR).log2(), (px[0] - y) * k, (px[1] - y) * k, (px[2] - y) * k]
}

/// The inverse of [`split`].
#[inline]
fn join(v: [f32; 4]) -> Rgb {
    let y = (v[0].exp2() - NOISE_FLOOR).max(0.0);
    let k = y + NOISE_FLOOR;
    [y + v[1] * k, y + v[2] * k, y + v[3] * k]
}

/// `e^-x` for `x ≥ 0`, roughly (within 0.06): Ansel's `dt_fast_expf`, which shapes its
/// edge weights.
#[inline(always)]
fn fast_exp_neg(x: f32) -> f32 {
    const ONE: f32 = 0x3f80_0000 as f32;
    const E: f32 = 0x402d_f854 as f32;
    f32::from_bits((ONE - x * (E - ONE)).max(0.0) as u32)
}

/// The edge-aware weighted average of five taps around `centre`.
#[inline(always)]
fn tap5<const N: usize>(centre: [f32; N], taps: [[f32; N]; 5], sharpen: f32) -> [f32; N] {
    let (mut sum, mut weight) = ([0.0f32; N], 0.0f32);
    for (k, v) in taps.iter().enumerate() {
        let mut d2 = 0.0;
        for c in 0..N {
            d2 += (v[c] - centre[c]) * (v[c] - centre[c]);
        }
        let w = FILTER[k] * fast_exp_neg(sharpen * d2);
        for c in 0..N {
            sum[c] += w * v[c];
        }
        weight += w;
    }
    let inv = 1.0 / weight;
    sum.map(|v| v * inv)
}

/// The five taps `mult` apart around `i` in `0..len`, clamped to the edges.
#[inline]
fn clamped_taps(i: usize, len: usize, mult: usize) -> [usize; 5] {
    std::array::from_fn(|k| (i as isize + (k as isize - 2) * mult as isize).clamp(0, len as isize - 1) as usize)
}

/// One edge-aware 5-tap pass along the rows, taps `mult` pixels apart.
fn filter_rows<const N: usize>(src: &[[f32; N]], dst: &mut [[f32; N]], width: usize, mult: usize, sharpen: f32) {
    let reach = 2 * mult;
    for (row, out) in src.chunks_exact(width).zip(dst.chunks_exact_mut(width)) {
        if width <= 2 * reach {
            for (x, o) in out.iter_mut().enumerate() {
                *o = tap5(row[x], clamped_taps(x, width, mult).map(|j| row[j]), sharpen);
            }
            continue;
        }
        // Away from the borders, the taps are plain offsets.
        let inner = width - 2 * reach;
        let [a, b, c, d, e] = [0, 1, 2, 3, 4].map(|k| &row[k * mult..k * mult + inner]);
        let pixels = a.iter().zip(b).zip(c).zip(d).zip(e);
        for (o, ((((a, b), c), d), e)) in out[reach..width - reach].iter_mut().zip(pixels) {
            *o = tap5(*c, [*a, *b, *c, *d, *e], sharpen);
        }
        for x in (0..reach).chain(width - reach..width) {
            out[x] = tap5(row[x], clamped_taps(x, width, mult).map(|j| row[j]), sharpen);
        }
    }
}

/// One edge-aware 5-tap pass along the columns, taps `mult` rows apart, a row at a
/// time. `emit` receives each row's index and filtered values.
fn filter_columns<const N: usize>(src: &[[f32; N]], width: usize, height: usize, mult: usize, sharpen: f32, mut emit: impl FnMut(usize, &[[f32; N]])) {
    let mut out = vec![[0.0; N]; width];
    for y in 0..height {
        let [a, b, c, d, e] = clamped_taps(y, height, mult).map(|j| &src[j * width..(j + 1) * width]);
        let pixels = a.iter().zip(b).zip(c).zip(d).zip(e);
        for (o, ((((a, b), c), d), e)) in out.iter_mut().zip(pixels) {
            *o = tap5(*c, [*a, *b, *c, *d, *e], sharpen);
        }
        emit(y, &out);
    }
}

/// Shrink `x` toward 0 by `t`.
#[inline]
fn soft_threshold(x: f32, t: f32) -> f32 {
    (x - t).max(0.0) + (x + t).min(0.0)
}

/// Decompose `data` into `bands` (fine to coarse), process them and sum them back, in place.
fn equalize<const N: usize>(data: &mut [[f32; N]], width: usize, height: usize, bands: &[Band]) {
    // Bands past the last one that changes anything need no decomposition.
    let Some(last) = bands.iter().rposition(|b| !b.is_identity()) else { return };
    let mut cur = data.to_vec();
    let mut tmp = vec![[0.0f32; N]; data.len()];
    // `data` becomes the input plus, for each band, the processed detail minus the
    // original detail.
    for (i, band) in bands[..=last].iter().enumerate() {
        filter_rows(&cur, &mut tmp, width, 1 << i, band.sharpen);
        // The column pass writes the next (coarser) level over `cur`, a row at a time,
        // once that row's detail is accounted for.
        let identity = band.is_identity();
        filter_columns(&tmp, width, height, 1 << i, band.sharpen, |y, coarse| {
            let rows = y * width..(y + 1) * width;
            let (fine, out) = (&mut cur[rows.clone()], &mut data[rows]);
            if !identity {
                for ((o, f), c) in out.iter_mut().zip(fine.iter()).zip(coarse) {
                    for ch in 0..N {
                        let detail = f[ch] - c[ch];
                        o[ch] += band.boost * soft_threshold(detail, band.threshold) - detail;
                    }
                }
            }
            fine.copy_from_slice(coarse);
        });
    }
}

/// Apply the module to `img`, rendered at `scale` output pixels per full-resolution pixel.
pub fn apply(img: &mut Image, p: &ContrastEqualizer, scale: f32) {
    if p.is_identity() {
        return;
    }
    let (width, height) = (img.width, img.height);
    let (luma_bands, chroma_bands) = bands(p, width, height, scale);
    // Luminance and colour are decomposed separately (their edge weights only look at
    // themselves), so an untouched one costs nothing.
    let (mut luma, mut chroma): (Vec<[f32; 1]>, Vec<[f32; 3]>) = img
        .pixels
        .iter()
        .map(|&px| {
            let [l, r, g, b] = split(px);
            ([l], [r, g, b])
        })
        .unzip();
    equalize(&mut luma, width, height, &luma_bands);
    equalize(&mut chroma, width, height, &chroma_bands);
    for ((px, [l]), [r, g, b]) in img.pixels.iter_mut().zip(luma).zip(chroma) {
        *px = join([l, r, g, b]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: usize, height: usize, f: impl Fn(usize, usize) -> Rgb) -> Image {
        let mut img = Image::new(width, height);
        for y in 0..height {
            for x in 0..width {
                img.pixels[y * width + x] = f(x, y);
            }
        }
        img
    }

    #[test]
    fn curve_passes_through_nodes() {
        let nodes = [0.1, 0.5, 0.9, 0.3, 0.5, 0.7];
        for (k, &y) in nodes.iter().enumerate() {
            assert!((curve(&nodes, k as f32 / 5.0) - y).abs() < 1e-6);
        }
        assert_eq!(curve(&[0.5; 6], 0.37), 0.5);
    }

    #[test]
    fn split_join_round_trips() {
        for px in [[0.18f32, 0.18, 0.18], [0.5, 0.1, 0.02], [0.0, 0.0, 0.0], [1e-5, 2e-5, 0.0], [-0.001, 0.002, 0.001], [20.0, 3.0, 1.0]] {
            let back = join(split(px));
            assert!(back.iter().zip(px).all(|(a, b)| (a - b).abs() < 1e-5 * b.abs().max(1.0)), "{px:?} → {back:?}");
        }
    }

    #[test]
    fn band_sizes_follow_the_render_scale() {
        let p = ContrastEqualizer::default();
        // Full size: the finest band is 5×5 pixels.
        assert_eq!(bands(&p, 6000, 4000, 1.0).0.len(), MAX_SCALES);
        // A fifth of the size drops the bands finer than a pixel.
        assert!(bands(&p, 1200, 800, 0.2).0.len() < MAX_SCALES);
    }

    #[test]
    fn neutral_curves_change_nothing() {
        let img = image(64, 48, |x, y| [0.01 + (x * y) as f32 * 1e-3, 0.2, 0.05 * (x % 3) as f32]);
        let mut out = img.clone();
        apply(&mut out, &ContrastEqualizer { edges: [1.0; 6], ..Default::default() }, 1.0);
        assert_eq!(out.pixels, img.pixels);
    }

    #[test]
    fn boosting_increases_local_contrast_and_keeps_the_mean() {
        // Fine stripes on a grey background.
        let img = image(128, 96, |x, _| [if x % 4 < 2 { 0.12 } else { 0.24 }; 3]);
        let mut out = img.clone();
        let p = ContrastEqualizer { luma: [0.5, 0.5, 0.5, 0.5, 0.7, 0.7], ..Default::default() };
        apply(&mut out, &p, 1.0);
        let row = |img: &Image, x: usize| img.pixels[48 * img.width + x][0];
        let (dark, light) = (row(&out, 64), row(&out, 66));
        assert!(light / dark > 0.24 / 0.12 * 1.2, "{dark} {light}");
        // Neutral stays neutral.
        let px = out.pixels[48 * 128 + 64];
        assert!((px[0] - px[1]).abs() < 1e-5 && (px[1] - px[2]).abs() < 1e-5);
        // Log-domain detail: the geometric mean is kept.
        assert!(((dark * light).sqrt() / (0.12f32 * 0.24).sqrt() - 1.0).abs() < 0.05);
    }

    #[test]
    fn denoise_flattens_weak_detail() {
        let img = image(64, 64, |x, y| [0.18 * (1.0 + 0.02 * (((x * 7 + y * 13) % 5) as f32 - 2.0)); 3]);
        let mut out = img.clone();
        let p = ContrastEqualizer { luma_denoise: [1.0; 6], ..Default::default() };
        apply(&mut out, &p, 1.0);
        let spread = |img: &Image| {
            let (lo, hi) = img.pixels.iter().fold((f32::MAX, f32::MIN), |(lo, hi), px| (lo.min(px[0]), hi.max(px[0])));
            hi - lo
        };
        assert!(spread(&out) < spread(&img) * 0.5, "{} vs {}", spread(&out), spread(&img));
    }
}
