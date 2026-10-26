//! The [`Developer`]: one decoded RAW file, rendered as many times as needed.

use crate::decode::{self, RawPhoto};
use crate::demosaic;
use crate::image::{Image, Rgba8};
use crate::metadata::PhotoMetadata;
use crate::ops::point::PointOps;
use crate::ops::{filters, geometry};
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

/// Holds a decoded RAW file plus caches of intermediate images, so that re-rendering
/// with different parameters (e.g. dragging a slider) only re-runs the stages that
/// are affected:
///
/// ```text
///  base        demosaic/bin, white balance, camera → working     keyed by binning factor
///   └ geometry  orientation, straighten, crop, resample          keyed by geometry + output size (2 sizes kept)
///      └ detail blur, sharpen                                     keyed by the above + blur/sharpen
///         └ point ops (exposure … tone mapping → sRGB)            always re-run, one fused pass
/// ```
///
/// Blur and sharpen run before exposure, white balance and saturation. Those are
/// linear per-pixel operations, so the order makes no difference to the result,
/// but it means the most-used sliders never invalidate the spatial stages.
pub struct Developer {
    photo: RawPhoto,
    base: Option<(usize, Image)>,
    /// Spatial-stage caches per output size, most recently used first. Two sizes cover
    /// the interactive case: a reduced "draft" size while dragging, full size after.
    slots: Vec<Slot>,
}

const MAX_SLOTS: usize = 2;

struct Slot {
    size: (usize, usize),
    geometry: Option<(GeometryKey, Image)>,
    detail: Option<(DetailKey, Image)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct GeometryKey {
    base_factor: usize,
    transform: geometry::Transform,
    width: usize,
    height: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct DetailKey {
    geometry: GeometryKey,
    blur_sigma: f32,
    sharpen_amount: f32,
    sharpen_sigma: f32,
}

impl Developer {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(Self::new(decode::decode(bytes)?))
    }

    pub fn new(photo: RawPhoto) -> Self {
        Self { photo, base: None, slots: Vec::new() }
    }

    pub fn photo(&self) -> &RawPhoto {
        &self.photo
    }

    pub fn metadata(&self) -> &PhotoMetadata {
        &self.photo.metadata
    }

    /// Drop all cached intermediate images to free memory.
    pub fn release_cache(&mut self) {
        self.base = None;
        self.slots.clear();
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
        let ops = PointOps::new(params);
        ops.render(self.detail_image(params, size))
    }

    /// The output of the spatial stages (geometry, blur, sharpen), from cache when possible.
    fn detail_image(&mut self, params: &EditParams, size: RenderSize) -> &Image {
        let (width, height, scale) = self.output_size(params, size);
        // Bin as much as possible while keeping the base at least as large as the output.
        let factor = ((1.0 / scale).floor() as usize).clamp(1, 64);
        let base_factor = self.ensure_base(factor);

        let gkey = GeometryKey { base_factor, transform: self.transform(params), width, height };

        // Pick (or create) the cache slot for this output size, and make it the most recent.
        let slot = match self.slots.iter().position(|s| s.size == (width, height)) {
            Some(i) => self.slots.remove(i),
            None => Slot { size: (width, height), geometry: None, detail: None },
        };
        self.slots.insert(0, slot);
        self.slots.truncate(MAX_SLOTS);
        let slot = &mut self.slots[0];
        let base = &self.base.as_ref().expect("base was just built").1;

        if slot.geometry.as_ref().map(|(k, _)| k) != Some(&gkey) {
            slot.detail = None;
            slot.geometry = None; // free before allocating
            slot.geometry = Some((gkey, geometry::apply(base, &gkey.transform, width, height)));
        }

        // Spatial parameters are expressed in full-resolution pixels.
        let dkey = DetailKey {
            geometry: gkey,
            blur_sigma: params.blur.radius * scale,
            sharpen_amount: params.sharpen.amount,
            sharpen_sigma: params.sharpen.radius * scale,
        };
        let no_detail = !filters::blur_active(dkey.blur_sigma) && !filters::sharpen_active(dkey.sharpen_amount, dkey.sharpen_sigma);
        let geometry_img = &slot.geometry.as_ref().expect("geometry was just built").1;
        if no_detail {
            slot.detail = None;
            return geometry_img;
        }
        if slot.detail.as_ref().map(|(k, _)| k) != Some(&dkey) {
            let mut img = geometry_img.clone();
            filters::blur(&mut img, dkey.blur_sigma);
            filters::sharpen(&mut img, dkey.sharpen_amount, dkey.sharpen_sigma);
            slot.detail = Some((dkey, img));
        }
        &slot.detail.as_ref().expect("detail was just built").1
    }

    /// Make sure a base image suitable for `factor` is cached; returns its actual factor.
    fn ensure_base(&mut self, factor: usize) -> usize {
        match &self.base {
            Some((f, _)) if *f <= factor && factor <= *f * 4 => *f,
            _ => {
                self.release_cache(); // free the old one before allocating the new one
                self.base = Some((factor, demosaic::develop_base(&self.photo, factor)));
                factor
            }
        }
    }
}
