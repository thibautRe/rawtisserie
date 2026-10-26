//! Per-pixel operations, fused into a single pass.
//!
//! Everything after the spatial stages is a function of the pixel alone, so it is
//! compiled once per render into a [`PointOps`] (gains folded together, curves baked
//! into lookup tables) and applied in one loop that also encodes to 8-bit sRGB.
//! This is the part that re-runs on every slider move, so it has to be cheap.
//!
//! Order: exposure → warmth/tint → saturation/vibrance → shadows/highlights (all in
//! linear Rec.2020) → Rec.709 primaries → per-channel sigmoid tone mapping → sRGB.

use crate::color::{LUMA_REC2020, MIDDLE_GREY, Mat3, REC709_FROM_REC2020, luminance, mul_vec, srgb_oetf};
use crate::image::{Image, Rgb, Rgba8};
use crate::params::EditParams;

/// A lookup table indexed by the top bits of an `f32`: sign-less exponent plus the
/// leading mantissa bits. That is (piecewise linearly) log-spaced, with
/// `2^(23 - shift)` buckets per stop, and costs no float math to index.
struct BitsLut<T> {
    shift: u32,
    min: f32,
    min_key: u32,
    table: Vec<T>,
}

impl<T: Copy> BitsLut<T> {
    fn new(min: f32, max: f32, shift: u32, f: impl Fn(f32) -> T) -> Self {
        let (min_key, max_key) = (min.to_bits() >> shift, max.to_bits() >> shift);
        let half_bucket = 1u32 << (shift - 1);
        Self {
            shift,
            min,
            min_key,
            // Sample each bucket at its midpoint.
            table: (min_key..=max_key).map(|k| f(f32::from_bits((k << shift) | half_bucket))).collect(),
        }
    }

    #[inline]
    fn eval(&self, x: f32) -> T {
        // `max` also maps negatives and NaN to the first bucket.
        let key = (x.max(self.min).to_bits() >> self.shift) - self.min_key;
        self.table[(key as usize).min(self.table.len() - 1)]
    }
}

/// 256 buckets per stop.
const FINE: u32 = 15;
/// Darkest value the curves distinguish from black (2⁻²⁴).
const FLOOR: f32 = 5.960_464_5e-8;
/// Brightest value the curves distinguish (2¹⁶ — way past any highlight).
const CEILING: f32 = 65536.0;

/// Shadows/highlights gain as a function of luminance: smooth bells centred in the
/// shadows (-3 EV from middle grey) and highlights (+2 EV).
fn shadows_highlights_gain(y: f32, shadows: f32, highlights: f32) -> f32 {
    let ev = (y / MIDDLE_GREY).log2();
    let bell = |centre: f32, width: f32| (-(ev - centre).powi(2) / (2.0 * width * width)).exp();
    (shadows * 1.5 * bell(-3.0, 1.5) + highlights * 1.5 * bell(2.0, 1.5)).exp2()
}

/// Sigmoid `xᶜ / (xᶜ + kᶜ)`, anchored so that middle grey maps to itself.
/// Asymptotically approaches 1 (display white).
pub fn sigmoid(x: f32, contrast: f32) -> f32 {
    let kc = MIDDLE_GREY.powf(contrast) * (1.0 / MIDDLE_GREY - 1.0);
    let xc = x.max(0.0).powf(contrast);
    xc / (xc + kc)
}

pub struct PointOps {
    black: f32,
    /// Exposure × white balance gains, per channel.
    gain: Rgb,
    saturation: f32,
    vibrance: f32,
    /// Gain indexed by luminance.
    shadows_highlights: Option<BitsLut<f32>>,
    to_rec709: Mat3,
    /// Tone curve (or clip) followed by the sRGB transfer function, to 8 bits.
    display: BitsLut<u8>,
}

impl PointOps {
    pub fn new(p: &EditParams) -> Self {
        let ev_gain = p.exposure.ev.exp2();
        let warmth = p.white_balance.warmth.clamp(-1.0, 1.0) * 0.5;
        let tint = p.white_balance.tint.clamp(-1.0, 1.0) * 0.35;
        let wb = [warmth.exp2(), (-tint).exp2(), (-warmth).exp2()];
        // Normalise so that warmth/tint preserve luminance.
        let wb_y = luminance(wb);

        let t = &p.tone_map;
        let (shadows, highlights) = (t.shadows.clamp(-1.0, 1.0), t.highlights.clamp(-1.0, 1.0));
        let shadows_highlights = (shadows != 0.0 || highlights != 0.0)
            .then(|| BitsLut::new(FLOOR, CEILING, FINE + 1, |y| shadows_highlights_gain(y, shadows, highlights)));
        let (enabled, contrast) = (t.enabled, t.contrast.clamp(0.5, 4.0));
        let display = BitsLut::new(FLOOR, CEILING, FINE, |v| {
            let toned = if enabled { sigmoid(v, contrast) } else { v.min(1.0) };
            (srgb_oetf(toned) * 255.0 + 0.5) as u8
        });

        Self {
            black: p.exposure.black,
            gain: wb.map(|g| g / wb_y * ev_gain),
            saturation: 1.0 + p.color.saturation.clamp(-1.0, 1.0),
            vibrance: p.color.vibrance.clamp(-1.0, 1.0),
            shadows_highlights,
            to_rec709: REC709_FROM_REC2020,
            display,
        }
    }

    /// Scene-referred adjustments, in the working space (linear Rec.2020).
    #[inline]
    fn adjust(&self, px: Rgb) -> Rgb {
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

    /// One pixel, all the way to 8-bit sRGB. The tone curve is applied per channel
    /// on display (Rec.709) primaries, merged with the sRGB encoding into one table.
    #[inline]
    pub fn apply(&self, px: Rgb) -> [u8; 3] {
        mul_vec(&self.to_rec709, self.adjust(px)).map(|v| self.display.eval(v))
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
        p.tone_map.enabled = false;
        f(&mut p);
        PointOps::new(&p)
    }

    fn approx(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
    }

    #[test]
    fn bits_lut_is_log_spaced_and_safe() {
        let lut = BitsLut::new(FLOOR, CEILING, FINE, |x| x);
        assert_eq!(lut.table.len(), 40 * 256 + 1);
        for x in [1e-6f32, 0.001, 0.18, 1.0, 3.3, 1000.0] {
            assert!((lut.eval(x) / x - 1.0).abs() < 0.003, "{x}");
        }
        assert_eq!(lut.eval(-1.0), lut.table[0]);
        assert_eq!(lut.eval(f32::NAN), lut.table[0]);
        assert_eq!(lut.eval(1e30), *lut.table.last().unwrap());
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
        let o = ops(|p| p.tone_map.shadows = 1.0);
        let dark = o.adjust([0.02; 3])[0] / 0.02;
        let bright = o.adjust([1.0; 3])[0];
        assert!(dark > 1.5 && (bright - 1.0).abs() < 0.05, "{dark} {bright}");
    }

    #[test]
    fn display_matches_exact_formula() {
        for contrast in [0.7, 1.5, 3.0] {
            let o = ops(|p| {
                p.tone_map.enabled = true;
                p.tone_map.contrast = contrast;
            });
            for x in [0.0f32, 1e-4, 0.01, MIDDLE_GREY, 0.5, 1.0, 4.0, 100.0] {
                let exact = (srgb_oetf(sigmoid(x, contrast)) * 255.0).round() as i32;
                let got = o.apply(mul_vec(&REC2020_FROM_REC709, [x; 3]))[0] as i32;
                assert!((got - exact).abs() <= 1, "contrast {contrast}, x {x}: {got} vs {exact}");
            }
        }
        assert!((sigmoid(MIDDLE_GREY, 2.0) - MIDDLE_GREY).abs() < 1e-6);
    }

    #[test]
    fn render_encodes_srgb() {
        let img = Image { width: 2, height: 1, pixels: vec![[0.0; 3], [1.0; 3]] };
        let out = ops(|_| {}).render(&img);
        assert_eq!(out.data, [0, 0, 0, 255, 255, 255, 255, 255]);
    }
}
