//! Output file encoding.

use jpeg_encoder::{ColorType, Encoder};

use crate::image::Rgba8;
use crate::{Error, Result};

pub fn jpeg(img: &Rgba8, quality: u8) -> Result<Vec<u8>> {
    let (w, h) = (u16::try_from(img.width), u16::try_from(img.height));
    let (Ok(w), Ok(h)) = (w, h) else {
        return Err(Error::Encode(format!("{}×{} is too large for JPEG", img.width, img.height)));
    };
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, quality.clamp(1, 100));
    encoder.set_progressive(true);
    encoder
        .encode(&img.data, w, h, ColorType::Rgba)
        .map_err(|e| Error::Encode(e.to_string()))?;
    Ok(out)
}
