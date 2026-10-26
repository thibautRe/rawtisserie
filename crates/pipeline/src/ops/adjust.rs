//! Simple per-pixel adjustments in scene-linear working space.

use crate::color::luminance;
use crate::image::Image;
use crate::params::{Color, Exposure, WhiteBalance};

pub fn exposure(img: &mut Image, p: &Exposure) {
    if p.ev == 0.0 && p.black == 0.0 {
        return;
    }
    let gain = p.ev.exp2();
    let black = p.black;
    img.map_in_place(|px| px.map(|c| (c - black) * gain));
}

/// Warmth/tint tweaks on top of the as-shot white balance. Channel gains are
/// normalised so that luminance is preserved.
pub fn white_balance(img: &mut Image, p: &WhiteBalance) {
    if p.warmth == 0.0 && p.tint == 0.0 {
        return;
    }
    let warmth = p.warmth.clamp(-1.0, 1.0) * 0.5;
    let tint = p.tint.clamp(-1.0, 1.0) * 0.35;
    let mut gains = [warmth.exp2(), (-tint).exp2(), (-warmth).exp2()];
    let y = luminance(gains);
    gains = gains.map(|g| g / y);
    img.map_in_place(|px| [px[0] * gains[0], px[1] * gains[1], px[2] * gains[2]]);
}

pub fn color(img: &mut Image, p: &Color) {
    if p.saturation == 0.0 && p.vibrance == 0.0 {
        return;
    }
    let saturation = 1.0 + p.saturation.clamp(-1.0, 1.0);
    let vibrance = p.vibrance.clamp(-1.0, 1.0);
    img.map_in_place(|px| {
        let y = luminance(px);
        let max = px[0].max(px[1]).max(px[2]);
        let min = px[0].min(px[1]).min(px[2]);
        // Relative chroma in [0, 1]: vibrance acts most on muted colours.
        let chroma = if max > 1e-6 { ((max - min) / max).clamp(0.0, 1.0) } else { 0.0 };
        let k = (saturation * (1.0 + vibrance * (1.0 - chroma))).max(0.0);
        px.map(|c| y + (c - y) * k)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposure_doubles() {
        let mut img = Image { width: 1, height: 1, pixels: vec![[0.1, 0.2, 0.3]] };
        exposure(&mut img, &Exposure { ev: 1.0, black: 0.0 });
        assert_eq!(img.pixels[0], [0.2, 0.4, 0.6]);
    }

    #[test]
    fn desaturate_gives_grey() {
        let mut img = Image { width: 1, height: 1, pixels: vec![[0.5, 0.2, 0.1]] };
        color(&mut img, &Color { saturation: -1.0, vibrance: 0.0 });
        let [r, g, b] = img.pixels[0];
        assert!((r - g).abs() < 1e-6 && (g - b).abs() < 1e-6);
    }

    #[test]
    fn white_balance_keeps_luminance() {
        let mut img = Image { width: 1, height: 1, pixels: vec![[0.18, 0.18, 0.18]] };
        white_balance(&mut img, &WhiteBalance { warmth: 0.8, tint: -0.3 });
        assert!((luminance(img.pixels[0]) - 0.18).abs() < 1e-5);
        assert!(img.pixels[0][0] > img.pixels[0][2]);
    }
}
