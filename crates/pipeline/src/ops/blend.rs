//! Blend modes (roadmap 4.11): how a masked instance's output `b` combines with its
//! input `a`. The mode gives a result `r` from both; the mask `m` (opacity included)
//! then mixes it in: `a + (r − a)·m`. The normal mode's `r` is `b`.
//!
//! Instances blend in the space they work in:
//!
//! * **Scene-referred** (the modules before filmic): linear Rec.2020, unbounded. The
//!   arithmetic modes follow Ansel's `blendif_rgb_jzczhz.c`, except for the fulcrum.
//!   There it's a gain on `b`; here it's the value the mode leaves unchanged (middle grey
//!   at 0 EV): multiply is `a·b/f`, divide `a·f/b`. Screen, overlay, soft and hard light,
//!   which Ansel doesn't have scene-referred, use the display formulas on `x / (x + f)`.
//!   That maps 0 … ∞ onto 0 … 1 with the fulcrum at 50 %, so `b = f` is neutral for
//!   overlay and the lights, as 50 % grey is on a display (negative values count as 0).
//! * **Display-referred** (creative LUTs, after filmic): encoded sRGB, 0 … 1. The usual
//!   compositing formulas (W3C's, with the opacity applied linearly), where white is
//!   multiply's neutral and 50 % the lights'. There's no fulcrum.
//!
//! Chroma and luminance swap the Euclidean norm of the RGB vector, as Ansel does.
//!
//! Each mode is a separate loop ([`Blend::mix_all`]), so the mode is matched once per
//! chunk of pixels rather than per pixel.

use crate::color::MIDDLE_GREY;
use crate::image::Rgb;
use crate::params::{BlendMode, Mask};

/// Highest encoded value the scene-referred light modes decode (`f / (1 − t)` grows
/// without bound): about 20 EV above the fulcrum.
const MAX_LIGHT: f32 = 1.0 - 1e-6;

/// A blend mode, compiled for the space it runs in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Blend {
    pub mode: BlendMode,
    /// The neutral value of multiply, divide and the light modes' encoding.
    fulcrum: f32,
    /// Scene-referred: the light modes run on `x / (x + fulcrum)`.
    scene: bool,
}

impl Blend {
    /// For an instance before filmic: scene-referred, around `mask`'s fulcrum.
    pub fn scene(mask: &Mask) -> Self {
        let fulcrum = MIDDLE_GREY * mask.blend_fulcrum.clamp(-10.0, 10.0).exp2();
        Self { mode: mask.blend, fulcrum, scene: true }
    }

    /// For an instance after filmic: display-referred, on encoded values.
    pub fn display(mask: &Mask) -> Self {
        Self { mode: mask.blend, fulcrum: 1.0, scene: false }
    }

    /// For an instance of `kind`, in its space.
    pub fn for_kind(mask: &Mask, kind: crate::params::ModuleKind) -> Self {
        if kind.display_referred() { Self::display(mask) } else { Self::scene(mask) }
    }

    /// The light modes' encoding, and its inverse.
    #[inline(always)]
    fn encode(&self, x: f32) -> f32 {
        if self.scene {
            let x = x.max(0.0);
            x / (x + self.fulcrum)
        } else {
            x.clamp(0.0, 1.0)
        }
    }

    #[inline(always)]
    fn decode(&self, t: f32) -> f32 {
        if self.scene {
            let t = t.min(MAX_LIGHT);
            self.fulcrum * t / (1.0 - t)
        } else {
            t
        }
    }

    /// A light mode `f(a, b)` on encoded values, per channel.
    #[inline(always)]
    fn light(&self, a: f32, b: f32, f: impl Fn(f32, f32) -> f32) -> f32 {
        self.decode(f(self.encode(a), self.encode(b)))
    }

    /// The mode's result for input `a` and output `b`, before the mask.
    #[inline]
    pub fn result(&self, a: Rgb, b: Rgb) -> Rgb {
        let per = |f: &dyn Fn(f32, f32) -> f32| [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])];
        let fulcrum = self.fulcrum;
        match self.mode {
            BlendMode::Normal => b,
            BlendMode::Lighten => per(&|a, b| a.max(b)),
            BlendMode::Darken => per(&|a, b| a.min(b)),
            BlendMode::Multiply => per(&|a, b| a * b / fulcrum),
            BlendMode::Divide => per(&|a, b| a * fulcrum / b.max(1e-6)),
            BlendMode::Addition => per(&|a, b| a + b),
            BlendMode::Subtraction => per(&|a, b| (a - b).max(0.0)),
            BlendMode::Difference => per(&|a, b| (a - b).abs()),
            BlendMode::Average => per(&|a, b| (a + b) * 0.5),
            BlendMode::GeometricMean => per(&|a, b| (a * b).max(0.0).sqrt()),
            BlendMode::HarmonicMean => per(&|a, b| 2.0 * a * b / (a.max(5e-7) + b.max(5e-7))),
            BlendMode::Screen => per(&|a, b| self.light(a, b, screen)),
            BlendMode::Overlay => per(&|a, b| self.light(a, b, |a, b| hard_light(b, a))),
            BlendMode::SoftLight => per(&|a, b| self.light(a, b, soft_light)),
            BlendMode::HardLight => per(&|a, b| self.light(a, b, hard_light)),
            BlendMode::Chroma => {
                let k = norm(a) / norm(b);
                b.map(|v| v * k)
            }
            BlendMode::Luminance => {
                let k = norm(b) / norm(a);
                a.map(|v| v * k)
            }
            BlendMode::Red => [b[0], a[1], a[2]],
            BlendMode::Green => [a[0], b[1], a[2]],
            BlendMode::Blue => [a[0], a[1], b[2]],
        }
    }

    /// `a` blended with `b` where the mask is `m`.
    #[inline]
    pub fn mix(&self, a: Rgb, b: Rgb, m: f32) -> Rgb {
        lerp(a, self.result(a, b), m)
    }

    /// [`mix`](Self::mix) on many pixels, in place in `a`: `b` and `m` are theirs.
    pub fn mix_all(&self, a: &mut [Rgb], b: &[Rgb], m: &[f32]) {
        // One loop per mode, so that the compiler sees a single mode in each.
        let each = |a: &mut [Rgb], f: &dyn Fn(Rgb, Rgb) -> Rgb| {
            for ((a, b), &m) in a.iter_mut().zip(b).zip(m) {
                if m > 0.0 {
                    *a = lerp(*a, f(*a, *b), m);
                }
            }
        };
        macro_rules! by_mode {
            ($($mode:ident),*) => {
                match self.mode {
                    BlendMode::Normal => {
                        for ((a, b), &m) in a.iter_mut().zip(b).zip(m) {
                            *a = lerp(*a, *b, m);
                        }
                    }
                    $(BlendMode::$mode => {
                        let blend = Blend { mode: BlendMode::$mode, ..*self };
                        each(a, &|a, b| blend.result(a, b))
                    })*
                }
            };
        }
        by_mode!(
            Lighten, Darken, Multiply, Divide, Addition, Subtraction, Difference, Average, GeometricMean, HarmonicMean, Screen, Overlay,
            SoftLight, HardLight, Chroma, Luminance, Red, Green, Blue
        );
    }
}

#[inline(always)]
fn lerp(a: Rgb, r: Rgb, m: f32) -> Rgb {
    [a[0] + (r[0] - a[0]) * m, a[1] + (r[1] - a[1]) * m, a[2] + (r[2] - a[2]) * m]
}

#[inline(always)]
fn norm(c: Rgb) -> f32 {
    (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt().max(1e-6)
}

#[inline(always)]
fn screen(a: f32, b: f32) -> f32 {
    a + b - a * b
}

/// Multiply below 50 %, screen above, steered by `b`.
#[inline(always)]
fn hard_light(a: f32, b: f32) -> f32 {
    if b <= 0.5 { 2.0 * a * b } else { screen(a, 2.0 * b - 1.0) }
}

/// W3C's soft light.
#[inline(always)]
fn soft_light(a: f32, b: f32) -> f32 {
    if b <= 0.5 {
        a - (1.0 - 2.0 * b) * a * (1.0 - a)
    } else {
        let d = if a <= 0.25 { ((16.0 * a - 12.0) * a + 4.0) * a } else { a.sqrt() };
        a + (2.0 * b - 1.0) * (d - a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODES: [BlendMode; 20] = [
        BlendMode::Normal,
        BlendMode::Lighten,
        BlendMode::Darken,
        BlendMode::Multiply,
        BlendMode::Divide,
        BlendMode::Addition,
        BlendMode::Subtraction,
        BlendMode::Difference,
        BlendMode::Average,
        BlendMode::GeometricMean,
        BlendMode::HarmonicMean,
        BlendMode::Screen,
        BlendMode::Overlay,
        BlendMode::SoftLight,
        BlendMode::HardLight,
        BlendMode::Chroma,
        BlendMode::Luminance,
        BlendMode::Red,
        BlendMode::Green,
        BlendMode::Blue,
    ];

    fn mask(blend: BlendMode, fulcrum: f32) -> Mask {
        Mask { blend, blend_fulcrum: fulcrum, ..Mask::default() }
    }

    fn close(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol * y.abs().max(1.0))
    }

    #[test]
    fn the_fulcrum_is_neutral() {
        let a = [0.02, 0.3, 4.0];
        for fulcrum in [-2.0, 0.0, 1.5] {
            let f = MIDDLE_GREY * f32::exp2(fulcrum);
            for mode in [BlendMode::Multiply, BlendMode::Divide, BlendMode::Overlay, BlendMode::SoftLight, BlendMode::HardLight] {
                let blend = Blend::scene(&mask(mode, fulcrum));
                // Overlay is steered by `a`: neutral where `a` is the fulcrum.
                let (a, b) = if mode == BlendMode::Overlay { ([f; 3], a) } else { (a, [f; 3]) };
                let want = if mode == BlendMode::Overlay { b } else { a };
                assert!(close(blend.result(a, b), want, 1e-4), "{mode:?} at {fulcrum} EV: {:?}", blend.result(a, b));
            }
        }
        // Display-referred: multiply's neutral is white, the lights' 50 %.
        let a = [0.1, 0.5, 0.9];
        assert!(close(Blend::display(&mask(BlendMode::Multiply, 3.0)).result(a, [1.0; 3]), a, 1e-6));
        for mode in [BlendMode::SoftLight, BlendMode::HardLight] {
            assert!(close(Blend::display(&mask(mode, 0.0)).result(a, [0.5; 3]), a, 1e-6), "{mode:?}");
        }
    }

    #[test]
    fn modes_follow_their_formulas() {
        let (a, b) = ([0.1, 0.4, 2.0], [0.3, 0.2, 2.0]);
        let r = |mode| Blend::scene(&mask(mode, 0.0)).result(a, b);
        let g = MIDDLE_GREY;
        assert_eq!(r(BlendMode::Normal), b);
        assert_eq!(r(BlendMode::Lighten), [0.3, 0.4, 2.0]);
        assert_eq!(r(BlendMode::Darken), [0.1, 0.2, 2.0]);
        assert!(close(r(BlendMode::Multiply), [0.03 / g, 0.08 / g, 4.0 / g], 1e-6));
        assert!(close(r(BlendMode::Divide), [g / 3.0, 2.0 * g, g], 1e-6));
        assert!(close(r(BlendMode::Addition), [0.4, 0.6, 4.0], 1e-6));
        assert!(close(r(BlendMode::Subtraction), [0.0, 0.2, 0.0], 1e-6));
        assert!(close(r(BlendMode::Difference), [0.2, 0.2, 0.0], 1e-6));
        assert!(close(r(BlendMode::Average), [0.2, 0.3, 2.0], 1e-6));
        assert!(close(r(BlendMode::GeometricMean), [0.03f32.sqrt(), 0.08f32.sqrt(), 2.0], 1e-6));
        assert!(close(r(BlendMode::HarmonicMean), [0.15, 0.8 / 3.0, 2.0], 1e-5));
        assert_eq!(r(BlendMode::Red), [0.3, 0.4, 2.0]);
        assert_eq!(r(BlendMode::Green), [0.1, 0.2, 2.0]);
        assert_eq!(r(BlendMode::Blue), [0.1, 0.4, 2.0]);
        // Chroma keeps `a`'s norm with `b`'s direction; luminance the reverse.
        let (ca, cb) = (r(BlendMode::Chroma), r(BlendMode::Luminance));
        assert!((norm(ca) - norm(a)).abs() < 1e-5 && (ca[0] / ca[1] - b[0] / b[1]).abs() < 1e-5);
        assert!((norm(cb) - norm(b)).abs() < 1e-5 && (cb[0] / cb[1] - a[0] / a[1]).abs() < 1e-5);
        // Screen brightens; the lights darken below the fulcrum and brighten above it.
        assert!(r(BlendMode::Screen).iter().zip(a).all(|(r, a)| *r >= a));
        let light = |mode, b: f32| Blend::scene(&mask(mode, 0.0)).result([g; 3], [b; 3])[0];
        for mode in [BlendMode::SoftLight, BlendMode::HardLight] {
            assert!(light(mode, g / 4.0) < g && light(mode, g * 4.0) > g, "{mode:?}");
        }
        // Display: W3C's formulas.
        let d = |mode| Blend::display(&mask(mode, 0.0)).result([0.25, 0.5, 0.8], [0.75, 0.2, 0.5]);
        assert!(close(d(BlendMode::Screen), [0.8125, 0.6, 0.9], 1e-6));
        assert!(close(d(BlendMode::HardLight), [0.625, 0.2, 0.8], 1e-6));
        assert!(close(d(BlendMode::Overlay), [0.375, 0.2, 0.8], 1e-6));
        assert!(close(d(BlendMode::SoftLight), [0.375, 0.35, 0.8], 1e-6));
        assert!(close(d(BlendMode::Multiply), [0.1875, 0.1, 0.4], 1e-6));
    }

    #[test]
    fn the_mask_mixes_the_result_in() {
        let (a, b) = ([0.1, 0.4, 2.0], [0.3, 0.2, 1.0]);
        for mode in MODES {
            let blend = Blend::scene(&mask(mode, 0.0));
            assert_eq!(blend.mix(a, b, 0.0), a, "{mode:?}");
            assert!(close(blend.mix(a, b, 1.0), blend.result(a, b), 1e-6), "{mode:?}");
            let half = blend.mix(a, b, 0.5);
            let r = blend.result(a, b);
            assert!(close(half, [0, 1, 2].map(|i| (a[i] + r[i]) / 2.0), 1e-6), "{mode:?}");
            // The loop per mode gives the same.
            let mut many = [a, a, a];
            blend.mix_all(&mut many, &[b, b, b], &[0.0, 0.5, 1.0]);
            assert_eq!(many, [a, half, blend.mix(a, b, 1.0)], "{mode:?}");
        }
    }

    #[test]
    fn extreme_values_stay_finite() {
        let values = [-0.5, 0.0, 1e-9, 0.18, 1e4];
        for mode in MODES {
            for scene in [true, false] {
                let m = mask(mode, 0.0);
                let blend = if scene { Blend::scene(&m) } else { Blend::display(&m) };
                for &x in &values {
                    for &y in &values {
                        let r = blend.result([x, y, x], [y, x, 0.0]);
                        assert!(r.iter().all(|v| v.is_finite()), "{mode:?} scene {scene}: {x}, {y} → {r:?}");
                    }
                }
            }
        }
    }
}
