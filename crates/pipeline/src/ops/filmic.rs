//! Filmic RGB tone mapping — a port of Ansel's `filmicrgb` module
//! (https://github.com/aurelienpierreeng/ansel, `src/iop/filmicrgb.c`), restricted to
//! what Ansel ships by default:
//!
//! * spline v3 with the "perceptual" sigmoid toe and shoulder,
//! * auto hardness (the display power is derived from the dynamic range),
//! * colour science v8 "AgX": the curve runs per channel in an *inset* rendering
//!   space, an *outset* matrix re-expands the result, hue is then recovered in
//!   Kirk/Filmlight Ych, and the result is gamut-mapped to the display (sRGB).
//!
//! Ansel works in a D50-adapted Rec.2020 and converts to D65 with CAT16 before going
//! to LMS; our working space is Rec.2020 D65, so we go straight from XYZ D65.
//! Highlight reconstruction (deprecated in Ansel) is not ported.

use crate::color::{self, Mat3, XYZ_FROM_REC709, mul, mul_vec};
use crate::image::Rgb;
use crate::params::{Bleach, Filmic as FilmicParams};

// ── Colour spaces ───────────────────────────────────────────────────────────

/// Linear Rec.2020 (D65) → CIE XYZ.
const XYZ_FROM_REC2020: Mat3 = [
    [0.636_958_0, 0.144_616_9, 0.168_881_0],
    [0.262_700_2, 0.677_998_1, 0.059_301_7],
    [0.000_000_0, 0.028_072_7, 1.060_985_1],
];

/// CIE XYZ (D65) → CIE 2006 LMS, Kirk's approximation.
const LMS_FROM_XYZ: Mat3 = [
    [0.257_085, 0.859_943, -0.031_061],
    [-0.394_427, 1.175_800, 0.106_423],
    [0.064_856, -0.076_250, 0.559_067],
];

/// Filmlight "grading RGB" ↔ LMS.
const LMS_FROM_GRADING: Mat3 = [[0.95, 0.38, 0.00], [0.05, 0.62, 0.03], [0.00, 0.00, 0.97]];
const GRADING_FROM_LMS: Mat3 = [
    [1.087_719_3, -0.666_666_67, 0.020_618_56],
    [-0.087_719_3, 1.666_666_67, -0.051_546_39],
    [0.0, 0.0, 1.030_927_84],
];

/// Chromaticity of the D65 white point in Yrg.
const WHITE_R: f32 = 0.219_021_43;
const WHITE_G: f32 = 0.543_713_98;

/// CIE Y 1931 → CIE Y 2006 (for achromatic pixels).
const Y_1931_TO_2006: f32 = 1.057_855_28;

fn lms_to_yrg(lms: Rgb) -> Rgb {
    let y = 0.689_902_72 * lms[0] + 0.348_321_89 * lms[1];
    let a = lms[0] + lms[1] + lms[2];
    let inv = if a == 0.0 { 0.0 } else { 1.0 / a };
    let rgb = mul_vec(&GRADING_FROM_LMS, lms.map(|v| v * inv));
    [y, rgb[0], rgb[1]]
}

fn yrg_to_lms(yrg: Rgb) -> Rgb {
    let lms = mul_vec(&LMS_FROM_GRADING, [yrg[1], yrg[2], 1.0 - yrg[1] - yrg[2]]);
    let denom = 0.689_902_72 * lms[0] + 0.348_321_89 * lms[1];
    let a = if denom == 0.0 { 0.0 } else { yrg[0] / denom };
    lms.map(|v| v * a)
}

/// Luminance, chroma and hue (as cos/sin) in Kirk/Filmlight Ych.
#[derive(Clone, Copy, Debug)]
struct Ych {
    y: f32,
    c: f32,
    cos_h: f32,
    sin_h: f32,
}

fn rgb_to_ych(rgb: Rgb, to_lms: &Mat3) -> Ych {
    let [y, r, g] = lms_to_yrg(mul_vec(to_lms, rgb));
    let (r, g) = (r - WHITE_R, g - WHITE_G);
    let c = (r * r + g * g).sqrt();
    let (cos_h, sin_h) = if c != 0.0 { (r / c, g / c) } else { (1.0, 0.0) };
    Ych { y, c, cos_h, sin_h }
}

fn ych_to_rgb(ych: Ych, from_lms: &Mat3) -> Rgb {
    let yrg = [ych.y, ych.c * ych.cos_h + WHITE_R, ych.c * ych.sin_h + WHITE_G];
    mul_vec(from_lms, yrg_to_lms(yrg))
}

// ── The curve ───────────────────────────────────────────────────────────────

const SAFETY_MARGIN: f32 = 0.01;
const GREY_SOURCE: f32 = 0.1845;
const GREY_TARGET: f32 = 0.1845;
const BLACK_TARGET: f32 = 0.000_151_763_4; // 0.01517634 %
const WHITE_TARGET: f32 = 1.0;
const TOE_POWER: f32 = 1.5;

/// The filmic S curve, in log-encoded input / display-encoded output space.
#[derive(Clone, Debug, PartialEq)]
pub struct Spline {
    /// Nodes: black, toe, grey, shoulder, white.
    pub x: [f32; 5],
    pub y: [f32; 5],
    contrast: f32,
    /// Latitude (linear part) offset.
    intercept: f32,
    toe_scale: f32,
    toe_fallback: Option<(f32, f32)>,
    shoulder: (f32, f32),
    /// Display power ("hardness") applied after the curve.
    pub power: f32,
    black_source: f32,
    dynamic_range: f32,
}

fn sigmoid_scale(limit_x: f32, limit_y: f32, transition_x: f32, transition_y: f32, slope: f32, power: f32) -> f32 {
    let projected_rise = slope * (limit_x - transition_x).max(1e-6);
    let actual_rise = (limit_y - transition_y).max(1e-6);
    let base = (actual_rise.powf(-power) - projected_rise.powf(-power)).max(1e-6);
    base.powf(-1.0 / power).min(1e9)
}

impl Spline {
    pub fn new(p: &FilmicParams) -> Self {
        let white_source = p.white_exposure.clamp(0.1, 16.0);
        let black_source = p.black_exposure.clamp(-16.0, -0.1);
        let dynamic_range = white_source - black_source;
        let grey_log = black_source.abs() / dynamic_range;
        // Auto hardness: the power that brings the log-encoded grey to display grey.
        let power = GREY_TARGET.ln() / grey_log.ln();

        // Geometry of the linear segment (spline v3).
        let grey_display = GREY_TARGET.powf(1.0 / power);
        let black_display = BLACK_TARGET.min(GREY_TARGET).powf(1.0 / power);
        let white_display = WHITE_TARGET.max(GREY_TARGET).powf(1.0 / power);
        let slope = p.contrast.clamp(0.0, 5.0) * dynamic_range / 8.0;
        let min_contrast = 1.0f32
            .max((white_display - grey_display) / (1.0 - grey_log))
            .max((grey_display - black_display) / grey_log)
            + SAFETY_MARGIN;
        let contrast = (slope / (power * grey_display.powf(power - 1.0))).clamp(min_contrast, 100.0);
        let intercept = grey_display - contrast * grey_log;
        let margin = SAFETY_MARGIN * (white_display - black_display);
        let xmin = (black_display + margin - intercept) / contrast;
        let xmax = (white_display - margin - intercept) / contrast;

        // Toe and shoulder nodes. Deviation from Ansel: it places both from one latitude
        // (linear width) shifted by a balance; here each side is sized independently.
        // Each is the linear share of its side; toe = shoulder = latitude reproduces
        // Ansel with balance 0.
        let toe = p.toe.clamp(0.0, 100.0) / 100.0;
        let shoulder = p.shoulder.clamp(0.0, 100.0) / 100.0;
        let toe_log = grey_log - toe * (grey_log - xmin);
        let shoulder_log = grey_log + shoulder * (xmax - grey_log);
        let toe_display = toe_log * contrast + intercept;
        let shoulder_display = shoulder_log * contrast + intercept;

        let x = [0.0, toe_log, grey_log, shoulder_log, 1.0];
        let y = [black_display, toe_display, grey_display, shoulder_display, white_display];

        // Toe: generalised sigmoid down to black, or a slope-matched power curve when
        // the chord to black is steeper than the latitude slope.
        let (dx, dy) = (x[1].max(1e-6), (y[1] - y[0]).max(1e-6));
        let toe_scale = -sigmoid_scale(1.0, 1.0 - y[0], 1.0 - x[1], 1.0 - y[1], contrast, TOE_POWER);
        let toe_fallback = (dy / dx > contrast).then(|| {
            let q = contrast * dx / dy;
            (dy / dx.powf(q), q)
        });

        // Shoulder: slope-matched power roll-off up to white.
        let (dx, dy) = ((1.0 - x[3]).max(1e-6), (y[4] - y[3]).max(1e-6));
        let q = contrast * dx / dy;
        let shoulder = (dy / dx.powf(q), q);

        Self {
            x,
            y,
            contrast,
            intercept: y[1] - contrast * x[1],
            toe_scale,
            toe_fallback,
            shoulder,
            power,
            black_source,
            dynamic_range,
        }
    }

    /// The S curve: log-encoded input in [0, 1] → display-encoded output.
    pub fn eval(&self, x: f32) -> f32 {
        let (lat_min, lat_max) = (self.x[1], self.x[3]);
        if x < lat_min {
            match self.toe_fallback {
                Some((c, q)) => self.y[0] + (c * x.max(0.0).powf(q)).max(0.0),
                None => {
                    let ty = lat_min * self.contrast + self.intercept;
                    let u = self.contrast * (x - lat_min) / self.toe_scale;
                    self.toe_scale * (u / (1.0 + u.powf(TOE_POWER)).powf(1.0 / TOE_POWER)) + ty
                }
            }
        } else if x > lat_max {
            let (c, q) = self.shoulder;
            self.y[4] - (c * (1.0 - x).max(0.0).powf(q)).max(0.0)
        } else {
            self.intercept + x * self.contrast
        }
    }

    /// Full per-channel transfer: scene-linear → log encoding → curve → display-linear.
    pub fn tone_map(&self, v: f32) -> f32 {
        let log = (((v / GREY_SOURCE).log2() - self.black_source) / self.dynamic_range).clamp(0.0, 1.0);
        let log = if log.is_nan() { 0.0 } else { log };
        self.eval(log).clamp(0.0, self.y[4]).powf(self.power)
    }

    pub fn display_black(&self) -> f32 {
        self.y[0].powf(self.power)
    }

    pub fn display_white(&self) -> f32 {
        self.y[4].powf(self.power)
    }
}

// ── Auto-tune ───────────────────────────────────────────────────────────────

/// Fraction of pixels ignored at each end by [`auto_tune`], so that a few noisy or
/// hot pixels don't decide the range (Ansel takes the plain min/max).
const AUTO_TUNE_TAIL: f64 = 0.0001;

/// Ansel's filmic auto-tune: white relative exposure from the brightest max(R, G, B),
/// black relative exposure from the darkest luminance, both measured on filmic's
/// input (scene-linear Rec.2020) and scaled by `dynamic_range_scaling`.
/// Returns `(white_exposure, black_exposure)`.
pub fn auto_tune(pixels: impl Iterator<Item = Rgb>, dynamic_range_scaling: f32) -> Option<(f32, f32)> {
    let mut max_rgb = Vec::new();
    let mut lum = Vec::new();
    for c in pixels {
        let (m, y) = (c[0].max(c[1]).max(c[2]), c[0] * XYZ_FROM_REC2020[1][0] + c[1] * XYZ_FROM_REC2020[1][1] + c[2] * XYZ_FROM_REC2020[1][2]);
        if m.is_finite() && y.is_finite() {
            max_rgb.push(m);
            lum.push(y);
        }
    }
    if max_rgb.is_empty() {
        return None;
    }
    let tail = ((max_rgb.len() - 1) as f64 * AUTO_TUNE_TAIL) as usize;
    let top = max_rgb.len() - 1 - tail;
    let white = *max_rgb.select_nth_unstable_by(top, f32::total_cmp).1;
    let black = *lum.select_nth_unstable_by(tail, f32::total_cmp).1;

    const NORM_MIN: f32 = 1.52587890625e-05; // 2^-16, as in Ansel
    let scale = 1.0 + dynamic_range_scaling.clamp(-50.0, 200.0) / 100.0;
    let white_ev = (white.max(NORM_MIN) / GREY_SOURCE).log2().clamp(1.0, 16.0) * scale;
    let black_ev = ((black.max(NORM_MIN) / GREY_SOURCE).log2().clamp(-16.0, -1.0) * scale).max(-16.0);
    Some((white_ev.min(16.0), black_ev))
}

// ── AgX bracket ─────────────────────────────────────────────────────────────

/// Fitted constants for each bleach variant (from Ansel's
/// `tools/derive_filmic_agx_primaries.py`): inset strength and hue rotation per
/// primary, and the over-expanding outset.
struct Bracket {
    inset: [f32; 3],
    inset_rotation: [f32; 3],
    outset: [f32; 3],
    outset_rotation: [f32; 3],
}

fn bracket_constants(bleach: Bleach) -> Bracket {
    match bleach {
        Bleach::None => Bracket {
            inset: [0.599_105_5, 0.600_000_0, 0.330_000_9],
            inset_rotation: [0.057_101_5, 0.199_989_1, 0.088_611_0],
            outset: [0.761_433, 0.752_267, 0.465_293],
            outset_rotation: [-0.003_429_7, 0.195_244_8, -0.048_010_9],
        },
        Bleach::Low => Bracket {
            inset: [0.641_082_5, 0.689_811_0, 0.319_452_9],
            inset_rotation: [0.040_573_4, 0.163_128_6, 0.035_058_4],
            outset: [0.784_757, 0.789_387, 0.445_403],
            outset_rotation: [-0.005_784_5, 0.159_320_7, -0.059_295_5],
        },
        Bleach::Medium => Bracket {
            inset: [0.650_954_0, 0.748_877_5, 0.351_770_3],
            inset_rotation: [0.027_860_2, 0.121_467_1, -0.022_882_9],
            outset: [0.793_082, 0.815_169, 0.460_318],
            outset_rotation: [-0.005_378_1, 0.118_760_4, -0.079_480_1],
        },
        Bleach::High => Bracket {
            inset: [0.637_974_9, 0.787_868_9, 0.375_382_2],
            inset_rotation: [0.010_609_6, 0.058_259_8, -0.069_672_9],
            outset: [0.790_237, 0.831_376, 0.465_406],
            outset_rotation: [-0.008_007_0, 0.057_110_0, -0.091_222_0],
        },
        Bleach::Extra => Bracket {
            inset: [0.577_023_5, 0.810_209_4, 0.400_039_0],
            inset_rotation: [-0.008_106_0, -0.003_400_8, -0.103_523_6],
            outset: [0.766_420, 0.838_020, 0.465_130],
            outset_rotation: [-0.012_201_1, -0.002_173_2, -0.097_121_5],
        },
    }
}

/// Working RGB → "displaced" RGB: each primary's chroma is scaled toward white and
/// its hue rotated, in Yrg, then white-normalised so grey stays grey.
fn displaced_primaries(rgb_to_xyz: &Mat3, xyz_to_rgb: &Mat3, inset: [f32; 3], rotation: [f32; 3]) -> Option<Mat3> {
    let to_yrg = |xyz: Rgb| lms_to_yrg(mul_vec(&LMS_FROM_XYZ, xyz));
    let lms_to_xyz = color::invert(&LMS_FROM_XYZ)?;
    let white_xyz: Rgb = std::array::from_fn(|r| rgb_to_xyz[r].iter().sum());
    let white = to_yrg(white_xyz);

    let mut p: Mat3 = [[0.0; 3]; 3];
    for i in 0..3 {
        let primary = to_yrg([rgb_to_xyz[0][i], rgb_to_xyz[1][i], rgb_to_xyz[2][i]]);
        let (dr, dg) = (primary[1] - white[1], primary[2] - white[2]);
        let scale = 1.0 - inset[i].clamp(0.0, 0.9);
        let (sin, cos) = rotation[i].sin_cos();
        let displaced = [
            primary[0],
            white[1] + scale * (cos * dr - sin * dg),
            white[2] + scale * (sin * dr + cos * dg),
        ];
        let xyz = mul_vec(&lms_to_xyz, yrg_to_lms(displaced));
        for r in 0..3 {
            p[r][i] = xyz[r];
        }
    }
    // Scale columns so that the displaced primaries add up to the working white.
    let s = mul_vec(&color::invert(&p)?, white_xyz);
    for row in &mut p {
        for (c, v) in row.iter_mut().enumerate() {
            *v *= s[c];
        }
    }
    Some(mul(xyz_to_rgb, &p))
}

// ── Gamut mapping (filmic v6+) ──────────────────────────────────────────────

/// Chroma at which one display channel (row `coeffs` of LMS → display RGB) reaches `target_white`.
fn clip_chroma_white_raw(coeffs: [f32; 3], target_white: f32, y: f32, cos_h: f32, sin_h: f32) -> f32 {
    let denom_y = coeffs[0] * (0.979_381_44 * cos_h + 0.391_752_58 * sin_h)
        + coeffs[1] * (0.020_618_557 * cos_h + 0.608_247_4 * sin_h)
        - coeffs[2] * (cos_h + sin_h);
    let denom_target = target_white * (0.682_859_8 * cos_h + 0.482_137_06 * sin_h);
    if denom_y == 0.0 {
        return f32::MAX;
    }
    if y <= denom_target / denom_y {
        return f32::MAX;
    }
    let denominator = y * denom_y - denom_target;
    let numerator = -0.427_506_88
        * (y * (coeffs[0] + 0.856_492_35 * coeffs[1] + 0.554_995_96 * coeffs[2]) - 0.988_237_75 * target_white);
    numerator / denominator
}

fn clip_chroma_white(coeffs: [f32; 3], target_white: f32, y: f32, cos_h: f32, sin_h: f32) -> f32 {
    const EPS: f32 = 1e-3;
    let max_y = Y_1931_TO_2006 * target_white;
    let delta_y = (max_y - y).max(0.0);
    let max_chroma = if delta_y < EPS {
        delta_y / (EPS * max_y) * clip_chroma_white_raw(coeffs, target_white, (1.0 - EPS) * max_y, cos_h, sin_h)
    } else {
        clip_chroma_white_raw(coeffs, target_white, y, cos_h, sin_h)
    };
    if max_chroma >= 0.0 { max_chroma } else { f32::MAX }
}

fn clip_chroma_black(coeffs: [f32; 3], cos_h: f32, sin_h: f32) -> f32 {
    let denominator = coeffs[0] * (0.979_381_44 * cos_h + 0.391_752_58 * sin_h)
        + coeffs[1] * (0.020_618_557 * cos_h + 0.608_247_4 * sin_h)
        - coeffs[2] * (cos_h + sin_h);
    if denominator == 0.0 {
        return f32::MAX;
    }
    let numerator = -0.427_506_88 * (coeffs[0] + 0.856_492_35 * coeffs[1] + 0.554_995_96 * coeffs[2]);
    let max_chroma = numerator / denominator;
    if max_chroma >= 0.0 { max_chroma } else { f32::MAX }
}

// ── The module ──────────────────────────────────────────────────────────────

/// Filmic, compiled for one set of parameters. Input: scene-linear Rec.2020;
/// output: display-linear Rec.709/sRGB primaries, in gamut.
pub struct Filmic {
    pub spline: Spline,
    inset: Mat3,
    outset: Mat3,
    /// Working RGB → LMS.
    to_lms: Mat3,
    /// LMS → display RGB, and back.
    lms_to_display: Mat3,
    display_to_lms: Mat3,
    luma: [f32; 3],
    beta_hue: f32,
    display_black: f32,
    display_white: f32,
}

impl Filmic {
    pub fn new(p: &FilmicParams) -> Self {
        let spline = Spline::new(p);
        let xyz_to_2020 = color::invert(&XYZ_FROM_REC2020).expect("invertible");
        let b = bracket_constants(p.bleach);
        let (inset, outset) = displaced_primaries(&XYZ_FROM_REC2020, &xyz_to_2020, b.inset, b.inset_rotation)
            .zip(displaced_primaries(&XYZ_FROM_REC2020, &xyz_to_2020, b.outset, b.outset_rotation).and_then(|m| color::invert(&m)))
            .unwrap_or((color::IDENTITY, color::IDENTITY));
        let lms_to_xyz = color::invert(&LMS_FROM_XYZ).expect("invertible");
        let xyz_to_709 = color::invert(&XYZ_FROM_REC709).expect("invertible");
        Self {
            display_black: spline.display_black(),
            display_white: spline.display_white(),
            spline,
            inset,
            outset,
            to_lms: mul(&LMS_FROM_XYZ, &XYZ_FROM_REC2020),
            lms_to_display: mul(&xyz_to_709, &lms_to_xyz),
            display_to_lms: mul(&LMS_FROM_XYZ, &XYZ_FROM_REC709),
            luma: XYZ_FROM_REC2020[1],
            beta_hue: 0.5 * (p.hue_preservation.clamp(-100.0, 100.0) / 100.0 + 1.0),
        }
    }

    /// Offset negative channels to zero, preserving luminance (Blender AgX's
    /// compensation, generalised to the working-space luminance weights).
    fn compress_negatives(&self, pix: Rgb) -> Rgb {
        let l = self.luma;
        let lum = |p: Rgb| p[0] * l[0] + p[1] * l[1] + p[2] * l[2];
        let max3 = |p: Rgb| p[0].max(p[1]).max(p[2]);
        let min_rgb = pix[0].min(pix[1]).min(pix[2]);
        if min_rgb >= 0.0 {
            return pix; // nothing to compress (the shift is 0 and the ratio 1)
        }
        let input_y = lum(pix);
        let max_rgb = max3(pix);
        let opponent = pix.map(|v| max_rgb - v);
        let y_compensated = max3(opponent) - lum(opponent) + input_y;

        let shifted = pix.map(|v| v + (-min_rgb).max(0.0));
        let max_shifted = max3(shifted);
        let opponent_shifted = shifted.map(|v| max_shifted - v);
        let y_new = lum(shifted) + max3(opponent_shifted) - lum(opponent_shifted);
        let ratio = if y_new > y_compensated && y_new > 1e-6 { y_compensated / y_new } else { 1.0 };
        shifted.map(|v| v * ratio)
    }

    /// Filmic v4+ chroma handling: never let tone mapping boost chroma.
    fn desaturate(original: Ych, mut fin: Ych) -> Ych {
        let chroma_original = original.c * original.y;
        let mut chroma_final = fin.c * fin.y;
        if fin.y > original.y && chroma_original < chroma_final {
            chroma_final = (chroma_original + chroma_final) / 2.0;
        }
        fin.c = if fin.y > 0.0 { (chroma_final / fin.y).max(0.0) } else { 0.0 };
        fin
    }

    fn gamut_check_yrg(mut ych: Ych) -> Ych {
        let r = ych.c * ych.cos_h + WHITE_R;
        let g = ych.c * ych.sin_h + WHITE_G;
        let mut max_c = ych.c;
        if r < 0.0 {
            max_c = max_c.min(-WHITE_R / ych.cos_h);
        }
        if g < 0.0 {
            max_c = max_c.min(-WHITE_G / ych.sin_h);
        }
        if r + g > 1.0 {
            max_c = max_c.min((1.0 - WHITE_R - WHITE_G) / (ych.cos_h + ych.sin_h));
        }
        ych.c = max_c;
        ych
    }

    fn gamut_check_rgb(&self, ych: Ych) -> Rgb {
        let rgb = ych_to_rgb(ych, &self.lms_to_display);
        if rgb.iter().all(|v| (0.0..=self.display_white).contains(v)) {
            // Already in gamut: no white to mix in, chroma below every clip limit.
            return rgb;
        }
        // How much white light would bring negative channels back in gamut?
        let mut brightened = rgb;
        let offset = (-brightened[0].min(brightened[1]).min(brightened[2])).max(0.0);
        brightened = brightened.map(|v| v + offset);
        let y_brightened = rgb_to_ych(brightened, &self.display_to_lms).y;
        let y = ((ych.y + y_brightened) / 2.0)
            .clamp(Y_1931_TO_2006 * self.display_black, Y_1931_TO_2006 * self.display_white);

        let m = &self.lms_to_display;
        let mut chroma = ych.c;
        for row in m {
            chroma = chroma
                .min(clip_chroma_white(*row, self.display_white, y, ych.cos_h, ych.sin_h))
                .min(clip_chroma_black(*row, ych.cos_h, ych.sin_h));
        }
        ych_to_rgb(Ych { y, c: chroma, ..ych }, m).map(|v| v.clamp(0.0, self.display_white))
    }

    /// Scene-linear Rec.2020 → display-linear Rec.709, in gamut.
    pub fn apply(&self, pix: Rgb, curve: impl Fn(f32) -> f32) -> Rgb {
        self.apply_compressed(self.prepare(pix), curve)
    }

    /// Sanitise and remove negative channels: the input of [`Self::apply_compressed`].
    #[inline]
    pub fn prepare(&self, pix: Rgb) -> Rgb {
        self.compress_negatives(pix.map(|v| if v.is_nan() { 0.0 } else { v.clamp(-1e6, 1e6) }))
    }

    /// [`Self::apply`] for inputs without negative channels.
    pub fn apply_compressed(&self, compressed: Rgb, curve: impl Fn(f32) -> f32) -> Rgb {
        // Hue reference, measured after the negatives compression.
        let original = rgb_to_ych(compressed, &self.to_lms);

        let rendering = mul_vec(&self.inset, compressed).map(&curve);
        let out = mul_vec(&self.outset, rendering);
        let mut fin = rgb_to_ych(out, &self.to_lms);

        // Bleaching is allowed, spontaneous chroma boosts are not.
        let chroma_final = original.c.min(fin.c);
        // Recover hue by mixing chroma-weighted hue vectors.
        let b = self.beta_hue;
        let r_mix = b * original.c * original.cos_h + (1.0 - b) * chroma_final * fin.cos_h;
        let g_mix = b * original.c * original.sin_h + (1.0 - b) * chroma_final * fin.sin_h;
        let norm = (r_mix * r_mix + g_mix * g_mix).sqrt();
        let (cos_h, sin_h) = if norm > 1e-9 { (r_mix / norm, g_mix / norm) } else { (original.cos_h, original.sin_h) };
        fin.c = chroma_final;

        // Gamut mapping, with the hue forced to the reference.
        let reference = Ych { cos_h, sin_h, ..original };
        fin.cos_h = cos_h;
        fin.sin_h = sin_h;
        fin.y = fin.y.clamp(Y_1931_TO_2006 * self.display_black, Y_1931_TO_2006 * self.display_white);
        let fin = Self::gamut_check_yrg(Self::desaturate(reference, fin));
        self.gamut_check_rgb(fin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::MIDDLE_GREY;

    fn defaults() -> FilmicParams {
        FilmicParams::default()
    }

    #[test]
    fn spline_is_continuous_and_monotonic() {
        let s = Spline::new(&defaults());
        let mut prev = -1.0;
        for i in 0..=1000 {
            let x = i as f32 / 1000.0;
            let y = s.eval(x);
            assert!(y >= prev - 1e-5, "not monotonic at {x}: {y} < {prev}");
            prev = y;
        }
        for node in [s.x[1], s.x[3]] {
            assert!((s.eval(node - 1e-4) - s.eval(node + 1e-4)).abs() < 1e-3, "discontinuity at {node}");
        }
        assert!((s.eval(0.0) - s.y[0]).abs() < 1e-3);
        assert!((s.eval(1.0) - s.y[4]).abs() < 1e-4);
    }

    #[test]
    fn grey_maps_to_grey_and_white_to_white() {
        let s = Spline::new(&defaults());
        assert!((s.tone_map(MIDDLE_GREY) - MIDDLE_GREY).abs() < 1e-3, "{}", s.tone_map(MIDDLE_GREY));
        let white = MIDDLE_GREY * defaults().white_exposure.exp2();
        assert!((s.tone_map(white) - 1.0).abs() < 1e-3);
        assert!(s.tone_map(1e-9) < 1e-3);
    }

    #[test]
    fn auto_hardness_matches_ansel() {
        let p = FilmicParams { white_exposure: 3.15, black_exposure: -8.85, ..defaults() };
        let s = Spline::new(&p);
        let expected = 0.1845f32.ln() / (8.85f32 / 12.0).ln();
        assert!((s.power - expected).abs() < 1e-4);
    }

    #[test]
    fn neutrals_stay_neutral() {
        let f = Filmic::new(&defaults());
        let s = &f.spline;
        for v in [0.001, 0.05, MIDDLE_GREY, 0.8, 3.0] {
            let [r, g, b] = f.apply([v; 3], |x| s.tone_map(x));
            assert!((r - g).abs() < 2e-3 && (g - b).abs() < 2e-3, "{v}: {r} {g} {b}");
            assert!((r - s.tone_map(v)).abs() < 5e-3, "{v}: {r} vs {}", s.tone_map(v));
        }
    }

    #[test]
    fn output_is_in_gamut_and_bleaches_highlights() {
        let f = Filmic::new(&defaults());
        let s = &f.spline;
        for pix in [[2.0, 0.01, 0.01], [0.0, 0.5, -0.1], [50.0, 40.0, 1.0], [0.05, 0.02, 0.3]] {
            let out = f.apply(pix, |x| s.tone_map(x));
            assert!(out.iter().all(|v| (0.0..=1.0).contains(v) && v.is_finite()), "{pix:?} → {out:?}");
        }
        // A very bright red goes towards white.
        let [r, g, b] = f.apply([400.0, 20.0, 20.0], |x| s.tone_map(x));
        assert!(r > 0.95 && g > 0.5 && b > 0.5, "{r} {g} {b}");
    }

    #[test]
    fn auto_tune_finds_range_and_ignores_outliers() {
        // Middle grey ± a few stops, plus one hot and one dead pixel among 20 000.
        let mut px: Vec<Rgb> = (0..20_000).map(|i| [MIDDLE_GREY * 2f32.powf((i % 9) as f32 - 6.0); 3]).collect();
        px[5] = [1e6; 3];
        px[6] = [0.0; 3];
        let (white, black) = auto_tune(px.iter().copied(), 0.0).unwrap();
        assert!((white - 2.0).abs() < 1e-4, "{white}");
        assert!((black + 6.0).abs() < 1e-3, "{black}");
        // Dynamic range scaling widens both ends; clamps hold.
        let (w, b) = auto_tune(px.iter().copied(), 50.0).unwrap();
        assert!((w - 3.0).abs() < 1e-3 && (b + 9.0).abs() < 1e-3, "{w} {b}");
        // A black image: white clamps to +1 EV, black floors at 2⁻¹⁶ (like Ansel).
        let (w, b) = auto_tune(std::iter::once([0.0; 3]), 0.0).unwrap();
        assert_eq!(w, 1.0);
        assert!((b - (2f32.powi(-16) / GREY_SOURCE).log2()).abs() < 1e-4, "{b}");
    }

    #[test]
    fn bracket_keeps_white() {
        let f = Filmic::new(&defaults());
        for m in [&f.inset, &f.outset] {
            let w = mul_vec(m, [1.0; 3]);
            assert!(w.iter().all(|v| (v - 1.0).abs() < 1e-4), "{w:?}");
        }
    }
}

