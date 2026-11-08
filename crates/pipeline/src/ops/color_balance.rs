//! Colour balance: the master tab of Ansel's `colorbalancergb.c` and its
//! `splittoningrgb.c`, in one module (both GPL-3.0-or-later, © Aurélien Pierre),
//! with the dt UCS 2022 conversions of `common/colorspaces_inline_conversions.h`.
//!
//! Per pixel, in linear Rec.2020:
//! 1. The weights of the shadows, mid-tones and highlights, from the input's luminance
//!    ([`range_weights`], a lookup table). They always add up to 1.
//! 2. Split-toning: each range's matrix (a CAT16 adaptation from its light, then its
//!    channel mix, in RGB) is weighted by the range's weight, and the sum applied.
//! 3. Colour balance's master tab, with the same weights: hue shift, linear chroma
//!    and vibrance in Filmlight Yrg, then perceptual saturation and brilliance in
//!    dt UCS, with its gamut mapping.
//!
//! Deviations from Ansel:
//! * The ranges are two logistic steps along the luminance in EV (`1 − s`, `s·(1 − h)`,
//!   `s·h`), placed by a fulcrum, a mid-tones width and two fall-offs, so that the
//!   weights add up to 1: the same settings in every range act like a global one.
//!   Colour balance's own masks (sigmoids of `Y^0.41` and a bump between them) overlap
//!   and add up past 1 in the middle; split-toning's two keys fade back to no change
//!   beyond them. Here the deepest shadows get the whole shadows setting.
//! * The weights are measured on the module's input, before the mixers (colour balance
//!   alone measures them on its own input, and split-toning on its own).
//! * Only the master tab of colour balance (no 4 ways, no contrast) and only its
//!   darktable UCS saturation formula (no JzAzBz).
//! * The working space has a D65 white: no D50 → D65 adaptation; the Yrg white is the
//!   working space's (Ansel's constants are its D50 white adapted to D65), and the
//!   mixers adapt their light to daylight at 6504 K, so that 6504 K changes nothing
//!   exactly (Ansel adapts to its D50 white, and 5003 K is its neutral setting).
//! * Powers and `atan2` use fast approximations (relative error ~1e-5), and the dt UCS
//!   gamut table is filled from the gamut's edges, each 1° bin from its nearest sample
//!   (Ansel's march can leave bins empty), and read with the same angles it is filled.
//! * A mixer whose normalised rows are degenerate (a row adding up to 0) is identity,
//!   as in split-toning, which then falls back to identity for the whole point.

use std::sync::OnceLock;

use crate::color::{self, MIDDLE_GREY, Mat3, luminance, mul, mul_vec};
use crate::image::Rgb;
use crate::ops::calibration::{CAT16_TO_XYZ, XYZ_TO_CAT16, black_body_xy, daylight_xy};
use crate::ops::lut::{BitsLut, CEILING, FINE, FLOOR, exp2_fast, log2_fast};
use crate::params::{ColorBalance, NEUTRAL_TEMPERATURE, ToneMixer};

/// CIE 2006 LMS (D65) from XYZ (D65), and back (`XYZ_D65_to_LMS_2006_D65`).
const LMS_FROM_XYZ: Mat3 = [[0.257085, 0.859943, -0.031061], [-0.394427, 1.175800, 0.106423], [0.064856, -0.076250, 0.559067]];
const XYZ_FROM_LMS: Mat3 = [[1.80794659, -1.29971660, 0.34785879], [0.61783960, 0.39595453, -0.04104687], [-0.12546960, 0.20478038, 1.74274183]];
/// Filmlight grading RGB from LMS, and back.
const GRADING_FROM_LMS: Mat3 = [[1.0877193, -0.66666667, 0.02061856], [-0.0877193, 1.66666667, -0.05154639], [0.0, 0.0, 1.03092784]];
const LMS_FROM_GRADING: Mat3 = [[0.95, 0.38, 0.0], [0.05, 0.62, 0.03], [0.0, 0.0, 0.97]];
/// Luminance from LMS (`LMS_to_Yrg`).
const Y_FROM_LMS: [f32; 2] = [0.68990272, 0.34832189];

/// ln 9: a logistic `1 / (1 + e^(−x/k))` goes from 10 % to 90 % over `2 k ln 9`.
const LN_9: f32 = 2.197_224_6;

/// The weights of the shadows, mid-tones and highlights for luminance `y` (linear,
/// the module's input). They add up to 1.
pub fn range_weights(p: &ColorBalance, y: f32) -> [f32; 3] {
    let ev = (y.max(FLOOR) / MIDDLE_GREY).log2() - p.fulcrum;
    let half = p.midtones_range.max(0.0) / 2.0;
    let step = |at: f32, falloff: f32| {
        let k = falloff.max(0.01) / (2.0 * LN_9);
        1.0 / (1.0 + (-(ev - at) / k).exp())
    };
    let s = step(-half, p.shadows_falloff);
    let h = step(half, p.highlights_falloff);
    [1.0 - s, s * (1.0 - h), s * h]
}

/// The matrix of one range's mixer, in linear Rec.2020: the adaptation from its light,
/// then its mix. `None` when it changes nothing (or is degenerate, so does nothing).
fn mixer_matrix(m: &ToneMixer) -> Option<Mat3> {
    let row = |v: [f32; 3], normalize: bool| {
        let sum = v[0] + v[1] + v[2];
        match normalize {
            true if sum.abs() < 1e-6 => None,
            true => Some(v.map(|c| c / sum)),
            false => Some(v),
        }
    };
    let mix = [row(m.red, m.normalize_red)?, row(m.green, m.normalize_green)?, row(m.blue, m.normalize_blue)?];
    let t = m.temperature.clamp(1667.0, 25000.0);
    let adapt = (t != NEUTRAL_TEMPERATURE).then(|| {
        let light = |t: f32| {
            let [x, y] = daylight_xy(t).or_else(|| black_body_xy(t)).unwrap_or_else(color::white_xy);
            mul_vec(&XYZ_TO_CAT16, [x / y, 1.0, (1.0 - x - y) / y])
        };
        let (to, from) = (light(NEUTRAL_TEMPERATURE), light(t));
        let scale = [0, 1, 2].map(|c| to[c] / from[c]);
        let diag = [[scale[0], 0.0, 0.0], [0.0, scale[1], 0.0], [0.0, 0.0, scale[2]]];
        let lms = mul(&diag, &mul(&XYZ_TO_CAT16, &color::xyz_from_rec2020()));
        mul(&color::rec2020_from_xyz(), &mul(&CAT16_TO_XYZ, &lms))
    });
    if adapt.is_none() && mix == color::IDENTITY {
        return None;
    }
    Some(mul(&mix, &adapt.unwrap_or(color::IDENTITY)))
}

// The per-pixel code below has no branches (only selects) and no calls, so that loops
// over pixels vectorise.

/// The smallest denominator, so that divisions whose result isn't used stay finite.
const TINY: f32 = 1e-30;

/// `x^e` for `x > 0` (0 otherwise), within ~1e-5.
#[inline(always)]
fn pow(x: f32, e: f32) -> f32 {
    let v = exp2_fast(e * log2_fast(x.max(TINY)));
    if x > TINY { v } else { 0.0 }
}

/// `atan2(y, x)` within ~1e-5 rad.
#[inline(always)]
fn atan2(y: f32, x: f32) -> f32 {
    let (ax, ay) = (x.abs(), y.abs());
    let a = ax.min(ay) / ax.max(ay).max(f32::MIN_POSITIVE);
    let s = a * a;
    let mut r = a * (0.999_977_26 + s * (-0.332_623_47 + s * (0.193_543_46 + s * (-0.116_432_87 + s * (0.052_653_32 - s * 0.011_721_2)))));
    if ay > ax {
        r = std::f32::consts::FRAC_PI_2 - r;
    }
    if x < 0.0 {
        r = std::f32::consts::PI - r;
    }
    if y < 0.0 { -r } else { r }
}

/// Ansel's `soft_clip`: `x` above `soft` is compressed exponentially toward `hard`.
#[inline(always)]
fn soft_clip(x: f32, soft: f32, hard: f32) -> f32 {
    let norm = hard - soft;
    let clipped = soft + (1.0 - exp2_fast(-(x - soft) / norm.max(TINY) * std::f32::consts::LOG2_E)) * norm;
    let above = if norm > 0.0 { clipped } else { soft };
    if x > soft { above } else { x }
}

// --- dt UCS 2022 ---

/// `Y_to_dt_UCS_L_star`.
#[cfg(test)]
fn l_star(y: f32) -> f32 {
    let y_hat = pow(y, 0.631_651_35);
    2.098_883_8 * y_hat / (y_hat + 1.124_267_7)
}

/// `dt_UCS_L_star_to_Y`.
#[cfg(test)]
fn l_star_to_y(l: f32) -> f32 {
    pow(1.124_267_7 * l / (2.098_883_8 - l), 1.583_151_9)
}

/// `xyY_to_dt_UCS_UV`: the colourfulness plane U*′V*′ of a chromaticity.
#[inline(always)]
fn uv_star_prime(x: f32, y: f32) -> [f32; 2] {
    let d = 0.318_707_28 * x + 2.167_436_9 * y + 0.291_320_55;
    let u = (-0.783_941 * x + 0.277_512_98 * y + 0.153_836_58) / d;
    let v = (0.745_273_54 * x - 0.205_375_87 * y - 0.165_478_38) / d;
    let us = 1.396_562_3 * u / (u.abs() + 1.492_173_5);
    let vs = 1.451_395_4 * v / (v.abs() + 1.524_886_4);
    [-1.124_983_9 * us - 0.980_483_7 * vs, 1.863_233_1 * us + 1.971_853_1 * vs]
}

/// The inverse of [`uv_star_prime`] (from `dt_UCS_JCH_to_xyY`), as `[x·d, y·d, d]`.
#[inline(always)]
fn xyd_of_uv_star_prime(u: f32, v: f32) -> [f32; 3] {
    let us = -5.037_522_4 * u - 2.504_856_3 * v;
    let vs = 4.760_029_4 * u + 2.874_013 * v;
    let u = -1.492_173_5 * us / (us.abs() - 1.396_562_3);
    let v = -1.524_886_4 * vs / (vs.abs() - 1.451_395_4);
    let d = 0.940_254_74 * u + 1.0 * v - 0.025_632_597;
    [0.167_171_47 * u + 0.141_299_8 * v - 0.008_015_313, -0.150_959_09 * u - 0.155_185_06 * v - 0.008_433_124, d]
}

/// The inverse of [`uv_star_prime`].
#[cfg(test)]
fn xy_of_uv_star_prime(u: f32, v: f32) -> [f32; 2] {
    let [x, y, d] = xyd_of_uv_star_prime(u, v);
    [x / d, y / d]
}

/// dt UCS's chroma exponents.
const C_L: f32 = 0.652_399_75;
const C_M: f32 = 0.600_755_7;
const C_SCALE: f32 = 15.932_994;
/// Brightness from chroma (`dt_UCS_JCH_to_HSB`).
const B_EXP: f32 = 1.336_542_2;

/// The largest colourfulness of the working gamut at each hue, 1° bins from −180°, as
/// `log₂(M²^C_M)` (what the chroma limit needs). The last entry repeats the first.
fn gamut_table() -> &'static [f32; 361] {
    static TABLE: OnceLock<[f32; 361]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let to_xyz = color::xyz_from_rec2020();
        let corner = |c: usize| color::xy(mul_vec(&to_xyz, std::array::from_fn(|i| if i == c { 1.0 } else { 0.0 })));
        let corners = [corner(0), corner(1), corner(2)];
        let mut best = [(f32::INFINITY, 0.0f32); 360];
        const STEPS: usize = 20_000;
        for edge in 0..3 {
            let (a, b) = (corners[edge], corners[(edge + 1) % 3]);
            for i in 0..STEPS {
                let t = i as f32 / STEPS as f32;
                let [u, v] = uv_star_prime(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
                let h = v.atan2(u).to_degrees();
                let bin = h.round();
                let k = (bin as i32 + 180).rem_euclid(360) as usize;
                let d = (h - bin).abs();
                if d < best[k].0 {
                    best[k] = (d, u * u + v * v);
                }
            }
        }
        std::array::from_fn(|k| C_M * best[k % 360].1.log2())
    })
}

/// Where hue `h` (radians, −π … π) falls in [`gamut_table`], 0 … 360.
#[inline(always)]
fn gamut_position(h: f32) -> f32 {
    (h * (180.0 / std::f32::consts::PI) + 180.0).clamp(0.0, 359.999)
}

/// [`gamut_table`] at position `x` ([`gamut_position`]), interpolated.
#[inline(always)]
fn gamut_at(table: &[f32; 361], x: f32) -> f32 {
    let i = (x as usize).min(359);
    let f = x - i as f32;
    table[i] + f * (table[i + 1] - table[i])
}

/// Most pixels [`Grading::apply_all`] takes at once.
const CHUNK: usize = 64;

/// The master tab, compiled.
struct Grading {
    /// Hue rotation (cos, sin); (1, 0) without one.
    hue: [f32; 2],
    chroma: [f32; 4],
    vibrance: f32,
    saturation: [f32; 4],
    brilliance: [f32; 4],
    lms_from_rgb: Mat3,
    rgb_from_xyz: Mat3,
    xyz_from_rgb: Mat3,
    /// The white's r, g in Yrg.
    white: [f32; 2],
    /// dt UCS lightness of the white fulcrum.
    l_white: f32,
    /// `log₂(C_SCALE / l_white)`: dt UCS chroma is `2^(log_k + C_L·log₂ L* + C_M·log₂ M²)`.
    log_k: f32,
    gamut: &'static [f32; 361],
}

#[inline(always)]
fn weighted(v: &[f32; 4], w: &[f32; 3]) -> f32 {
    v[0] + v[1] * w[0] + v[2] * w[1] + v[3] * w[2]
}

/// `2^(e·l)` where `l = log₂ x`, for `x > 0` (`ok`), 0 otherwise.
#[inline(always)]
fn exp_if(ok: bool, e: f32, l: f32) -> f32 {
    let v = exp2_fast(e * l);
    if ok { v } else { 0.0 }
}

impl Grading {
    fn new(p: &ColorBalance) -> Option<Self> {
        let clamp4 = |v: [f32; 4]| v.map(|x| x.clamp(-1.0, 1.0));
        let (chroma, saturation, brilliance) = (clamp4(p.chroma), clamp4(p.saturation), clamp4(p.brilliance));
        let vibrance = p.vibrance.clamp(-1.0, 1.0);
        let hue_shift = p.hue_shift.clamp(-180.0, 180.0);
        let zero = |v: &[f32; 4]| v.iter().all(|&x| x == 0.0);
        if hue_shift == 0.0 && vibrance == 0.0 && zero(&chroma) && zero(&saturation) && zero(&brilliance) {
            return None;
        }
        let xyz_from_rgb = color::xyz_from_rec2020();
        let lms_from_rgb = mul(&LMS_FROM_XYZ, &xyz_from_rgb);
        let white = yrg(mul_vec(&lms_from_rgb, [1.0; 3]));
        let a = hue_shift.to_radians();
        let l_white = (MIDDLE_GREY * p.white_fulcrum.clamp(-16.0, 16.0).exp2()).powf(0.631_651_35);
        let l_white = 2.098_883_8 * l_white / (l_white + 1.124_267_7);
        Some(Self {
            hue: if hue_shift == 0.0 { [1.0, 0.0] } else { [a.cos(), a.sin()] },
            chroma,
            vibrance,
            saturation,
            brilliance,
            lms_from_rgb,
            rgb_from_xyz: color::rec2020_from_xyz(),
            xyz_from_rgb,
            white: [white[1], white[2]],
            l_white,
            log_k: (C_SCALE / l_white).log2(),
            gamut: gamut_table(),
        })
    }

    /// Whether the linear chroma part does anything.
    fn linear(&self) -> bool {
        self.hue != [1.0, 0.0] || self.vibrance != 0.0 || self.chroma.iter().any(|&c| c != 0.0)
    }

    /// The grading on up to [`CHUNK`] pixels, with their range weights `w`: a few short
    /// loops over the pixels (structure of arrays), each without branches or calls, so
    /// that they vectorise. One pixel through the whole of it is too long a chain of
    /// dependent powers for the CPU to overlap pixels.
    ///
    /// Powers share their logarithms: `C^B_EXP` is `2^(B_EXP·log₂ C)` with `log₂ C`
    /// already at hand, and so on.
    #[inline(always)]
    fn apply_all<const LINEAR: bool>(&self, pixels: &mut [Rgb], w: &[[f32; 3]]) {
        let n = pixels.len().min(CHUNK).min(w.len());
        let (lw, inv_lw, log_k) = (self.l_white, 1.0 / self.l_white, self.log_k);
        // Every slice has length `n`: no bounds checks in the loops.
        let (pixels, w) = (&mut pixels[..n], &w[..n]);
        let mut scratch = [[0.0f32; CHUNK]; 8];
        let [xs, ys, lum, cs, bs, coss, sins, edges] = scratch.each_mut().map(|a| &mut a[..n]);
        // XYZ as chromaticity and luminance (0 for black and nonsense).
        for i in 0..n {
            let rgb = pixels[i].map(|v| v.max(0.0));
            let xyz = if LINEAR { self.chroma_step(rgb, &w[i]) } else { mul_vec(&self.xyz_from_rgb, rgb) };
            let sum = xyz[0] + xyz[1] + xyz[2];
            let inv = 1.0 / sum.max(TINY);
            (xs[i], ys[i]) = (xyz[0] * inv, xyz[1] * inv);
            lum[i] = if sum > 0.0 && xyz[1] > 0.0 { xyz[1] } else { 0.0 };
        }
        // To dt UCS chroma and brightness (`xyY_to_dt_UCS_JCH`, `dt_UCS_JCH_to_HCB`), then
        // saturation and brilliance.
        for i in 0..n {
            let [u, v] = uv_star_prime(xs[i], ys[i]);
            let m2 = u * u + v * v;
            let inv_m = 1.0 / m2.sqrt().max(TINY);
            (coss[i], sins[i]) = if m2 > 0.0 { (u * inv_m, v * inv_m) } else { (1.0, 0.0) };
            let y_hat = exp2_fast(0.631_651_35 * log2_fast(lum[i].max(TINY)));
            let l = 2.098_883_8 * y_hat / (y_hat + 1.124_267_7);
            let log_c = log_k + C_L * log2_fast(l.max(TINY)) + C_M * log2_fast(m2.max(TINY));
            let colourful = m2 > TINY;
            let c = exp_if(colourful, 1.0, log_c);
            let b = l * inv_lw * (exp_if(colourful, B_EXP, log_c) + 1.0);

            let radius = (c * c + b * b).sqrt();
            let inv_radius = 1.0 / radius.max(TINY);
            let (sin_t, cos_t) = (c * inv_radius, b * inv_radius);
            let p = c.max(f32::MIN_POSITIVE);
            let wv = sin_t * c + cos_t * b;
            let a = (1.0 + weighted(&self.saturation, &w[i])).max(0.0);
            let bri = (1.0 + weighted(&self.brilliance, &w[i])).max(0.0);
            let max_a = (p * p + wv * wv).sqrt() / p;
            let a = soft_clip(a, 0.5 * max_a, max_a);
            let p2 = (a - 1.0) * p;
            let w2 = (p * p * (1.0 - a * a) + wv * wv).max(0.0).sqrt() * bri;
            cs[i] = (cos_t * p2 + sin_t * w2).max(0.0);
            bs[i] = (-sin_t * p2 + cos_t * w2).max(0.0);
        }
        // The gamut's edge at each hue: where the hue falls in the table (arithmetic, which
        // vectorises), then the table (gathers, which don't).
        for i in 0..n {
            edges[i] = gamut_position(atan2(sins[i], coss[i]));
        }
        for e in edges.iter_mut() {
            *e = gamut_at(self.gamut, *e);
        }
        // Soft-clip the saturation at the gamut's edge. `xs` and `ys` are free by now: they
        // take log₂ of the chroma and the lightness J; `edges` becomes whether it clipped.
        for i in 0..n {
            let (c, b) = (cs[i], bs[i]);
            let log_c = log2_fast(c.max(TINY));
            let j = b / (exp_if(c > TINY, B_EXP, log_c) + 1.0);
            let log_max = log_k + C_L * log2_fast((j * lw).max(TINY)) + edges[i];
            let max_chroma = exp2_fast(log_max);
            let edge_b = j * (exp2_fast(B_EXP * log_max) + 1.0);
            let edge_s = if edge_b > 0.0 { max_chroma / edge_b.max(TINY) } else { 0.0 };
            let s = if b > 0.0 { c / b.max(TINY) } else { 0.0 };
            let clips = s > 0.8 * edge_s;
            cs[i] = if clips { soft_clip(s, 0.8 * edge_s, edge_s) * b } else { c };
            (xs[i], ys[i], edges[i]) = (log_c, j, if clips { 1.0 } else { 0.0 });
        }
        // Most chunks have no colour near the gamut's edge: then nothing changed.
        if edges.iter().any(|&e| e != 0.0) {
            for i in 0..n {
                let c = cs[i];
                let log_c = log2_fast(c.max(TINY));
                let j = bs[i] / (exp_if(c > TINY, B_EXP, log_c) + 1.0);
                if edges[i] != 0.0 {
                    (xs[i], ys[i]) = (log_c, j);
                }
            }
        }
        // Back to XYZ (`dt_UCS_JCH_to_xyY`), in place of the lightness and chroma.
        for i in 0..n {
            let (c, log_c) = (cs[i], xs[i]);
            let l = ys[i] * lw;
            let m = exp_if(c > TINY, 0.832_285_1, log_c - log_k - C_L * log2_fast(l.max(TINY)));
            // xy = (x, y) / d.
            let [x, y, d] = xyd_of_uv_star_prime(m * coss[i], m * sins[i]);
            let t = 1.124_267_7 * l / (2.098_883_8 - l);
            let big_y = exp_if(t > TINY, 1.583_151_9, log2_fast(t.max(TINY)));
            let k = big_y / y;
            let ok = lum[i] > 0.0 && l > 0.0 && y * d > 0.0;
            (xs[i], ys[i], lum[i]) = if ok { (k * x, big_y, k * (d - x - y)) } else { (0.0, 0.0, 0.0) };
        }
        for i in 0..n {
            pixels[i] = mul_vec(&self.rgb_from_xyz, [xs[i], ys[i], lum[i]]).map(|v| v.max(0.0));
        }
    }

    /// Hue shift, chroma and vibrance in Yrg; returns XYZ.
    #[inline(always)]
    fn chroma_step(&self, rgb: Rgb, w: &[f32; 3]) -> Rgb {
        let lms = mul_vec(&self.lms_from_rgb, rgb);
        let [y, r, g] = yrg(lms);
        let [wr, wg] = self.white;
        let [cos, sin] = self.hue;
        let (r0, g0) = (r - wr, g - wg);
        let (rc, gc) = (cos * r0 - sin * g0, sin * r0 + cos * g0);
        let chroma_in = (rc * rc + gc * gc).sqrt();
        let inv = 1.0 / chroma_in.max(TINY);
        let (cos_h, sin_h) = (rc * inv, gc * inv);
        // 0 without vibrance.
        let vibrance = self.vibrance * (1.0 - pow(chroma_in, self.vibrance.abs()));
        let factor = (1.0 + weighted(&self.chroma, w) + vibrance).max(0.0);
        let mut chroma = chroma_in * factor;
        // Stay inside the rg triangle.
        let limit = |chroma: f32, outside: bool, at: f32| if outside { chroma.min(at) } else { chroma };
        chroma = limit(chroma, chroma * cos_h + wr < 0.0, -wr / cos_h);
        chroma = limit(chroma, chroma * sin_h + wg < 0.0, -wg / sin_h);
        chroma = limit(chroma, chroma * (cos_h + sin_h) + wr + wg > 1.0, (1.0 - wr - wg) / (cos_h + sin_h));
        let (r, g) = (chroma * cos_h + wr, chroma * sin_h + wg);
        let lms = mul_vec(&LMS_FROM_GRADING, [r, g, 1.0 - r - g]);
        let denom = Y_FROM_LMS[0] * lms[0] + Y_FROM_LMS[1] * lms[1];
        let k = if denom == 0.0 { 0.0 } else { y / denom };
        mul_vec(&XYZ_FROM_LMS, lms.map(|v| v * k))
    }
}

/// LMS → Yrg (`LMS_to_Yrg`).
#[inline(always)]
fn yrg(lms: Rgb) -> Rgb {
    let y = Y_FROM_LMS[0] * lms[0] + Y_FROM_LMS[1] * lms[1];
    let a = lms[0] + lms[1] + lms[2];
    let inv = if a == 0.0 { 0.0 } else { 1.0 / a };
    let n = lms.map(|v| v * inv);
    let g = &GRADING_FROM_LMS;
    [y, g[0][0] * n[0] + g[0][1] * n[1] + g[0][2] * n[2], g[1][0] * n[0] + g[1][1] * n[1] + g[1][2] * n[2]]
}

/// One colour balance instance, compiled.
pub struct ColorBalanceStage {
    /// Weights of the ranges, by input luminance.
    weights: BitsLut<[f32; 3]>,
    /// Each range's matrix, if any range mixes.
    mixers: Option<[Mat3; 3]>,
    grading: Option<Grading>,
    linear: bool,
}

impl ColorBalanceStage {
    /// `None` when the instance doesn't change the image.
    pub fn new(p: &ColorBalance) -> Option<Self> {
        let matrices = p.mixers().map(mixer_matrix);
        let mixers = matrices.iter().any(Option::is_some).then(|| matrices.map(|m| m.unwrap_or(color::IDENTITY)));
        let grading = Grading::new(p);
        if mixers.is_none() && grading.is_none() {
            return None;
        }
        let linear = grading.as_ref().is_some_and(Grading::linear);
        let weights = BitsLut::new(FLOOR, CEILING, FINE, |y| range_weights(p, y));
        Some(Self { weights, mixers, grading, linear })
    }

    #[inline]
    pub fn apply(&self, c: Rgb) -> Rgb {
        let w = self.weights.eval(luminance(c));
        let c = match &self.mixers {
            Some(m) => mul_vec(&blend(m, &w), c),
            None => c,
        };
        let mut c = [c];
        match &self.grading {
            Some(g) if self.linear => g.apply_all::<true>(&mut c, &[w]),
            Some(g) => g.apply_all::<false>(&mut c, &[w]),
            None => {}
        }
        c[0]
    }

    /// [`apply`](Self::apply) to many pixels: one loop per part, each over
    /// independent pixels, with the settings matched outside the loops.
    #[inline]
    pub fn apply_all(&self, pixels: &mut [Rgb]) {
        let mut weights = [[0.0f32; 3]; CHUNK];
        for pixels in pixels.chunks_mut(CHUNK) {
            let w = &mut weights[..pixels.len()];
            w.iter_mut().zip(pixels.iter()).for_each(|(w, c)| *w = self.weights.eval(luminance(*c)));
            if let Some(m) = &self.mixers {
                pixels.iter_mut().zip(w.iter()).for_each(|(c, w)| *c = mul_vec(&blend(m, w), *c));
            }
            match &self.grading {
                Some(g) if self.linear => g.apply_all::<true>(pixels, w),
                Some(g) => g.apply_all::<false>(pixels, w),
                None => {}
            }
        }
    }
}

/// `w₀·m₀ + w₁·m₁ + w₂·m₂`.
#[inline(always)]
fn blend(m: &[Mat3; 3], w: &[f32; 3]) -> Mat3 {
    std::array::from_fn(|i| std::array::from_fn(|j| w[0] * m[0][i][j] + w[1] * m[1][i][j] + w[2] * m[2][i][j]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(f: impl FnOnce(&mut ColorBalance)) -> ColorBalanceStage {
        let mut p = ColorBalance::default();
        f(&mut p);
        ColorBalanceStage::new(&p).expect("not identity")
    }

    fn approx(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol * y.abs().max(1e-3))
    }

    fn grey(c: Rgb, tol: f32) -> bool {
        approx(c, [c[1]; 3], tol)
    }

    #[test]
    fn defaults_do_nothing() {
        assert!(ColorBalanceStage::new(&ColorBalance::default()).is_none());
    }

    #[test]
    fn weights_add_up_to_one_and_follow_the_settings() {
        let p = ColorBalance::default();
        for ev in [-12.0f32, -4.0, -2.0, -0.5, 0.0, 1.0, 2.0, 3.0, 8.0] {
            let w = range_weights(&p, MIDDLE_GREY * ev.exp2());
            assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-6 && w.iter().all(|&x| (0.0..=1.0).contains(&x)), "{ev}: {w:?}");
        }
        let at = |ev: f32| range_weights(&p, MIDDLE_GREY * ev.exp2());
        assert!(at(-10.0)[0] > 0.999 && at(0.0)[1] > 0.95 && at(10.0)[2] > 0.999);
        // Half-way at the edges of the mid-tones (±2 EV by default).
        assert!((at(-2.0)[0] - 0.5).abs() < 0.01 && (at(2.0)[2] - 0.5).abs() < 0.01, "{:?} {:?}", at(-2.0), at(2.0));
        // The fall-off is the 90 % → 10 % width.
        assert!((at(-3.0)[0] - 0.9).abs() < 1e-3 && (at(-1.0)[0] - 0.1).abs() < 0.01, "{:?} {:?}", at(-3.0), at(-1.0));
        // The fulcrum moves everything.
        let moved = ColorBalance { fulcrum: 1.0, ..ColorBalance::default() };
        assert_eq!(range_weights(&moved, MIDDLE_GREY * 2.0), at(0.0));
        // Black is shadows.
        assert!(range_weights(&p, 0.0)[0] > 0.999 && range_weights(&p, -1.0)[0] > 0.999);
    }

    #[test]
    fn same_mix_everywhere_is_one_mix() {
        let mix = ToneMixer { red: [0.8, 0.3, -0.1], normalize_red: false, ..ToneMixer::default() };
        let s = stage(|p| (p.shadows, p.midtones, p.highlights) = (mix.clone(), mix.clone(), mix.clone()));
        for v in [0.001f32, 0.05, 0.18, 0.7, 4.0] {
            let px = [v * 1.2, v, v * 0.6];
            let want = [0.8 * px[0] + 0.3 * px[1] - 0.1 * px[2], px[1], px[2]];
            assert!(approx(s.apply(px), want, 1e-5), "{v}: {:?} vs {want:?}", s.apply(px));
        }
    }

    #[test]
    fn neutral_temperature_is_identity_and_warm_light_is_cooled() {
        let neutral = ColorBalance { shadows: ToneMixer { temperature: NEUTRAL_TEMPERATURE, ..Default::default() }, ..Default::default() };
        assert!(ColorBalanceStage::new(&neutral).is_none());
        let s = stage(|p| p.highlights.temperature = 3200.0);
        // Correcting for a warm light in the highlights makes bright greys bluer, and
        // leaves the deep shadows alone.
        let bright = s.apply([2.0; 3]);
        assert!(bright[2] > bright[0], "{bright:?}");
        assert!(approx(s.apply([0.0005; 3]), [0.0005; 3], 1e-3), "{:?}", s.apply([0.0005; 3]));
        // A grey lit by the highlights' light becomes neutral.
        let [x, y] = black_body_xy(3200.0).unwrap();
        let lit = mul_vec(&color::rec2020_from_xyz(), [x / y * 20.0, 20.0, (1.0 - x - y) / y * 20.0]);
        assert!(grey(s.apply(lit), 5e-3), "{:?}", s.apply(lit));
    }

    #[test]
    fn degenerate_mixes_do_nothing() {
        let zero_sum = ToneMixer { red: [1.0, -1.0, 0.0], ..ToneMixer::default() };
        assert!(ColorBalanceStage::new(&ColorBalance { midtones: zero_sum, ..Default::default() }).is_none());
    }

    #[test]
    fn neutral_grading_keeps_colours_inside_the_gamut() {
        // Hue shift by a full turn: only the conversions and the gamut mapping act.
        let s = stage(|p| p.hue_shift = 180.0);
        let turned = stage(|p| p.hue_shift = -180.0);
        for px in [[0.18f32; 3], [0.3, 0.2, 0.1], [0.05, 0.08, 0.1], [1.5, 1.2, 1.0]] {
            let a = s.apply(px);
            let b = turned.apply(px);
            assert!(approx(a, b, 1e-4), "{px:?}: {a:?} vs {b:?}");
        }
        assert!(grey(s.apply([0.18; 3]), 1e-4) && (s.apply([0.18; 3])[1] / 0.18 - 1.0).abs() < 1e-3, "{:?}", s.apply([0.18; 3]));
        // Saturation 0 and brilliance 0, but vibrance: greys stay grey.
        let v = stage(|p| p.vibrance = 0.5);
        assert!(grey(v.apply([0.5; 3]), 1e-4), "{:?}", v.apply([0.5; 3]));
        // Within the gamut, a muted colour comes back as it was (up to the fast maths).
        let id = stage(|p| p.saturation = [0.0, 0.0, 0.0, 1e-9]);
        for px in [[0.3f32, 0.2, 0.1], [0.05, 0.08, 0.1], [2.0, 1.8, 1.9]] {
            assert!(approx(id.apply(px), px, 2e-4), "{px:?}: {:?}", id.apply(px));
        }
    }

    #[test]
    fn chroma_minus_one_is_grey_and_chroma_adds_colour() {
        let s = stage(|p| p.chroma[0] = -1.0);
        let px = [0.4, 0.2, 0.1];
        let out = s.apply(px);
        assert!(grey(out, 1e-3), "{out:?}");
        let spread = |c: Rgb| (c[0] - c[2]) / luminance(c);
        let more = stage(|p| p.chroma[0] = 0.5).apply(px);
        assert!(spread(more) > spread(px), "{more:?}");
        // In the highlights only: shadows are left alone.
        let high = stage(|p| p.chroma[3] = 1.0);
        let dark = [0.004, 0.002, 0.001];
        assert!(approx(high.apply(dark), dark, 2e-3), "{:?}", high.apply(dark));
        assert!(spread(high.apply(px.map(|v| v * 20.0))) > spread(px));
    }

    #[test]
    fn saturation_and_brilliance() {
        let px = [0.3, 0.15, 0.08];
        let spread = |c: Rgb| (c[0] - c[2]) / luminance(c);
        let sat = stage(|p| p.saturation[0] = 0.5).apply(px);
        let desat = stage(|p| p.saturation[0] = -0.5).apply(px);
        assert!(spread(sat) > spread(px) && spread(desat) < spread(px), "{sat:?} {desat:?}");
        let bright = stage(|p| p.brilliance[0] = 0.5).apply(px);
        let dim = stage(|p| p.brilliance[0] = -0.5).apply(px);
        assert!(luminance(bright) > luminance(px) && luminance(dim) < luminance(px), "{bright:?} {dim:?}");
        // Brilliance on a grey only changes its brightness.
        let g = stage(|p| p.brilliance[2] = 1.0).apply([0.18; 3]);
        assert!(grey(g, 1e-3) && g[1] > 0.25, "{g:?}");
    }

    #[test]
    fn hue_shift_turns_hues() {
        let px = [0.4, 0.1, 0.1];
        let (a, b) = (stage(|p| p.hue_shift = 60.0).apply(px), stage(|p| p.hue_shift = -60.0).apply(px));
        // Red turns one way toward yellow, the other toward magenta, at about the same luminance.
        assert!((a[1] > a[2]) != (b[1] > b[2]), "{a:?} {b:?}");
        for c in [a, b] {
            assert!((luminance(c) / luminance(px) - 1.0).abs() < 0.15, "{c:?}");
        }
    }

    #[test]
    fn fast_maths_are_close() {
        for (y, x) in [(0.3f32, 0.4f32), (-1.0, 0.1), (2.0, -3.0), (-0.5, -0.5), (0.0, 1.0), (1.0, 0.0)] {
            assert!((atan2(y, x) - y.atan2(x)).abs() < 2e-5, "{y} {x}");
        }
        for (x, e) in [(0.18f32, 0.65f32), (3.0, 1.33), (1e-4, 0.6), (0.9, 0.83)] {
            assert!((pow(x, e) / x.powf(e) - 1.0).abs() < 3e-5, "{x} {e}");
        }
        // The UCS chromaticity plane round-trips.
        for (x, y) in [(0.3127f32, 0.329f32), (0.6, 0.3), (0.2, 0.6), (0.15, 0.08)] {
            let [u, v] = uv_star_prime(x, y);
            let back = xy_of_uv_star_prime(u, v);
            assert!((back[0] - x).abs() < 1e-4 && (back[1] - y).abs() < 1e-4, "{x} {y}: {back:?}");
        }
        assert!((l_star_to_y(l_star(0.37)) - 0.37).abs() < 1e-4);
    }

    #[test]
    fn gamut_table_is_filled() {
        let t = gamut_table();
        // log₂ of a colourfulness: finite (no empty bin) and smooth around the hue circle.
        assert!(t.iter().all(|m| m.is_finite()), "{t:?}");
        assert!(t.windows(2).all(|w| (w[0] - w[1]).abs() < 0.2) && t[0] == t[360], "{t:?}");
    }
}
