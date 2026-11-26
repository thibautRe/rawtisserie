//! Focus areas (roadmap 8.9): where a photo is sharp, measured once per photo on its
//! sensor data, so it's a property of the capture rather than of a recipe.
//!
//! The measure compares two detail bands of the luminance: the finest one (what a
//! defocused or moved lens loses first) against the next one down (what it keeps). In
//! focus, natural textures have about as much energy in both; out of focus, the finest
//! band drops to the noise. As a ratio it doesn't depend on the texture's contrast, so
//! a soft but sharp texture reads as sharp, and the noise expected in each band is
//! subtracted first, so that noise doesn't read as detail at high ISO. Cells with too
//! little detail to tell (a clear sky, a blown highlight) are marked as such rather than
//! as blurry.
//!
//! The luminance is the green photosites binned 2 × 2 for a mosaic (green is on every
//! Bayer block and nearly every X-Trans one), square-rooted so that photon noise is
//! about the same everywhere. It's read in strips, so a 60 MP file needs a few MB.
//!
//! Everything is in the sensor frame (the base image, before orientation), normalised
//! like shapes (`crate::shapes`): `SensorMapping` places it on a version's output.

use serde::Serialize;

use crate::decode::{Layout, RawPhoto};

pub mod edges;

/// Bumped whenever the measure changes, so stored maps are measured again.
pub const FOCUS_VERSION: u32 = 1;

/// Cells along the long side of the sensor.
const CELLS: usize = 64;
/// Rows of the luminance read at once.
const STRIP: usize = 64;
/// How far the bands read around a pixel: 2 for the first à trous level, 4 for the second.
const REACH: usize = 6;
/// The ratio of the fine band's energy to the next band's below which nothing is sharp.
const MIN_SHARP: f32 = 0.3;
/// A cell has detail when its next-to-finest band has this many times the noise's energy…
const DETAIL_SNR: f32 = 2.0;
/// …and at least this much energy (in square-rooted units): clean files at base ISO
/// otherwise count the faintest gradient.
const DETAIL_FLOOR: f32 = 2e-6;
/// Cells at least this sharp, relative to the sharpest, are part of the focus area.
const AREA_THRESHOLD: f32 = 0.75;
/// A cell value meaning "not enough detail to tell".
pub const NO_DETAIL: u8 = 255;

/// The sharpness of a photo, by cell, in the sensor frame.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusMap {
    pub version: u32,
    pub cols: usize,
    pub rows: usize,
    /// Row by row, 0 (blurred) … 254 (sharp), or [`NO_DETAIL`]: base64 in JSON.
    #[serde(serialize_with = "base64")]
    pub cells: Vec<u8>,
    /// How sharp the photo's sharpest parts are: the ratio of the bands' energies (about
    /// 0.5 to 2 in focus, by camera), for comparing photos from the same camera.
    pub sharpness: f32,
    /// The sharpest region, if any part has detail.
    pub area: Option<FocusArea>,
}

/// The sharpest region: its box and its centre (weighted by sharpness), normalised.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusArea {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub cx: f32,
    pub cy: f32,
}

/// The 5-tap B3 spline (Ansel's à trous).
const B3: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

pub fn measure(photo: &RawPhoto) -> FocusMap {
    let luma = Luma::new(photo);
    let (w, h) = (luma.width, luma.height);
    let (cols, rows) = grid(w, h);
    let cells_n = cols * rows;
    // Per cell: the fine and the next band's energy, the luminance, the noise samples
    // (see `Luma::row`) and the pixels counted.
    let (mut fine, mut mid, mut mean, mut noise) =
        (vec![0.0f64; cells_n], vec![0.0f64; cells_n], vec![0.0f64; cells_n], vec![0.0f64; cells_n]);
    let (mut count, mut noise_count) = (vec![0u32; cells_n], vec![0u32; cells_n]);
    let col_of: Vec<usize> = (0..w).map(|x| x * cols / w).collect();

    let mut y0 = 0;
    let mut noise_row = vec![0.0f32; w];
    while y0 < h {
        let y1 = (y0 + STRIP).min(h);
        let top = y0.saturating_sub(REACH);
        let bottom = (y1 + REACH).min(h);
        let n = bottom - top;
        let mut y = vec![0.0f32; n * w];
        for (i, row) in y.chunks_mut(w).enumerate() {
            luma.row(top + i, row);
        }
        let s1 = blur(&y, w, n, 1);
        let s2 = blur(&s1, w, n, 2);
        for yy in y0..y1 {
            let i = yy - top;
            let cell_row = yy * rows / h * cols;
            let has_noise = luma.noise_row(yy, &mut noise_row);
            for x in 0..w {
                let k = i * w + x;
                let f = y[k] - s1[k];
                let m = s1[k] - s2[k];
                let c = cell_row + col_of[x];
                fine[c] += (f * f) as f64;
                mid[c] += (m * m) as f64;
                mean[c] += y[k] as f64;
                count[c] += 1;
                if has_noise && !noise_row[x].is_nan() {
                    noise[c] += noise_row[x] as f64;
                    noise_count[c] += 1;
                }
            }
        }
        y0 = y1;
    }

    let per = |sums: &[f64], counts: &[u32]| -> Vec<f32> {
        sums.iter().zip(counts).map(|(&e, &n)| (e / n.max(1) as f64) as f32).collect()
    };
    let (fine, mid, mean) = (per(&fine, &count), per(&mid, &count), per(&mean, &count));
    // The luminance's noise variance, by cell: from the photo's noise profile at the
    // cell's brightness (`noise_profile`), or without one (an image, not a mosaic), what
    // the flattest cells have in the fine band.
    let noise_var: Vec<f32> = if noise_count.iter().any(|&n| n > 0) {
        let profile = noise_profile(&mean, &per(&noise, &noise_count));
        mean.iter().map(|&m| profile[bin(m)]).collect()
    } else {
        vec![percentile(&fine, 0.1) / NOISE_FINE; cells_n]
    };

    let ratios: Vec<Option<f32>> = (0..cells_n)
        .map(|i| {
            let (nf, nm) = (noise_var[i] * NOISE_FINE, noise_var[i] * NOISE_MID);
            let m = mid[i] - nm;
            if m < DETAIL_SNR * nm || mid[i] < DETAIL_FLOOR {
                return None;
            }
            Some((fine[i] - nf).max(0.0) / m)
        })
        .collect();
    if std::env::var_os("FOCUS_DEBUG").is_some() {
        let known: Vec<f32> = ratios.iter().flatten().copied().collect();
        let p = |q| percentile(&known, q);
        eprintln!("ratios p10 {:.3} p50 {:.3} p90 {:.3} p99 {:.3}", p(0.1), p(0.5), p(0.9), p(0.99));
    }
    // Relative to the photo's sharpest parts: how sharp a sensor and lens get differs
    // (an anti-aliasing filter halves the ratio), but a photo that's blurred all over
    // (`MIN_SHARP`) doesn't get sharp parts.
    let known: Vec<f32> = ratios.iter().flatten().copied().collect();
    let top = percentile(&known, 0.95);
    let scale = top.max(MIN_SHARP);
    let scores: Vec<Option<f32>> = ratios.iter().map(|r| r.map(|r| (r / scale).min(1.0))).collect();
    let cells = scores.iter().map(|s| s.map_or(NO_DETAIL, |s| (s * 254.0).round() as u8)).collect();
    FocusMap {
        version: FOCUS_VERSION,
        cols,
        rows,
        cells,
        sharpness: top,
        area: area(&scores, cols, rows),
    }
}

/// White noise's energy in the first and second bands, per unit of variance: Σ(δ − b₁)²
/// and Σ(b₁ − b₂)², with b₁ the 2D B3 kernel and b₂ it convolved with the dilated one.
const NOISE_FINE: f32 = 0.7935;
const NOISE_MID: f32 = 0.04023;

/// Brightness bins of the noise profile (square-rooted luminance, 0 … 1).
const BINS: usize = 32;

fn bin(luma: f32) -> usize {
    ((luma * BINS as f32) as usize).min(BINS - 1)
}

/// The luminance's noise variance by brightness: per bin, a low percentile of the
/// cells' noise samples (fine detail leaks into some of them; few cells are all
/// detail), bins without cells taking their nearest neighbour's.
fn noise_profile(mean: &[f32], noise: &[f32]) -> [f32; BINS] {
    let mut by_bin: Vec<Vec<f32>> = vec![Vec::new(); BINS];
    for (&m, &n) in mean.iter().zip(noise) {
        by_bin[bin(m)].push(n);
    }
    let measured: Vec<Option<f32>> = by_bin.iter().map(|v| (!v.is_empty()).then(|| percentile(v, 0.25))).collect();
    std::array::from_fn(|i| {
        (0..BINS)
            .flat_map(|d| [i.checked_sub(d), Some(i + d)])
            .flatten()
            .find_map(|j| measured.get(j).copied().flatten())
            .unwrap_or(0.0)
    })
}

fn grid(w: usize, h: usize) -> (usize, usize) {
    let long = w.max(h).max(1) as f32;
    let cols = ((w as f32 / long * CELLS as f32).round() as usize).clamp(1, w.max(1));
    let rows = ((h as f32 / long * CELLS as f32).round() as usize).clamp(1, h.max(1));
    (cols, rows)
}

/// `src` (`w × h`) blurred by B3 dilated `step` times, clamped at the edges.
fn blur(src: &[f32], w: usize, h: usize, step: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let out = &mut tmp[y * w..(y + 1) * w];
        for x in 0..w {
            let mut s = 0.0;
            for (t, k) in B3.iter().enumerate() {
                let xx = (x as isize + (t as isize - 2) * step as isize).clamp(0, w as isize - 1) as usize;
                s += k * row[xx];
            }
            out[x] = s;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let rows: [usize; 5] =
            std::array::from_fn(|t| (y as isize + (t as isize - 2) * step as isize).clamp(0, h as isize - 1) as usize);
        let dst = &mut out[y * w..(y + 1) * w];
        for (t, k) in B3.iter().enumerate() {
            let src = &tmp[rows[t] * w..(rows[t] + 1) * w];
            for x in 0..w {
                dst[x] += k * src[x];
            }
        }
    }
    out
}

fn percentile(values: &[f32], p: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    let i = ((v.len() - 1) as f32 * p).round() as usize;
    let (_, x, _) = v.select_nth_unstable_by(i, |a, b| a.total_cmp(b));
    *x
}

/// The sharpest region: around the sharpest cell (scores averaged over 3 × 3 cells, so a
/// single noisy one doesn't win), the cells connected to it at least `AREA_THRESHOLD` as
/// sharp.
fn area(scores: &[Option<f32>], cols: usize, rows: usize) -> Option<FocusArea> {
    let smooth: Vec<Option<f32>> = (0..cols * rows)
        .map(|i| {
            scores[i]?;
            let (cx, cy) = (i % cols, i / cols);
            let (mut sum, mut n) = (0.0, 0);
            for y in cy.saturating_sub(1)..(cy + 2).min(rows) {
                for x in cx.saturating_sub(1)..(cx + 2).min(cols) {
                    if let Some(s) = scores[y * cols + x] {
                        sum += s;
                        n += 1;
                    }
                }
            }
            Some(sum / n as f32)
        })
        .collect();
    let (best, top) = smooth
        .iter()
        .enumerate()
        .filter_map(|(i, s)| Some((i, (*s)?)))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    let threshold = top * AREA_THRESHOLD;
    let mut inside = vec![false; cols * rows];
    let mut stack = vec![best];
    inside[best] = true;
    let (mut x0, mut y0, mut x1, mut y1) = (cols, rows, 0, 0);
    let (mut wx, mut wy, mut wsum) = (0.0f32, 0.0f32, 0.0f32);
    while let Some(i) = stack.pop() {
        let (cx, cy) = (i % cols, i / cols);
        (x0, y0, x1, y1) = (x0.min(cx), y0.min(cy), x1.max(cx + 1), y1.max(cy + 1));
        let s = smooth[i].unwrap_or(0.0);
        wx += s * (cx as f32 + 0.5);
        wy += s * (cy as f32 + 0.5);
        wsum += s;
        for y in cy.saturating_sub(1)..(cy + 2).min(rows) {
            for x in cx.saturating_sub(1)..(cx + 2).min(cols) {
                let j = y * cols + x;
                if !inside[j] && smooth[j].is_some_and(|s| s >= threshold) {
                    inside[j] = true;
                    stack.push(j);
                }
            }
        }
    }
    let (fc, fr) = (cols as f32, rows as f32);
    let (cx, cy) = if wsum > 0.0 { (wx / wsum, wy / wsum) } else { ((x0 + x1) as f32 / 2.0, (y0 + y1) as f32 / 2.0) };
    Some(FocusArea {
        x: x0 as f32 / fc,
        y: y0 as f32 / fr,
        width: (x1 - x0) as f32 / fc,
        height: (y1 - y0) as f32 / fr,
        cx: cx / fc,
        cy: cy / fr,
    })
}

/// The luminance the measure reads, square-rooted, a row at a time.
struct Luma<'a> {
    photo: &'a RawPhoto,
    factor: usize,
    width: usize,
    height: usize,
    /// For a mosaic, which photosites of a `factor`-sized block (`dy * factor + dx`)
    /// to average, per block position in the CFA's period: green ones, or all.
    picks: Option<Picks>,
}

struct Picks {
    period_x: usize,
    period_y: usize,
    /// By `(block_y % period_y) * period_x + block_x % period_x`.
    offsets: Vec<Vec<(usize, usize)>>,
    /// Whether the picks are green photosites (else every block lacked one).
    green: bool,
}

impl<'a> Luma<'a> {
    fn new(photo: &'a RawPhoto) -> Self {
        let factor = match photo.layout {
            Layout::Mosaic(_) => 2,
            // Images aren't mosaics; very large ones are halved, which keeps detail enough.
            _ if photo.width.max(photo.height) > 8000 => 2,
            _ => 1,
        };
        let picks = match &photo.layout {
            Layout::Mosaic(cfa) => {
                // Blocks repeat with the CFA (Bayer 2 × 2: one; X-Trans 6 × 6: nine).
                let (px, py) = (cfa.width.max(1) / gcd(cfa.width.max(1), factor), cfa.height.max(1) / gcd(cfa.height.max(1), factor));
                let mut green = true;
                let offsets = (0..py)
                    .flat_map(|by| (0..px).map(move |bx| (bx, by)))
                    .map(|(bx, by)| {
                        let block: Vec<(usize, usize)> =
                            (0..factor).flat_map(|dy| (0..factor).map(move |dx| (dx, dy))).collect();
                        let greens: Vec<(usize, usize)> = block
                            .iter()
                            .copied()
                            .filter(|&(dx, dy)| photo.color_at(cfa, bx * factor + dx, by * factor + dy) == 1)
                            .collect();
                        if greens.is_empty() {
                            green = false;
                            block
                        } else {
                            greens
                        }
                    })
                    .collect::<Vec<_>>();
                Some(Picks { period_x: px, period_y: py, offsets, green })
            }
            _ => None,
        };
        Self { photo, factor, width: (photo.width / factor).max(1), height: (photo.height / factor).max(1), picks }
    }

    fn row(&self, y: usize, out: &mut [f32]) {
        let p = self.photo;
        let f = self.factor;
        for (x, o) in out.iter_mut().enumerate() {
            let v = match (&self.picks, &p.layout) {
                (Some(picks), _) => {
                    let sites = &picks.offsets[(y % picks.period_y) * picks.period_x + x % picks.period_x];
                    let sum: f32 = sites
                        .iter()
                        .map(|&(dx, dy)| p.sample((x * f + dx).min(p.width - 1), (y * f + dy).min(p.height - 1), 0))
                        .sum();
                    sum / sites.len() as f32
                }
                (None, Layout::Rgb) => {
                    let mut s = 0.0;
                    for dy in 0..f {
                        for dx in 0..f {
                            let (sx, sy) = ((x * f + dx).min(p.width - 1), (y * f + dy).min(p.height - 1));
                            s += 0.25 * p.sample(sx, sy, 0) + 0.5 * p.sample(sx, sy, 1) + 0.25 * p.sample(sx, sy, 2);
                        }
                    }
                    s / (f * f) as f32
                }
                (None, _) => {
                    let mut s = 0.0;
                    for dy in 0..f {
                        for dx in 0..f {
                            s += p.sample((x * f + dx).min(p.width - 1), (y * f + dy).min(p.height - 1), 0);
                        }
                    }
                    s / (f * f) as f32
                }
            };
            *o = v.max(0.0).sqrt();
        }
    }
}

impl Luma<'_> {
    /// Samples of the luminance's noise variance along row `y`: for a mosaic, from the
    /// difference between two green photosites of each block, which see nearly the same
    /// light (NaN where a block has one green). False when there are none (not a mosaic).
    fn noise_row(&self, y: usize, out: &mut [f32]) -> bool {
        let Some(picks) = &self.picks else { return false };
        let p = self.photo;
        let f = self.factor;
        for (x, o) in out.iter_mut().enumerate() {
            let sites = &picks.offsets[(y % picks.period_y) * picks.period_x + x % picks.period_x];
            *o = match sites.as_slice() {
                [(ax, ay), (bx, by), ..] if picks.green => {
                    let at = |dx: usize, dy: usize| p.sample((x * f + dx).min(p.width - 1), (y * f + dy).min(p.height - 1), 0).sqrt();
                    let d = at(*ax, *ay) - at(*bx, *by);
                    // Y averages n sites (variance σ²/n); d has variance 2σ².
                    d * d / (2 * sites.len()) as f32
                }
                _ => f32::NAN,
            };
        }
        true
    }
}

fn gcd(a: usize, b: usize) -> usize {
    if b == 0 { a } else { gcd(b, a % b) }
}

fn base64<S: serde::Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&encode_base64(bytes))
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_ratio_matches_the_kernels() {
        // b₁: B3 ⊗ B3 at step 1; b₂: b₁ convolved with B3 ⊗ B3 at step 2 (13 × 13).
        let mut k1 = [0.0f64; 13];
        for (i, a) in B3.iter().enumerate() {
            k1[4 + i] = *a as f64;
        }
        let mut k2 = [0.0f64; 13];
        for (i, a) in B3.iter().enumerate() {
            for (j, b) in B3.iter().enumerate() {
                k2[4 + i + 2 * j - 4] += (*a * *b) as f64;
            }
        }
        let (mut fine, mut mid) = (0.0, 0.0);
        for y in 0..13 {
            for x in 0..13 {
                let delta = if x == 6 && y == 6 { 1.0 } else { 0.0 };
                let b1 = k1[x] * k1[y];
                let b2 = k2[x] * k2[y];
                fine += (delta - b1).powi(2);
                mid += (b1 - b2).powi(2);
            }
        }
        assert!((fine as f32 - NOISE_FINE).abs() < 1e-3, "{fine}");
        assert!((mid as f32 - NOISE_MID).abs() < 1e-4, "{mid}");
    }

    #[test]
    fn base64_encodes() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(&[255, 0, 254]), "/wD+");
    }

    #[test]
    fn area_grows_from_the_sharpest_cell() {
        let mut scores = vec![Some(0.1); 8 * 6];
        for (x, y) in [(5, 2), (6, 2), (5, 3)] {
            scores[y * 8 + x] = Some(1.0);
        }
        scores[0] = None;
        let a = area(&scores, 8, 6).unwrap();
        assert!(a.x >= 4.0 / 8.0 && a.x + a.width <= 1.0, "{a:?}");
        assert!(a.cx > 0.6 && a.cx < 0.8 && a.cy > 0.3 && a.cy < 0.6, "{a:?}");
    }
}
