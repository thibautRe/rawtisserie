//! Sharpness at edges (roadmap 8.9, prototype): how wide each edge of the photo is
//! blurred, in pixels, rather than how much fine detail an area has.
//!
//! An edge blurred by a Gaussian of width σ, seen through a Gaussian derivative of
//! width s, has a gradient proportional to its contrast / √(σ² + s²). The ratio of two
//! such gradients, at s₁ and s₂, doesn't depend on the contrast and falls as σ grows:
//! it tells σ (Zhuo & Sim, "Defocus map estimation from a single image", 2011). Edges
//! are where the coarser gradient is a local maximum along its direction and well
//! above the noise; elsewhere there's nothing to tell. The expected noise energy is
//! subtracted from both gradients first, and the ratio is turned into σ by a table of
//! synthetic edges through the same discrete kernels, so σ is absolute: in sensor
//! pixels, comparable from one photo to the next.

use super::{BINS, Luma, bin, percentile};
use crate::decode::RawPhoto;

/// The two gradient scales, in the measure's pixels (binned 2 × 2 for a mosaic).
const S1: f32 = 0.75;
const S2: f32 = 1.5;
/// How far above the noise an edge is: its coarser gradient, in RMS of the noise's.
const SNR: f32 = 3.5;
/// Blur widths the table covers, in the measure's pixels; wider ones read as this.
const MAX_BLUR: f32 = 6.0;
const TABLE_STEP: f32 = 0.025;

/// Each pixel's edge blur, in the measure's pixels (`factor` sensor pixels each).
pub struct EdgeBlur {
    pub width: usize,
    pub height: usize,
    pub factor: usize,
    /// The blur's σ in sensor pixels, NaN where there's no edge.
    pub blur: Vec<f32>,
}

pub fn measure(photo: &RawPhoto) -> EdgeBlur {
    let luma = Luma::new(photo);
    let (w, h) = (luma.width, luma.height);
    let mut y = vec![0.0f32; w * h];
    for (r, row) in y.chunks_mut(w).enumerate() {
        luma.row(r, row);
    }

    let k1 = Kernels::new(S1);
    let k2 = Kernels::new(S2);
    let (gx1, gy1, _) = k1.gradients(&y, w, h);
    let (gx2, gy2, smooth) = k2.gradients(&y, w, h);
    drop(y);
    let table = table(&k1, &k2);
    let m1: Vec<f32> = gx1.iter().zip(&gy1).map(|(x, y)| x * x + y * y).collect();
    let m2: Vec<f32> = gx2.iter().zip(&gy2).map(|(x, y)| x * x + y * y).collect();
    drop((gx1, gy1));
    let (floor1, floor2) = (noise_floor(&m1, &smooth), noise_floor(&m2, &smooth));

    let mut raw = vec![f32::NAN; w * h];
    for yy in 1..h.saturating_sub(1) {
        for xx in 1..w - 1 {
            let i = yy * w + xx;
            if smooth[i] > CLIPPED {
                continue;
            }
            let b = bin(smooth[i]);
            let n2 = floor2[b];
            if m2[i] < SNR * SNR * n2 || m2[i] <= 0.0 {
                continue;
            }
            // Non-maximum suppression along the gradient, quantised to 45°.
            let (ax, ay) = (gx2[i].abs(), gy2[i].abs());
            let d: isize = if ax > 2.414 * ay {
                1
            } else if ay > 2.414 * ax {
                w as isize
            } else if (gx2[i] > 0.0) == (gy2[i] > 0.0) {
                w as isize + 1
            } else {
                w as isize - 1
            };
            let (a, c) = (m2[(i as isize + d) as usize], m2[(i as isize - d) as usize]);
            if m2[i] < a || m2[i] <= c {
                continue;
            }
            let ratio = ((m1[i] - floor1[b]).max(0.0) / (m2[i] - n2)).sqrt();
            raw[i] = invert(&table, ratio) * luma.factor as f32;
        }
    }
    // Each edge pixel's estimate is noisy: the median of the edge pixels around it.
    let mut blur = vec![f32::NAN; w * h];
    let mut near = Vec::with_capacity(25);
    for yy in 0..h {
        for xx in 0..w {
            if raw[yy * w + xx].is_nan() {
                continue;
            }
            near.clear();
            for y2 in yy.saturating_sub(ALONG)..(yy + ALONG + 1).min(h) {
                for x2 in xx.saturating_sub(ALONG)..(xx + ALONG + 1).min(w) {
                    let v = raw[y2 * w + x2];
                    if !v.is_nan() {
                        near.push(v);
                    }
                }
            }
            // A lone edge pixel is noise more often than not.
            if near.len() < MIN_ALONG {
                continue;
            }
            let k = near.len() / 2;
            blur[yy * w + xx] = *near.select_nth_unstable_by(k, |a, b| a.total_cmp(b)).1;
        }
    }
    EdgeBlur { width: w, height: h, factor: luma.factor, blur }
}

/// Above this (square-rooted) luminance, a pixel may be clipped: no noise, no edges.
const CLIPPED: f32 = 0.97;
/// Edge pixels around one (a square of `2 ALONG + 1`) whose estimates are pooled…
const ALONG: usize = 2;
/// …and how many there must be.
const MIN_ALONG: usize = 4;

/// A gradient's expected squared magnitude from noise alone, by brightness bin: measured
/// on the photo (raw files' noise isn't white, and differs by camera and ISO), as a low
/// percentile of the squared magnitudes (most pixels of a bin are flat; edges and
/// texture lift the higher ones). For noise only, |g|² is exponential: its first
/// quartile is ln(4/3) times its mean.
fn noise_floor(m: &[f32], smooth: &[f32]) -> [f32; BINS] {
    let mut by_bin: Vec<Vec<f32>> = vec![Vec::new(); BINS];
    for i in (0..m.len()).step_by(7) {
        by_bin[bin(smooth[i])].push(m[i]);
    }
    let measured: Vec<Option<f32>> =
        by_bin.iter().map(|v| (v.len() >= 500).then(|| percentile(v, 0.25) / (4.0f32 / 3.0).ln())).collect();
    std::array::from_fn(|i| {
        (0..BINS)
            .flat_map(|d| [i.checked_sub(d), Some(i + d)])
            .flatten()
            .find_map(|j| measured.get(j).copied().flatten())
            .unwrap_or(0.0)
    })
}

/// A Gaussian of width `s` and its derivative, sampled, with the derivative's noise gain.
struct Kernels {
    radius: usize,
    g: Vec<f32>,
    d: Vec<f32>,
}

impl Kernels {
    fn new(s: f32) -> Self {
        let radius = (3.0 * s).ceil() as usize + 1;
        let ks = || (-(radius as isize)..=radius as isize).map(|k| k as f32);
        let g: Vec<f32> = ks().map(|k| (-k * k / (2.0 * s * s)).exp()).collect();
        let gs: f32 = g.iter().sum();
        let g: Vec<f32> = g.iter().map(|v| v / gs).collect();
        // Normalised so that a ramp of slope 1 reads 1.
        let d: Vec<f32> = ks().zip(&g).map(|(k, g)| k * g).collect();
        let ds: f32 = ks().zip(&d).map(|(k, d)| k * d).sum();
        let d: Vec<f32> = d.iter().map(|v| v / ds).collect();
        Self { radius, g, d }
    }

    /// The gradient (x, y) and the smoothed image.
    fn gradients(&self, src: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let rows_g = conv_rows(src, w, h, &self.g, self.radius);
        let rows_d = conv_rows(src, w, h, &self.d, self.radius);
        let gx = conv_cols(&rows_d, w, h, &self.g, self.radius);
        let gy = conv_cols(&rows_g, w, h, &self.d, self.radius);
        let smooth = conv_cols(&rows_g, w, h, &self.g, self.radius);
        (gx, gy, smooth)
    }
}

fn conv_rows(src: &[f32], w: usize, h: usize, k: &[f32], r: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let dst = &mut out[y * w..(y + 1) * w];
        for (x, o) in dst.iter_mut().enumerate() {
            let mut s = 0.0;
            for (t, kv) in k.iter().enumerate() {
                let xx = (x as isize + t as isize - r as isize).clamp(0, w as isize - 1) as usize;
                s += kv * row[xx];
            }
            *o = s;
        }
    }
    out
}

fn conv_cols(src: &[f32], w: usize, h: usize, k: &[f32], r: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let dst = &mut out[y * w..(y + 1) * w];
        for (t, kv) in k.iter().enumerate() {
            let yy = (y as isize + t as isize - r as isize).clamp(0, h as isize - 1) as usize;
            let row = &src[yy * w..(yy + 1) * w];
            for x in 0..w {
                dst[x] += kv * row[x];
            }
        }
    }
    out
}

/// The gradients' ratio by blur σ (in the measure's pixels), for synthetic step edges
/// integrated over each pixel, averaged over where the edge falls in its pixel.
fn table(k1: &Kernels, k2: &Kernels) -> Vec<f32> {
    let n = (MAX_BLUR / TABLE_STEP) as usize + 1;
    const HALF: isize = 48;
    (0..n)
        .map(|i| {
            let sigma = i as f32 * TABLE_STEP;
            let phases = [0.0f32, 0.125, 0.25, 0.375, 0.5];
            let mut sum = 0.0;
            for p in phases {
                let profile: Vec<f32> = (-HALF..=HALF).map(|x| pixel_step(x as f32 - p, sigma)).collect();
                let at = |k: &Kernels, c: usize| -> f32 {
                    k.d.iter().enumerate().map(|(t, d)| d * profile[c + t - k.radius]).sum()
                };
                let c = (HALF - 2..=HALF + 2).map(|c| c as usize).max_by(|&a, &b| at(k2, a).total_cmp(&at(k2, b))).unwrap();
                sum += at(k1, c) / at(k2, c);
            }
            sum / phases.len() as f32
        })
        .collect()
}

/// A unit step at 0 blurred by a Gaussian of width `sigma`, averaged over the pixel
/// centred at `x`.
fn pixel_step(x: f32, sigma: f32) -> f32 {
    let (a, b) = (x - 0.5, x + 0.5);
    if sigma < 1e-3 {
        return b.max(0.0) - a.max(0.0);
    }
    // ∫Φ(u/σ) du = σ (z Φ(z) + φ(z)), z = u/σ.
    let prim = |u: f32| {
        let z = (u / sigma) as f64;
        let phi = (-z * z / 2.0).exp() / (2.0 * std::f64::consts::PI).sqrt();
        sigma as f64 * (z * normal_cdf(z) + phi)
    };
    (prim(b) - prim(a)) as f32
}

fn normal_cdf(z: f64) -> f64 {
    0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2))
}

/// Abramowitz & Stegun 7.1.26 (error below 1.5 × 10⁻⁷).
fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * x.abs());
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-x * x).exp();
    y.copysign(x)
}

/// σ for a ratio: the table falls with σ.
fn invert(table: &[f32], ratio: f32) -> f32 {
    if ratio >= table[0] {
        return 0.0;
    }
    match table.iter().position(|&r| r <= ratio) {
        None => MAX_BLUR,
        Some(i) => {
            let (r0, r1) = (table[i - 1], table[i]);
            ((i - 1) as f32 + (r0 - ratio) / (r0 - r1)) * TABLE_STEP
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ratio_falls_with_the_blur() {
        let t = table(&Kernels::new(S1), &Kernels::new(S2));
        assert!(t.windows(2).all(|p| p[1] < p[0]), "{t:?}");
        for sigma in [0.3, 1.0, 2.5] {
            let i = (sigma / TABLE_STEP) as usize;
            assert!((invert(&t, t[i]) - sigma).abs() < 1e-3);
        }
    }
}
