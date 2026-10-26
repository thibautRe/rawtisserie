//! The [`Developer`]: one decoded RAW file, rendered as many times as needed.

use crate::decode::{self, RawPhoto};
use crate::demosaic;
use crate::image::{Image, Rgba8};
use crate::metadata::PhotoMetadata;
use crate::ops::{adjust, filters, geometry, output, tone};
use crate::params::EditParams;
use crate::Result;

/// Bounding box for a render; the image is fitted inside it, never upscaled.
/// `0` means unbounded on that axis.
#[derive(Clone, Copy, Debug, Default)]
pub struct RenderSize {
    pub max_width: u32,
    pub max_height: u32,
}

impl RenderSize {
    pub const FULL: RenderSize = RenderSize { max_width: 0, max_height: 0 };

    pub fn fit(max_width: u32, max_height: u32) -> Self {
        Self { max_width, max_height }
    }
}

/// Holds a decoded RAW file plus a cached demosaiced "base" image so that
/// re-rendering with different parameters (e.g. dragging a slider) only re-runs
/// the cheap part of the pipeline.
pub struct Developer {
    photo: RawPhoto,
    base: Option<(usize, Image)>,
}

impl Developer {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(Self::new(decode::decode(bytes)?))
    }

    pub fn new(photo: RawPhoto) -> Self {
        Self { photo, base: None }
    }

    pub fn photo(&self) -> &RawPhoto {
        &self.photo
    }

    pub fn metadata(&self) -> &PhotoMetadata {
        &self.photo.metadata
    }

    /// Drop the cached base image to free memory.
    pub fn release_cache(&mut self) {
        self.base = None;
    }

    fn transform(&self, params: &EditParams) -> geometry::Transform {
        let g = &params.geometry;
        geometry::Transform {
            orient: self.photo.orientation.then(g.rotation % 4, g.flip_horizontal),
            angle: g.angle.clamp(-45.0, 45.0),
            crop: g.crop.sanitized(),
        }
    }

    /// Output dimensions and scale (output pixels per full-resolution pixel).
    pub fn output_size(&self, params: &EditParams, size: RenderSize) -> (usize, usize, f32) {
        let t = self.transform(params);
        let (cw, ch) = t.cropped_size(self.photo.width as f32, self.photo.height as f32);
        let mut scale = 1.0f32;
        if size.max_width > 0 {
            scale = scale.min(size.max_width as f32 / cw);
        }
        if size.max_height > 0 {
            scale = scale.min(size.max_height as f32 / ch);
        }
        let w = ((cw * scale).round() as usize).max(1);
        let h = ((ch * scale).round() as usize).max(1);
        (w, h, scale)
    }

    pub fn render(&mut self, params: &EditParams, size: RenderSize) -> Rgba8 {
        output::to_srgb8(&self.render_linear(params, size))
    }

    /// Run the pipeline up to (and including) tone mapping; the result is display-
    /// referred linear Rec.2020.
    pub fn render_linear(&mut self, params: &EditParams, size: RenderSize) -> Image {
        let (out_w, out_h, scale) = self.output_size(params, size);
        let transform = self.transform(params);
        // Bin as much as possible while keeping the base at least as large as the output.
        let factor = ((1.0 / scale).floor() as usize).clamp(1, 64);
        let base = self.base(factor);

        let mut img = geometry::apply(base, &transform, out_w, out_h);
        // Spatial parameters are expressed in full-resolution pixels.
        adjust::exposure(&mut img, &params.exposure);
        adjust::white_balance(&mut img, &params.white_balance);
        adjust::color(&mut img, &params.color);
        filters::blur(&mut img, params.blur.radius * scale);
        filters::sharpen(&mut img, params.sharpen.amount, params.sharpen.radius * scale);
        tone::shadows_highlights(&mut img, &params.tone_map);
        tone::sigmoid(&mut img, &params.tone_map);
        img
    }

    fn base(&mut self, factor: usize) -> &Image {
        let reusable = matches!(&self.base, Some((f, _)) if *f <= factor && factor <= *f * 4);
        if !reusable {
            self.base = None; // free the old one before allocating the new one
            self.base = Some((factor, demosaic::develop_base(&self.photo, factor)));
        }
        &self.base.as_ref().expect("base was just built").1
    }
}
