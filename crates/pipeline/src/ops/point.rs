//! Per-pixel operations, fused into a single pass.
//!
//! Everything after the spatial stages is a function of the pixel alone, so it is
//! compiled once per render into a [`PointOps`] (gains folded together, curves baked
//! into lookup tables) and applied in one loop that also encodes to 8-bit sRGB.
//! This is the part that re-runs on every slider move, so it has to be cheap.
//!
//! Order: exposure → warmth/tint → saturation/vibrance → shadows/highlights (all in
//! linear Rec.2020) → filmic (to display-linear sRGB primaries) → sRGB encoding.

use crate::color::{LUMA_REC2020, MIDDLE_GREY, Mat3, REC709_FROM_REC2020, luminance, mul_vec, srgb_oetf};
use crate::image::{Image, Rgb, Rgba8};
use crate::ops::filmic::Filmic;
use crate::ops::lut::{BitsLut, CEILING, FINE, FLOOR, Lut3d};
use std::rc::Rc;
use crate::params::EditParams;

/// Shadows/highlights gain as a function of luminance: smooth bells centred in the
/// shadows (-3 EV from middle grey) and highlights (+2 EV).
fn shadows_highlights_gain(y: f32, shadows: f32, highlights: f32) -> f32 {
    let ev = (y / MIDDLE_GREY).log2();
    let bell = |centre: f32, width: f32| (-(ev - centre).powi(2) / (2.0 * width * width)).exp();
    (shadows * 1.5 * bell(-3.0, 1.5) + highlights * 1.5 * bell(2.0, 1.5)).exp2()
}

/// Grid size of filmic's 3D lookup table. 65³ keeps 99.9 % of pixels within 1–2
/// levels (8-bit) of the exact computation; smaller grids show visible errors.
pub const FILMIC_LUT_SIZE: usize = 65;

/// Filmic, with its per-channel curve as a 1D table and (optionally) the whole
/// colour transform baked into a 3D table over log-encoded RGB.
pub struct FilmicStage {
    filmic: Filmic,
    curve: BitsLut<f32>,
    lut: Option<Lut3d>,
    lut_max: f32,
}

impl FilmicStage {
    pub fn new(p: &crate::params::Filmic, lut_size: Option<usize>) -> Self {
        let filmic = Filmic::new(p);
        let curve = BitsLut::new(FLOOR, CEILING, FINE, |v| filmic.spline.tone_map(v));
        // From 2 EV below the black point (displayed as black anyway) to 4 EV above
        // the white point; brighter pixels take the exact path.
        let grey = MIDDLE_GREY.log2();
        let lut = lut_size.map(|n| {
            // Stored sRGB-encoded: interpolation error is then perceptually uniform.
            Lut3d::new(n, grey + p.black_exposure - 2.0, grey + p.white_exposure + 4.0, |c| {
                filmic.apply_compressed(c, |v| curve.eval(v)).map(srgb_oetf)
            })
        });
        let lut_max = lut.as_ref().map_or(0.0, Lut3d::max_input);
        Self { filmic, curve, lut, lut_max }
    }

    pub fn has_lut(&self) -> bool {
        self.lut.is_some()
    }

    /// Display-linear output.
    fn apply(&self, px: Rgb) -> Rgb {
        self.filmic.apply_compressed(self.filmic.prepare(px), |v| self.curve.eval(v))
    }

    /// 8-bit sRGB output, through the 3D table when possible.
    #[inline]
    fn apply_u8(&self, px: Rgb, encode: &BitsLut<u8>) -> [u8; 3] {
        let c = self.filmic.prepare(px);
        match &self.lut {
            Some(lut) if c[0].max(c[1]).max(c[2]) <= self.lut_max => lut.eval(c).map(|v| (v * 255.0 + 0.5) as u8),
            _ => self.filmic.apply_compressed(c, |v| self.curve.eval(v)).map(|v| encode.eval(v)),
        }
    }
}

pub struct PointOps {
    black: f32,
    /// Exposure × white balance gains, per channel.
    gain: Rgb,
    saturation: f32,
    vibrance: f32,
    /// Gain indexed by luminance.
    shadows_highlights: Option<BitsLut<f32>>,
    filmic: Option<Rc<FilmicStage>>,
    /// Used when filmic is off: clip in Rec.709.
    to_rec709: Mat3,
    /// Display-linear → 8-bit sRGB.
    encode: BitsLut<u8>,
}

impl PointOps {
    /// Point operations with exact filmic.
    pub fn new(p: &EditParams) -> Self {
        Self::with_filmic_lut(p, None)
    }

    /// `lut_size: None` evaluates filmic exactly for every pixel.
    pub fn with_filmic_lut(p: &EditParams, lut_size: Option<usize>) -> Self {
        let filmic = p.filmic.enabled.then(|| Rc::new(FilmicStage::new(&p.filmic, lut_size)));
        Self::with_filmic(p, filmic)
    }

    /// Use a prepared (typically cached) filmic stage; `None` disables filmic.
    pub fn with_filmic(p: &EditParams, filmic: Option<Rc<FilmicStage>>) -> Self {
        let ev_gain = p.exposure.ev.exp2();
        let warmth = p.white_balance.warmth.clamp(-1.0, 1.0) * 0.5;
        let tint = p.white_balance.tint.clamp(-1.0, 1.0) * 0.35;
        let wb = [warmth.exp2(), (-tint).exp2(), (-warmth).exp2()];
        // Normalise so that warmth/tint preserve luminance.
        let wb_y = luminance(wb);

        let sh = &p.shadows_highlights;
        let (shadows, highlights) = (sh.shadows.clamp(-1.0, 1.0), sh.highlights.clamp(-1.0, 1.0));
        let shadows_highlights = (shadows != 0.0 || highlights != 0.0)
            .then(|| BitsLut::new(FLOOR, CEILING, FINE + 1, |y| shadows_highlights_gain(y, shadows, highlights)));

        Self {
            black: p.exposure.black,
            gain: wb.map(|g| g / wb_y * ev_gain),
            saturation: 1.0 + p.color.saturation.clamp(-1.0, 1.0),
            vibrance: p.color.vibrance.clamp(-1.0, 1.0),
            shadows_highlights,
            filmic,
            to_rec709: REC709_FROM_REC2020,
            encode: BitsLut::new(FLOOR, 1.0, FINE, |v| (srgb_oetf(v) * 255.0 + 0.5) as u8),
        }
    }

    /// Scene-referred adjustments, in the working space (linear Rec.2020).
    #[inline]
    pub fn adjust(&self, px: Rgb) -> Rgb {
        let mut c = [
            (px[0] - self.black) * self.gain[0],
            (px[1] - self.black) * self.gain[1],
            (px[2] - self.black) * self.gain[2],
        ];

        if self.saturation != 1.0 || self.vibrance != 0.0 {
            let y = luminance(c);
            let mut k = self.saturation;
            if self.vibrance != 0.0 {
                let max = c[0].max(c[1]).max(c[2]);
                let min = c[0].min(c[1]).min(c[2]);
                // Relative chroma in [0, 1]: vibrance acts most on muted colours.
                let chroma = if max > 1e-6 { ((max - min) / max).clamp(0.0, 1.0) } else { 0.0 };
                k = (k * (1.0 + self.vibrance * (1.0 - chroma))).max(0.0);
            }
            c = c.map(|v| y + (v - y) * k);
        }

        if let Some(lut) = &self.shadows_highlights {
            let gain = lut.eval(c[0] * LUMA_REC2020[0] + c[1] * LUMA_REC2020[1] + c[2] * LUMA_REC2020[2]);
            c = c.map(|v| v * gain);
        }
        c
    }

    /// One pixel: scene-linear Rec.2020 → display-linear sRGB primaries.
    #[inline]
    pub fn display(&self, px: Rgb) -> Rgb {
        let c = self.adjust(px);
        match &self.filmic {
            Some(f) => f.apply(c),
            None => mul_vec(&self.to_rec709, c).map(|v| v.clamp(0.0, 1.0)),
        }
    }

    /// One pixel, all the way to 8-bit sRGB.
    #[inline]
    pub fn apply(&self, px: Rgb) -> [u8; 3] {
        match &self.filmic {
            Some(f) => f.apply_u8(self.adjust(px), &self.encode),
            None => self.display(px).map(|v| self.encode.eval(v)),
        }
    }

    /// Apply to a whole image and encode as 8-bit sRGB.
    pub fn render(&self, img: &Image) -> Rgba8 {
        let mut data = vec![255u8; img.pixels.len() * 4];
        for (px, out) in img.pixels.iter().zip(data.chunks_exact_mut(4)) {
            out[..3].copy_from_slice(&self.apply(*px));
        }
        Rgba8 { width: img.width, height: img.height, data }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::REC2020_FROM_REC709;

    fn ops(f: impl FnOnce(&mut EditParams)) -> PointOps {
        let mut p = EditParams::default();
        p.exposure.ev = 0.0;
        p.filmic.enabled = false;
        f(&mut p);
        PointOps::new(&p)
    }

    fn approx(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
    }

    #[test]
    fn exposure_doubles() {
        assert!(approx(ops(|p| p.exposure.ev = 1.0).adjust([0.1, 0.2, 0.3]), [0.2, 0.4, 0.6], 1e-6));
    }

    #[test]
    fn desaturate_gives_grey() {
        let [r, g, b] = ops(|p| p.color.saturation = -1.0).adjust([0.5, 0.2, 0.1]);
        assert!((r - g).abs() < 1e-6 && (g - b).abs() < 1e-6);
    }

    #[test]
    fn white_balance_keeps_luminance() {
        let out = ops(|p| {
            p.white_balance.warmth = 0.8;
            p.white_balance.tint = -0.3;
        })
        .adjust([0.18; 3]);
        assert!((luminance(out) - 0.18).abs() < 1e-5);
        assert!(out[0] > out[2]);
    }

    #[test]
    fn shadows_lift_darks_more_than_brights() {
        let o = ops(|p| p.shadows_highlights.shadows = 1.0);
        let dark = o.adjust([0.02; 3])[0] / 0.02;
        let bright = o.adjust([1.0; 3])[0];
        assert!(dark > 1.5 && (bright - 1.0).abs() < 0.05, "{dark} {bright}");
    }

    #[test]
    fn filmic_lut_matches_exact_curve() {
        let mut p = EditParams::default();
        p.exposure.ev = 0.0;
        let o = PointOps::new(&p);
        let exact = Filmic::new(&p.filmic);
        for v in [1e-4f32, 0.01, MIDDLE_GREY, 0.5, 1.0, 4.0, 100.0] {
            let got = o.display(mul_vec(&REC2020_FROM_REC709, [v; 3]));
            let want = exact.apply(mul_vec(&REC2020_FROM_REC709, [v; 3]), |x| exact.spline.tone_map(x));
            assert!(approx(got, want, 3e-3), "{v}: {got:?} vs {want:?}");
        }
    }

    #[test]
    fn render_encodes_srgb() {
        let img = Image { width: 2, height: 1, pixels: vec![[0.0; 3], [1.0; 3]] };
        let out = ops(|_| {}).render(&img);
        assert_eq!(out.data, [0, 0, 0, 255, 255, 255, 255, 255]);
    }
}
