//! Tone mapping: compress unbounded scene-linear values into display range.

use crate::color::{MIDDLE_GREY, luminance};
use crate::image::Image;
use crate::params::ToneMap;

/// Global shadows/highlights: an exposure gain, driven by each pixel's luminance in
/// EV relative to middle grey, with smooth bells centred in the shadows (-3 EV)
/// and the highlights (+2 EV).
pub fn shadows_highlights(img: &mut Image, p: &ToneMap) {
    if p.shadows == 0.0 && p.highlights == 0.0 {
        return;
    }
    let (shadows, highlights) = (p.shadows.clamp(-1.0, 1.0) * 1.5, p.highlights.clamp(-1.0, 1.0) * 1.5);
    img.map_in_place(|px| {
        let y = luminance(px).max(1e-6);
        let ev = (y / MIDDLE_GREY).log2();
        let bell = |centre: f32, width: f32| (-(ev - centre).powi(2) / (2.0 * width * width)).exp();
        let gain = (shadows * bell(-3.0, 1.5) + highlights * bell(2.0, 1.5)).exp2();
        px.map(|c| c * gain)
    });
}

/// Per-channel sigmoid, `f(x) = xᶜ / (xᶜ + kᶜ)`, anchored so that middle grey
/// stays middle grey. Asymptotically approaches 1 (display white).
pub fn sigmoid(img: &mut Image, p: &ToneMap) {
    if !p.enabled {
        img.map_in_place(|px| px.map(|c| c.clamp(0.0, 1.0)));
        return;
    }
    let c = p.contrast.clamp(0.5, 4.0);
    // Solve f(grey) = grey for k.
    let kc = MIDDLE_GREY.powf(c) * (1.0 / MIDDLE_GREY - 1.0);
    img.map_in_place(|px| {
        px.map(|v| {
            let xc = v.max(0.0).powf(c);
            xc / (xc + kc)
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigmoid_keeps_grey_and_bounds() {
        let mut img = Image { width: 3, height: 1, pixels: vec![[MIDDLE_GREY; 3], [0.0; 3], [1000.0; 3]] };
        sigmoid(&mut img, &ToneMap::default());
        assert!((img.pixels[0][0] - MIDDLE_GREY).abs() < 1e-4);
        assert_eq!(img.pixels[1][0], 0.0);
        assert!(img.pixels[2][0] < 1.0 && img.pixels[2][0] > 0.99);
    }
}
