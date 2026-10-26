//! Working space → 8-bit sRGB.

use crate::color::{REC709_FROM_REC2020, mul_vec, srgb_oetf};
use crate::image::{Image, Rgba8};

const LUT_SIZE: usize = 4096;

pub fn to_srgb8(img: &Image) -> Rgba8 {
    let lut: Vec<u8> = (0..=LUT_SIZE)
        .map(|i| (srgb_oetf(i as f32 / LUT_SIZE as f32) * 255.0 + 0.5) as u8)
        .collect();
    let encode = |v: f32| lut[(v.clamp(0.0, 1.0) * LUT_SIZE as f32 + 0.5) as usize];
    let mut data = Vec::with_capacity(img.pixels.len() * 4);
    for p in &img.pixels {
        let [r, g, b] = mul_vec(&REC709_FROM_REC2020, *p);
        data.extend_from_slice(&[encode(r), encode(g), encode(b), 255]);
    }
    Rgba8 { width: img.width, height: img.height, data }
}
