//! Colour calibration: a port of Ansel's `channelmixerrgb.c` ("color calibration"),
//! with its helpers from `pixel/chromatic_adaptation.h` and `pixel/illuminants.h`.
//!
//! Ansel is GPL-3.0-or-later, Copyright (C) 2020-2026 Aurélien Pierre and
//! contributors. Follows upstream commit `11fe9d529a18ff4f23c440939f53593eb74212b1`
//! (github.com/aurelienpierreeng/ansel).
//!
//! Per pixel, in linear Rec.2020: (clip) → XYZ → the adaptation's space (CAT16 or
//! Bradford LMS, XYZ, or RGB) → von Kries scaling from the illuminant to the white →
//! 3×3 mix → XYZ → gamut compression → the adaptation's space → colourfulness and
//! brightness → grey (monochrome) or back to RGB, clipping negatives at each step.
//! Everything up to the gamut compression is one matrix.
//!
//! Deviations from Ansel:
//! * The working space has a D65 white (Ansel's pipeline is D50), so colours adapt to
//!   D65, gamut compression and the custom illuminant's hue/chroma are relative to
//!   D65, and the "pipeline" illuminant is D65. Illuminants are real chromaticities:
//!   Ansel's "as shot" light goes through a D65 → D50 Bradford adaptation first, so it
//!   reads ~1500 K warmer there than the same light here.
//! * "As shot" stays a behaviour (it follows the file); Ansel turns it into a daylight,
//!   black body or custom illuminant when the module is first applied.
//! * The base stage clips highlights at the as-shot white (not at the reference one),
//!   so blown highlights stay neutral after an "as shot" adaptation.
//! * Only the v3 (2021) colourfulness algorithm; no non-linear Bradford; no colour
//!   checker or spot mode. Auto-detection is a one-shot action ([`detect_illuminant`])
//!   on the module's input, which sets a daylight, black body or custom illuminant.
//! * Gamut compression's `Δ^(1/gamut)` is read from a lookup table.

use crate::color::{self, Mat3, mul, mul_vec};
use crate::image::{Image, Rgb};
use crate::ops::lut::{BitsLut, CEILING, FINE, FLOOR};
use crate::params::{Adaptation, ColorCalibration, Illuminant};

/// darktable's smallest norm (2⁻¹⁶).
const NORM_MIN: f32 = 1.525_878_9e-5;
const INVERSE_SQRT_3: f32 = 0.577_350_26;

/// XYZ → CAT16 LMS (CIECAM16).
const XYZ_TO_CAT16: Mat3 = [[0.401288, 0.650173, -0.051461], [-0.250268, 1.204414, 0.045854], [-0.002079, 0.048952, 0.953127]];
const CAT16_TO_XYZ: Mat3 = [[1.862068, -1.011255, 0.149187], [0.38752, 0.621447, -0.008974], [-0.015841, -0.034123, 1.049964]];
/// XYZ → Bradford LMS.
const XYZ_TO_BRADFORD: Mat3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_TO_XYZ: Mat3 = [[0.9870, -0.1471, 0.1600], [0.4323, 0.5184, 0.0493], [-0.0085, 0.0400, 0.9685]];

/// CIE 1931 xy of the fluorescent illuminants F1 … F12.
const FLUORESCENT: [[f32; 2]; 12] = [
    [0.31310, 0.33727],
    [0.37208, 0.37529],
    [0.40910, 0.39430],
    [0.44018, 0.40329],
    [0.31379, 0.34531],
    [0.37790, 0.38835],
    [0.31292, 0.32933],
    [0.34588, 0.35875],
    [0.37417, 0.37281],
    [0.34609, 0.35986],
    [0.38052, 0.37713],
    [0.43695, 0.40441],
];

/// CIE 1931 xy of the LED illuminants B1 … B5, BH1, RGB1, V1, V2.
const LED: [[f32; 2]; 9] = [
    [0.4560, 0.4078],
    [0.4357, 0.4012],
    [0.3756, 0.3723],
    [0.3422, 0.3502],
    [0.3118, 0.3236],
    [0.4474, 0.4066],
    [0.4557, 0.4211],
    [0.4560, 0.4548],
    [0.3781, 0.3775],
];

/// Daylight chromaticity at a correlated colour temperature, 4000 … 25000 K; `None` outside.
pub fn daylight_xy(t: f32) -> Option<[f32; 2]> {
    let x = if (4000.0..=7000.0).contains(&t) {
        ((-4.6070e9 / t + 2.9678e6) / t + 0.09911e3) / t + 0.244063
    } else if t > 7000.0 && t <= 25000.0 {
        ((-2.0064e9 / t + 1.9018e6) / t + 0.24748e3) / t + 0.237040
    } else {
        return None;
    };
    Some([x, (-3.0 * x + 2.87) * x - 0.275])
}

/// Planckian locus at a temperature, 1667 … 25000 K; `None` outside.
pub fn black_body_xy(t: f32) -> Option<[f32; 2]> {
    let x = if (1667.0..=4000.0).contains(&t) {
        ((-0.2661239e9 / t - 0.2343589e6) / t + 0.8776956e3) / t + 0.179910
    } else if t > 4000.0 && t <= 25000.0 {
        ((-3.0258469e9 / t + 2.1070379e6) / t + 0.2226347e3) / t + 0.240390
    } else {
        return None;
    };
    let y = if t <= 2222.0 {
        ((-1.1063814 * x - 1.34811020) * x + 2.18555832) * x - 0.20219683
    } else if t <= 4000.0 {
        ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
    } else {
        ((3.0817580 * x - 5.87338670) * x + 3.75112997) * x - 0.37001483
    };
    Some([x, y])
}

/// The xy chromaticity of the light to adapt from; `as_shot` is the file's.
pub fn illuminant_xy(p: &ColorCalibration, as_shot: Option<[f32; 2]>) -> [f32; 2] {
    let white = color::white_xy();
    let t = p.temperature.clamp(1667.0, 25000.0);
    match p.illuminant {
        Illuminant::AsShot => as_shot.unwrap_or(white),
        Illuminant::Pipeline => white,
        // Below 4000 K, the daylight model falls back to the black body.
        Illuminant::Daylight => daylight_xy(t).or_else(|| black_body_xy(t)).unwrap_or(white),
        Illuminant::BlackBody => black_body_xy(t).unwrap_or(white),
        Illuminant::A => [0.44757, 0.40745],
        Illuminant::E => [1.0 / 3.0; 2],
        Illuminant::Fluorescent => FLUORESCENT[p.fluorescent as usize],
        Illuminant::Led => LED[p.led as usize],
        Illuminant::Custom if p.x > 0.0 && p.y > 0.0 && p.x + p.y < 1.0 => [p.x, p.y],
        Illuminant::Custom => white,
    }
}

/// The 3×3 mix, in the CAT16 space of the default calibration, that equals per-channel
/// `gains` in linear Rec.2020 after the adaptation (warmth/tint, migrated). In f64 so
/// that TypeScript gets the same numbers (`mixForRgbGains`).
pub fn mix_for_rgb_gains(gains: [f64; 3]) -> [[f64; 3]; 3] {
    type M = [[f64; 3]; 3];
    let f = |m: &Mat3| m.map(|row| row.map(f64::from));
    let mul = |a: &M, b: &M| {
        let mut out = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                let mut s = 0.0;
                for k in 0..3 {
                    s += a[i][k] * b[k][j];
                }
                out[i][j] = s;
            }
        }
        out
    };
    let lms_from_rgb = mul(&f(&XYZ_TO_CAT16), &mul(&f(&color::XYZ_FROM_REC709), &f(&color::REC709_FROM_REC2020)));
    let rgb_from_lms = mul(&f(&color::REC2020_FROM_REC709), &mul(&f(&color::REC709_FROM_XYZ), &f(&CAT16_TO_XYZ)));
    let mut diag = [[0.0; 3]; 3];
    for c in 0..3 {
        diag[c][c] = gains[c];
    }
    mul(&lms_from_rgb, &mul(&diag, &rgb_from_lms))
}

fn diag(v: Rgb) -> Mat3 {
    [[v[0], 0.0, 0.0], [0.0, v[1], 0.0], [0.0, 0.0, v[2]]]
}

#[inline(always)]
fn max0(v: Rgb) -> Rgb {
    v.map(|c| c.max(0.0))
}

/// Gamut compression, Ansel's `gamut_mapping`: moves bright saturated colours toward
/// the white in CIE 1976 u'v', by `(Y·Δuv²)^(1/gamut)` of their distance.
enum Compression {
    Off,
    /// gamut = 1: the exponent is 1.
    Linear,
    Lut(BitsLut<f32>),
}

/// One colour calibration instance, compiled. The per-pixel code has no branches, so
/// that loops over pixels vectorise (4× faster than a branchy version).
pub struct CalibrationStage {
    /// 0 when clipping negative values, −∞ otherwise.
    floor: f32,
    /// Working RGB → XYZ, through the adaptation and the mix.
    to_xyz: Mat3,
    compression: Compression,
    white_uv: [f32; 2],
    /// XYZ → the adaptation's space, where colourfulness, brightness and grey act.
    to_space: Mat3,
    from_space: Mat3,
    rgb_from_xyz: Mat3,
    /// Colourfulness and brightness coefficients, if any is non-zero.
    luma_chroma: Option<(Rgb, Rgb)>,
    grey: Option<Rgb>,
}

impl CalibrationStage {
    /// `None` when the instance doesn't change the image.
    pub fn new(p: &ColorCalibration, as_shot: Option<[f32; 2]>) -> Option<Self> {
        let xyz_from_rgb = color::xyz_from_rec2020();
        let rgb_from_xyz = color::rec2020_from_xyz();
        // "As shot" is always CAT16, as in Ansel.
        let adaptation = if p.illuminant == Illuminant::AsShot { Adaptation::Cat16 } else { p.adaptation };
        let (to_space, from_space) = match adaptation {
            Adaptation::Cat16 => (XYZ_TO_CAT16, CAT16_TO_XYZ),
            Adaptation::LinearBradford => (XYZ_TO_BRADFORD, BRADFORD_TO_XYZ),
            Adaptation::Xyz => (color::IDENTITY, color::IDENTITY),
            Adaptation::None => (rgb_from_xyz, xyz_from_rgb),
        };

        let sum = |v: &[f32; 3]| v[0] + v[1] + v[2];
        let row = |v: [f32; 3], normalize: bool| {
            let n = if normalize { sum(&v) } else { 1.0 };
            v.map(|c| c / n)
        };
        let mix = [row(p.red, p.normalize_red), row(p.green, p.normalize_green), row(p.blue, p.normalize_blue)];
        let mean = |v: &[f32; 3], normalize: bool| if normalize { sum(v) / 3.0 } else { 0.0 };
        let (norm_sat, norm_light) = (mean(&p.colorfulness, p.normalize_colorfulness), mean(&p.brightness, p.normalize_brightness));
        let saturation = p.colorfulness.map(|v| -v + norm_sat);
        let lightness = p.brightness.map(|v| v - norm_light);
        let grey_sum = sum(&p.grey);
        let grey_norm = if p.normalize_grey && grey_sum != 0.0 { grey_sum } else { 1.0 };
        let grey = p.grey.iter().any(|&g| g != 0.0).then(|| p.grey.map(|g| g / grey_norm));
        let luma_chroma = (saturation.iter().chain(&lightness).any(|&v| v != 0.0)).then_some((saturation, lightness));

        // Von Kries scaling from the illuminant to the white, in the adaptation's space.
        let white = color::white_xyz();
        let [x, y] = illuminant_xy(p, as_shot);
        let illuminant = [x / y, 1.0, (1.0 - x - y) / y];
        let scale = match adaptation {
            Adaptation::None => [1.0; 3],
            _ => {
                let (w, i) = (mul_vec(&to_space, white), mul_vec(&to_space, illuminant));
                [0, 1, 2].map(|c| w[c] / i[c])
            }
        };

        let identity_mix = mix == color::IDENTITY;
        if identity_mix && scale.iter().all(|&s| (s - 1.0).abs() < 1e-6) && p.gamut == 0.0 && !p.clip && luma_chroma.is_none() && grey.is_none() {
            return None;
        }

        let to_xyz = match adaptation {
            Adaptation::None => mul(&xyz_from_rgb, &mix),
            _ => mul(&from_space, &mul(&mix, &mul(&diag(scale), &mul(&to_space, &xyz_from_rgb)))),
        };
        let compression = match p.gamut.clamp(0.0, 12.0) {
            0.0 => Compression::Off,
            1.0 => Compression::Linear,
            g => Compression::Lut(BitsLut::new(FLOOR, CEILING, FINE, |delta| delta.powf(1.0 / g))),
        };
        let [wx, wy] = color::white_xy();
        let d = -2.0 * wx + 12.0 * wy + 3.0;
        Some(Self {
            floor: if p.clip { 0.0 } else { f32::NEG_INFINITY },
            to_xyz,
            compression,
            white_uv: [4.0 * wx / d, 9.0 * wy / d],
            to_space,
            from_space,
            rgb_from_xyz,
            luma_chroma,
            grey,
        })
    }

    #[inline]
    pub fn apply(&self, px: Rgb) -> Rgb {
        let v = match &self.compression {
            Compression::Off => self.forward(px, |_| 0.0),
            Compression::Linear => self.forward(px, |delta| delta),
            Compression::Lut(lut) => self.forward(px, |delta| lut.eval(delta)),
        };
        self.finish(v)
    }

    /// [`apply`](Self::apply) to many pixels. The settings are matched once, outside
    /// the loop, so that the loop is straight-line code.
    #[inline]
    pub fn apply_all(&self, pixels: &mut [Rgb]) {
        match &self.compression {
            Compression::Off => self.apply_with(pixels, |_| 0.0),
            Compression::Linear => self.apply_with(pixels, |delta| delta),
            Compression::Lut(lut) => self.apply_with(pixels, |delta| lut.eval(delta)),
        }
    }

    #[inline(always)]
    fn apply_with(&self, pixels: &mut [Rgb], correction: impl Fn(f32) -> f32) {
        match (&self.luma_chroma, &self.grey) {
            (None, None) => pixels.iter_mut().for_each(|c| *c = self.back(self.forward(*c, &correction))),
            _ => pixels.iter_mut().for_each(|c| *c = self.finish(self.forward(*c, &correction))),
        }
    }

    /// Up to the adaptation's space: clip, adapt and mix, compress the gamut.
    #[inline(always)]
    fn forward(&self, px: Rgb, correction: impl Fn(f32) -> f32) -> Rgb {
        let xyz = self.gamut_mapping(mul_vec(&self.to_xyz, self.clip(px)), correction);
        self.clip(mul_vec(&self.to_space, xyz))
    }

    #[inline(always)]
    fn clip(&self, v: Rgb) -> Rgb {
        v.map(|c| c.max(self.floor))
    }

    /// Colourfulness and brightness, then grey or back to RGB.
    #[inline(always)]
    fn finish(&self, mut v: Rgb) -> Rgb {
        if let Some((saturation, lightness)) = &self.luma_chroma {
            v = self.clip(luma_chroma(v, saturation, lightness));
        }
        if let Some(grey) = &self.grey {
            return [(v[0] * grey[0] + v[1] * grey[1] + v[2] * grey[2]).max(0.0); 3];
        }
        self.back(v)
    }

    #[inline(always)]
    fn back(&self, v: Rgb) -> Rgb {
        self.clip(mul_vec(&self.rgb_from_xyz, self.clip(mul_vec(&self.from_space, v))))
    }

    #[inline(always)]
    fn gamut_mapping(&self, xyz: Rgb, correction: impl Fn(f32) -> f32) -> Rgb {
        let big_y = xyz[1];
        // Ansel goes XYZ → xy → u'v'; this is the same with fewer divisions.
        let inv = 1.0 / (xyz[0] + 15.0 * xyz[1] + 3.0 * xyz[2]);
        let (u, v) = (4.0 * xyz[0] * inv, 9.0 * xyz[1] * inv);
        let [wu, wv] = self.white_uv;
        let delta = [wu - u, wv - v];
        let big_delta = big_y * (delta[0] * delta[0] + delta[1] * delta[1]);
        let correction = correction(big_delta);
        // Never past the white, which would flip the hue: Ansel clamps u and v at the
        // white, which is moving at most the whole way there. (`mul_add` would be a
        // software FMA call, natively and in wasm.)
        let t = correction.min(1.0);
        let (u, v) = (u + t * delta[0], v + t * delta[1]);

        let inv = 1.0 / (6.0 * u - 16.0 * v + 12.0);
        let x = (9.0 * u * inv).max(self.floor);
        let y = (4.0 * v * inv).max(self.floor).max(NORM_MIN);
        // Z = Y (1 - x - y) / y must not be negative: x + y < 1. (Dividing by 1 is exact.)
        let s = (x + y).max(1.0);
        let (x, y) = (x / s, y / s);
        let y_over_y = big_y / y;
        let out = [x * y_over_y, big_y, (1.0 - x - y) * y_over_y];
        // Black (and nonsense) stays black.
        if xyz[0] + xyz[1] + xyz[2] > 0.0 && big_y > 0.0 { out } else { [0.0; 3] }
    }
}

fn euclidean_norm(v: Rgb) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(NORM_MIN)
}

/// Ansel's `luma_chroma` (v3): colourfulness scales each channel's ratio to the norm
/// toward or away from 1 (grey); brightness scales the norm.
#[inline]
fn luma_chroma(input: Rgb, saturation: &Rgb, lightness: &Rgb) -> Rgb {
    let mut norm = euclidean_norm(input);
    let avg = ((input[0] + input[1] + input[2]) / 3.0).max(NORM_MIN);
    let mix = input[0] * lightness[0] + input[1] * lightness[1] + input[2] * lightness[2];
    // Ratios are (1, 1, 1) for greys.
    norm *= INVERSE_SQRT_3;
    let inv = 1.0 / norm;
    let mut out = input.map(|c| c * inv);
    let coeff = (out[0] * saturation[0] + out[1] * saturation[1] + out[2] * saturation[2]) / 3.0;
    for c in &mut out {
        // A ratio that was already negative may stay so, or bright saturated blues turn black.
        let min_ratio = c.min(0.0);
        *c = ((1.0 - *c) * coeff + *c).max(min_ratio);
    }
    // Moving the ratios toward or away from grey changed their norm.
    norm /= euclidean_norm(out) * INVERSE_SQRT_3;
    norm *= (1.0 + mix / avg).max(0.0);
    out.map(|c| c * norm)
}

/// Ansel's illuminant auto-detection (the same as darktable's). It is a rough guess: on
/// the golden RAWs, "edges" lands within a few hundred kelvin of D65 whatever the light,
/// and "surfaces" can be pulled to D65 by noisy dark areas (a tungsten scene came out
/// at ~6100 K).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Detection {
    /// Grey world, weighted toward textured, chroma-correlated patches.
    Surfaces,
    /// Grey edges: the average colour of the image's details.
    Edges,
}

/// Estimate the scene's light from an image (the calibration's input, through `adjust`):
/// Ansel's `auto_detect_WB`. Returns its xy chromaticity, or `None` if the image is too
/// small or has nothing to measure.
pub fn detect_illuminant(img: &Image, adjust: impl Fn(Rgb) -> Rgb, method: Detection) -> Option<[f32; 2]> {
    // Ansel samples every 4th pixel, and its neighbours 4 pixels away: a grid.
    const OFF: usize = 4;
    let (gw, gh) = (img.width.div_ceil(OFF), img.height.div_ceil(OFF));
    let xyz_from_rgb = color::xyz_from_rec2020();
    let white = color::white_xy();
    let norm = white[0].hypot(white[1]);
    // Chromaticity relative to the white, per grid point.
    let mut grid = vec![[0.0f32; 2]; gw * gh];
    for gy in 0..gh {
        for gx in 0..gw {
            let rgb = max0(adjust(img.pixels[gy * OFF * img.width + gx * OFF]));
            let xyz = mul_vec(&xyz_from_rgb, rgb);
            let sum = (xyz[0] + xyz[1] + xyz[2]).max(NORM_MIN);
            grid[gy * gw + gx] = [(xyz[0] / sum - white[0]) / norm, (xyz[1] / sum - white[1]) / norm];
        }
    }

    let at = |gx: usize, gy: usize, c: usize| grid[gy * gw + gx][c];
    let (mut acc, mut elements) = ([0.0f64; 2], 0.0f64);
    // Ansel's bounds: 2·OFF ≤ i < height − 4·OFF.
    let (y_end, x_end) = ((img.height.saturating_sub(4 * OFF)).div_ceil(OFF), (img.width.saturating_sub(4 * OFF)).div_ceil(OFF));
    for gy in 2..y_end {
        for gx in 2..x_end {
            let n = |dx: isize, dy: isize, c: usize| at((gx as isize + dx) as usize, (gy as isize + dy) as usize, c);
            let mut average = [0.0f32; 2];
            for (c, a) in average.iter_mut().enumerate() {
                // B-spline local average.
                *a = (n(-1, -1, c) + 2.0 * n(0, -1, c) + n(1, -1, c) + 2.0 * n(-1, 0, c) + 4.0 * n(0, 0, c) + 2.0 * n(1, 0, c) + n(-1, 1, c) + 2.0 * n(0, 1, c) + n(1, 1, c)) / 16.0;
            }
            let p_norm = |v: [f32; 2]| (v[0].abs().powi(8) + v[1].abs().powi(8)).powf(1.0 / 8.0) + NORM_MIN;
            match method {
                Detection::Surfaces => {
                    let average = average.map(|a| a.max(0.0));
                    let neighbours = || (-1..=1).flat_map(|dy| (-1..=1).map(move |dx| (dx, dy)));
                    let var = |c: usize| neighbours().map(|(dx, dy)| (n(dx, dy, c) - average[c]).powi(2)).sum::<f32>() / 9.0;
                    // Covariance of the chroma channels: ~0 for noise or chromatic aberration.
                    let covar = neighbours().map(|(dx, dy)| (n(dx, dy, 0) - average[0]) * (n(dx, dy, 1) - average[1])).sum::<f32>() / 9.0;
                    let weight = var(0) * var(1) * covar;
                    let p = p_norm(average);
                    for c in 0..2 {
                        acc[c] += (average[c] * weight / p) as f64;
                    }
                    elements += (weight / p) as f64;
                }
                Detection::Edges => {
                    // Image − blur: the details.
                    let dd = [n(0, 0, 0) - average[0], n(0, 0, 1) - average[1]];
                    let p = p_norm(dd);
                    for c in 0..2 {
                        acc[c] -= (dd[c] / p) as f64;
                    }
                    elements += 1.0;
                }
            }
        }
    }
    let xy = [0, 1].map(|c| norm * (acc[c] / elements) as f32 + white[c]);
    (elements != 0.0 && xy.iter().all(|v| v.is_finite() && *v > 0.0) && xy[0] + xy[1] < 1.0).then_some(xy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::luminance;

    fn stage(f: impl FnOnce(&mut ColorCalibration)) -> CalibrationStage {
        let mut p = ColorCalibration::default();
        f(&mut p);
        CalibrationStage::new(&p, Some(black_body_xy(3200.0).unwrap())).expect("not identity")
    }

    fn approx(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
    }

    #[test]
    fn cat16_matrices_are_inverses() {
        for (a, b) in [(XYZ_TO_CAT16, CAT16_TO_XYZ), (XYZ_TO_BRADFORD, BRADFORD_TO_XYZ)] {
            let m = mul(&a, &b);
            // Ansel's Bradford matrices have 4 decimals.
            assert!(approx(m[0], [1.0, 0.0, 0.0], 2e-4) && approx(m[1], [0.0, 1.0, 0.0], 2e-4) && approx(m[2], [0.0, 0.0, 1.0], 2e-4), "{m:?}");
        }
    }

    #[test]
    fn as_shot_neutral_becomes_white() {
        let s = stage(|p| p.gamut = 0.0);
        // A grey lit by the as-shot light, in the D65-balanced working space.
        let [x, y] = black_body_xy(3200.0).unwrap();
        let grey = mul_vec(&color::rec2020_from_xyz(), [x / y * 0.18, 0.18, (1.0 - x - y) / y * 0.18]);
        let out = s.apply(grey);
        assert!(approx(out, [out[1]; 3], 1e-4), "{out:?}");
        // CAT16's von Kries scaling doesn't keep Y exactly.
        assert!((out[1] / 0.18 - 1.0).abs() < 0.05, "{out:?}");
    }

    #[test]
    fn pipeline_illuminant_without_extras_is_identity() {
        let neutral = ColorCalibration { illuminant: Illuminant::Pipeline, gamut: 0.0, clip: false, ..Default::default() };
        assert!(CalibrationStage::new(&neutral, None).is_none());
        let none = ColorCalibration { adaptation: Adaptation::None, illuminant: Illuminant::Daylight, gamut: 0.0, clip: false, ..Default::default() };
        assert!(CalibrationStage::new(&none, None).is_none());
        // As shot, without a known as-shot light, still compresses the gamut.
        let s = CalibrationStage::new(&ColorCalibration::default(), None).unwrap();
        assert!(approx(s.apply([0.18; 3]), [0.18; 3], 1e-5));
    }

    #[test]
    fn adaptations_agree_on_greys() {
        for adaptation in [Adaptation::Cat16, Adaptation::LinearBradford, Adaptation::Xyz] {
            let s = stage(|p| {
                p.illuminant = Illuminant::Daylight;
                p.temperature = 5000.0;
                p.adaptation = adaptation;
                p.gamut = 0.0;
            });
            let [x, y] = daylight_xy(5000.0).unwrap();
            let grey = mul_vec(&color::rec2020_from_xyz(), [x / y, 1.0, (1.0 - x - y) / y]);
            let out = s.apply(grey);
            assert!(approx(out, [out[1]; 3], 3e-4), "{adaptation:?}: {out:?}");
        }
    }

    #[test]
    fn gamut_compression_desaturates_bright_colours_more() {
        let none = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.gamut = 0.0;
        });
        let strong = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.gamut = 2.0;
        });
        let chroma = |c: Rgb| (c[0] - c[2]) / luminance(c);
        for v in [0.05f32, 2.0] {
            let px = [0.9 * v, 0.3 * v, 0.1 * v];
            assert!(approx(none.apply(px), px, 1e-4 * v));
            let out = strong.apply(px);
            assert!(chroma(out) < chroma(px) && chroma(out) > 0.0, "{v}: {out:?}");
        }
        let (dim, bright) = ([0.045, 0.015, 0.005], [1.8, 0.6, 0.2]);
        assert!(chroma(strong.apply(dim)) > chroma(strong.apply(bright)));
    }

    #[test]
    fn grey_makes_monochrome() {
        let s = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.grey = [0.5, 0.5, 0.0];
            p.normalize_grey = true;
        });
        let out = s.apply([0.5, 0.2, 0.1]);
        assert_eq!(out[0], out[1]);
        assert_eq!(out[1], out[2]);
        assert!(out[0] > 0.0);
    }

    #[test]
    fn colorfulness_and_brightness() {
        let px = [0.4, 0.2, 0.1];
        let chroma = |c: Rgb| (c[0] - c[2]) / (c[0] + c[1] + c[2]);
        let more = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.gamut = 0.0;
            p.colorfulness = [0.5; 3];
        });
        let less = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.gamut = 0.0;
            p.colorfulness = [-0.5; 3];
        });
        assert!(chroma(more.apply(px)) > chroma(px) && chroma(less.apply(px)) < chroma(px));
        let brighter = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.gamut = 0.0;
            p.brightness = [0.5; 3];
        });
        assert!(luminance(brighter.apply(px)) > luminance(px));
        // Greys keep their colour where white is (1, 1, 1): in RGB. (In LMS they don't
        // quite, as in Ansel.)
        let rgb = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.adaptation = Adaptation::None;
            p.colorfulness = [0.5; 3];
        });
        let out = rgb.apply([0.18; 3]);
        assert!(approx(out, [out[1]; 3], 1e-5), "{out:?}");
    }

    #[test]
    fn rgb_mix_in_none_adaptation() {
        let s = stage(|p| {
            p.adaptation = Adaptation::None;
            p.illuminant = Illuminant::Daylight;
            p.gamut = 0.0;
            p.clip = false;
            p.red = [0.0, 1.0, 0.0];
        });
        assert!(approx(s.apply([0.4, 0.2, 0.1]), [0.2, 0.2, 0.1], 1e-5));
    }

    #[test]
    fn migrated_gains_match_rgb_gains() {
        let gains = [1.2f64, 0.95, 0.8];
        let mix = mix_for_rgb_gains(gains).map(|row| row.map(|v| v as f32));
        let s = stage(|p| {
            p.illuminant = Illuminant::Pipeline;
            p.gamut = 0.0;
            p.clip = false;
            [p.red, p.green, p.blue] = mix;
            (p.normalize_red, p.normalize_green, p.normalize_blue) = (false, false, false);
        });
        let px = [0.3, 0.2, 0.1];
        assert!(approx(s.apply(px), [0.36, 0.19, 0.08], 1e-5), "{:?}", s.apply(px));
    }

    #[test]
    fn illuminants() {
        let d65 = daylight_xy(6504.0).unwrap();
        assert!((d65[0] - 0.3127).abs() < 5e-4 && (d65[1] - 0.3291).abs() < 5e-4, "{d65:?}");
        let a = black_body_xy(2856.0).unwrap();
        assert!((a[0] - 0.4476).abs() < 2e-3 && (a[1] - 0.4074).abs() < 2e-3, "{a:?}");
        // Daylight falls back to the black body below 4000 K.
        let p = ColorCalibration { illuminant: Illuminant::Daylight, temperature: 3000.0, ..Default::default() };
        assert_eq!(illuminant_xy(&p, None), black_body_xy(3000.0).unwrap());
    }

    /// A scene of textured surfaces of various colours, lit by `light` (xy).
    fn scene(light: [f32; 2]) -> Image {
        let [x, y] = light;
        let light = mul_vec(&color::rec2020_from_xyz(), [x / y, 1.0, (1.0 - x - y) / y]);
        let (w, h) = (240, 160);
        let mut img = Image::new(w, h);
        let hash = |n: usize| ((n.wrapping_mul(2_654_435_761) >> 7) % 1000) as f32 / 1000.0;
        for j in 0..h {
            for i in 0..w {
                let patch = (j / 20) * 31 + i / 20;
                let reflectance = [hash(patch * 3), hash(patch * 3 + 1), hash(patch * 3 + 2)].map(|r| 0.2 + 0.6 * r);
                let texture = 0.6 + 0.4 * hash(j * w + i);
                img.pixels[j * w + i] = [0, 1, 2].map(|c| light[c] * reflectance[c] * texture * 0.3);
            }
        }
        img
    }

    #[test]
    fn detects_a_warm_light() {
        let white = color::white_xy();
        let light = black_body_xy(3200.0).unwrap();
        let near = |a: [f32; 2], b: [f32; 2], tol: f32| (a[0] - b[0]).abs() < tol && (a[1] - b[1]).abs() < tol;
        let found = detect_illuminant(&scene(light), |px| px, Detection::Surfaces).unwrap();
        assert!(found[0] > white[0] + 0.04 && found[1] > white[1] + 0.04, "{found:?}");
        assert!(near(detect_illuminant(&scene(white), |px| px, Detection::Surfaces).unwrap(), white, 1e-3));
        // Grey edges averages the direction of colour details, which says little about
        // this scene; only check that it measures something sensible.
        assert!(near(detect_illuminant(&scene(white), |px| px, Detection::Edges).unwrap(), white, 0.02));
        assert_eq!(detect_illuminant(&Image::new(10, 10), |px| px, Detection::Edges), None);
    }
}
