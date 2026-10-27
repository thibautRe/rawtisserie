//! Clipping indicators, painted over a rendered image (like Ansel's `overexposed.c`
//! and `rawoverexposed.c`). They are display options, not part of the recipe.
//!
//! * **Display clipping** flags pixels of the output that hit the top or bottom of
//!   the display range, measured on the 8-bit result (so exactly what is shown).
//! * **Sensor clipping** flags pixels built from saturated photosites; the mask comes
//!   from the base stage and is resampled through the geometry stage.

use serde::Deserialize;

use crate::image::{Mask, Rgba8};

/// What to paint over a render. The default paints nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Overlays {
    pub display: Option<DisplayClipping>,
    pub sensor: bool,
    /// Diagonal stripes of this width (output pixels, may be fractional so that a
    /// reduced draft matches the full render) instead of solid colour; 0 = solid.
    pub stripes: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DisplayClipping {
    pub mode: ClipMode,
    /// Display-linear level at or above which a value is clipped.
    pub upper: f32,
    /// Display-linear level, in EV, below which a value is crushed. The default is
    /// where 8-bit sRGB rounds to 0.
    pub lower_ev: f32,
}

impl Default for DisplayClipping {
    fn default() -> Self {
        Self { mode: ClipMode::AnyChannel, upper: 0.9999, lower_ev: -12.69 }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipMode {
    /// Any channel out of range.
    #[default]
    AnyChannel,
    /// Luminance out of range.
    Luminance,
    /// Luminance in range but a channel out of it: colour lost to the display gamut.
    Saturation,
}

const OVER: [u8; 3] = [255, 0, 0];
const UNDER: [u8; 3] = [0, 64, 255];
const SENSOR: [u8; 3] = [255, 0, 255];

/// Rec.709 luma, for display-linear sRGB.
const LUMA_REC709: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// Does pixel `(x, y)` belong to a stripe? `rising` picks the diagonal direction.
#[inline]
fn on_stripe(x: usize, y: usize, height: usize, stripes: f32, rising: bool) -> bool {
    if stripes <= 0.0 {
        return true;
    }
    let d = if rising { x + (height - y) } else { x + y };
    ((d as f32 + 0.5) / stripes) as usize % 2 == 0
}

fn srgb_eotf(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

pub fn paint(img: &mut Rgba8, overlays: &Overlays, sensor: Option<&Mask>) {
    if let Some(display) = &overlays.display {
        paint_display(img, display, overlays.stripes);
    }
    if let Some(mask) = sensor.filter(|_| overlays.sensor) {
        paint_sensor(img, mask, overlays.stripes);
    }
}

fn paint_display(img: &mut Rgba8, p: &DisplayClipping, stripes: f32) {
    let linear: [f32; 256] = std::array::from_fn(|i| srgb_eotf(i as f32 / 255.0));
    let lower = p.lower_ev.exp2();
    // Per-channel tests on 8-bit values: precompute the thresholds once.
    let over_u8 = (0..=255u8).find(|&v| linear[v as usize] >= p.upper).map_or(256, u16::from);
    let under_u8 = (0..=255u8).rev().find(|&v| linear[v as usize] < lower).map_or(-1, i16::from);
    let channel_over = |c: &[u8]| c.iter().any(|&v| u16::from(v) >= over_u8);
    let channel_under = |c: &[u8]| c.iter().any(|&v| i16::from(v) <= under_u8);
    let luma = |c: &[u8]| (0..3).map(|i| linear[c[i] as usize] * LUMA_REC709[i]).sum::<f32>();

    let (width, height) = (img.width, img.height);
    for (i, px) in img.data.chunks_exact_mut(4).enumerate() {
        let c = &px[..3];
        // Luminance can only be out of range if a channel is.
        let colour = if !channel_over(c) && !channel_under(c) {
            None
        } else {
            let clipped = || if channel_over(c) { OVER } else { UNDER };
            match p.mode {
                ClipMode::AnyChannel => Some(clipped()),
                ClipMode::Luminance => {
                    let y = luma(c);
                    if y >= p.upper {
                        Some(OVER)
                    } else if y < lower {
                        Some(UNDER)
                    } else {
                        None
                    }
                }
                ClipMode::Saturation => {
                    let y = luma(c);
                    (y < p.upper && y >= lower).then(clipped)
                }
            }
        };
        if let Some(colour) = colour {
            if on_stripe(i % width, i / width, height, stripes, false) {
                px[..3].copy_from_slice(&colour);
            }
        }
    }
}

fn paint_sensor(img: &mut Rgba8, mask: &Mask, stripes: f32) {
    debug_assert_eq!((mask.width, mask.height), (img.width, img.height));
    let (width, height) = (img.width, img.height);
    for (i, px) in img.data.chunks_exact_mut(4).enumerate() {
        let (x, y) = (i % width, i / width);
        if mask.get(x, y) && on_stripe(x, y, height, stripes, true) {
            px[..3].copy_from_slice(&SENSOR);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One row of pixels, painted with `mode`; returns the resulting colours.
    fn painted(mode: ClipMode, pixels: &[[u8; 3]]) -> Vec<[u8; 3]> {
        let mut img = Rgba8 { width: pixels.len(), height: 1, data: pixels.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect() };
        paint(&mut img, &Overlays { display: Some(DisplayClipping { mode, ..Default::default() }), ..Default::default() }, None);
        img.data.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect()
    }

    const WHITE: [u8; 3] = [255; 3];
    const BLACK: [u8; 3] = [0; 3];
    const GREY: [u8; 3] = [128; 3];
    const ORANGE: [u8; 3] = [255, 128, 0];
    const NEAR_WHITE: [u8; 3] = [254; 3];

    #[test]
    fn any_channel() {
        assert_eq!(painted(ClipMode::AnyChannel, &[WHITE, BLACK, GREY, ORANGE, NEAR_WHITE]), [OVER, UNDER, GREY, OVER, NEAR_WHITE]);
    }

    #[test]
    fn luminance_ignores_saturated_colours() {
        assert_eq!(painted(ClipMode::Luminance, &[WHITE, BLACK, GREY, ORANGE]), [OVER, UNDER, GREY, ORANGE]);
    }

    #[test]
    fn saturation_flags_only_colours() {
        assert_eq!(painted(ClipMode::Saturation, &[WHITE, BLACK, GREY, ORANGE, [0, 0, 200]]), [WHITE, BLACK, GREY, OVER, UNDER]);
    }

    #[test]
    fn stripes_alternate() {
        let mut img = Rgba8 { width: 4, height: 1, data: vec![255; 16] };
        let overlays = Overlays { display: Some(DisplayClipping::default()), stripes: 2.0, ..Default::default() };
        paint(&mut img, &overlays, None);
        let greens: Vec<u8> = img.data.chunks_exact(4).map(|p| p[1]).collect();
        assert_eq!(greens, [0, 0, 255, 255]);
    }

    #[test]
    fn sensor_mask() {
        let mut img = Rgba8 { width: 2, height: 1, data: vec![128; 8] };
        let mut mask = Mask::new(2, 1);
        mask.set(1, 0);
        paint(&mut img, &Overlays { sensor: true, ..Default::default() }, Some(&mask));
        assert_eq!(&img.data[..3], [128; 3]);
        assert_eq!(&img.data[4..7], SENSOR);
    }

    #[test]
    fn deserialises_from_js() {
        let o: Overlays = serde_json::from_str(r#"{ "display": { "mode": "saturation" }, "stripes": 6 }"#).unwrap();
        assert_eq!(o.display.unwrap().mode, ClipMode::Saturation);
        assert_eq!(o.display.unwrap().upper, 0.9999);
        assert!(!o.sensor);
    }
}
