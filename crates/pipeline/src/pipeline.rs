//! The [`Developer`]: one decoded RAW file, rendered as many times as needed.

use crate::decode::{self, RawPhoto};
use crate::demosaic;
use crate::image::{Image, Mask, Rgba8};
use crate::metadata::PhotoMetadata;
use std::rc::Rc;

use crate::ops::point::{FILMIC_LUT_SIZE, FilmicStage, PointOps};
use crate::ops::calibration::{self, Detection};
use crate::ops::clipping::{self, Overlays};
use crate::ops::primaries::{ColorPrimariesStage, FieldWeights, WeightsKey};
use crate::ops::{equalizer, filmic, filters, geometry};
use crate::params::{ColorPrimaries, ContrastEqualizer, EditParams, Filmic, Geometry, Lens, Module, ModuleKind};
use crate::Result;

/// Interactive renders may approximate (filmic's 3D lookup table, within 1–2 levels
/// for 99.9 % of pixels); final renders (exports, thumbnails) are exact.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Quality {
    Interactive,
    #[default]
    Final,
}

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
///  base        demosaic/bin, reference WB, camera → working       keyed by binning factor
///   └ geometry  lens, orientation, straighten, crop, resample    keyed by lens + geometry + output size (2 sizes kept)
///      └ detail blur, sharpen, contrast equalizer instances       keyed by the above + their parameters at this scale
///         └ point ops (exposure … tone mapping → sRGB)            always re-run, one fused pass
/// ```
///
/// Clipping indicators are painted on the result when asked for. Sensor clipping
/// needs a mask of saturated photosites, built on demand next to the base and
/// resampled like the geometry stage (cached per slot).
///
/// Blur and sharpen run before exposure, white balance and saturation. Those are
/// linear per-pixel operations, so the order makes no difference to the result,
/// but it means the most-used sliders never invalidate the spatial stages. The
/// contrast equalizer works on log luminance, so exposure doesn't affect it either.
pub struct Developer {
    photo: RawPhoto,
    base: Option<(usize, Image)>,
    /// Spatial-stage caches per output size, most recently used first. Two sizes cover
    /// the interactive case: a reduced "draft" size while dragging, full size after.
    slots: Vec<Slot>,
    /// Filmic, compiled for the last parameters used interactively.
    filmic: Option<(Filmic, Rc<FilmicStage>)>,
    /// Colour primaries tables used by the last render.
    primaries: Vec<(ColorPrimaries, Rc<ColorPrimariesStage>)>,
    /// What those tables are built from besides the edits, for the last settings used.
    primaries_weights: Option<Rc<FieldWeights>>,
    /// Saturated photosites at the base's resolution, built on demand.
    sensor_clip: Option<(usize, Mask)>,
}

const MAX_SLOTS: usize = 2;

struct Slot {
    size: (usize, usize),
    geometry: Option<(GeometryKey, Image)>,
    detail: Option<(DetailKey, Image)>,
    /// `sensor_clip` through the geometry stage.
    sensor_clip: Option<(GeometryKey, Mask)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct GeometryKey {
    base_factor: usize,
    transform: geometry::Transform,
    width: usize,
    height: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct DetailKey {
    geometry: GeometryKey,
    /// The active blur and sharpen instances, in pipeline order.
    steps: Vec<DetailStep>,
}

/// A spatial instance, with its parameters at the output size.
#[derive(Clone, Copy, Debug, PartialEq)]
enum DetailStep {
    Blur { sigma: f32 },
    Sharpen { amount: f32, sigma: f32 },
    /// `scale`: output pixels per full-resolution pixel.
    Equalizer { params: ContrastEqualizer, scale: f32 },
}

impl Developer {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(Self::new(decode::decode(bytes)?))
    }

    pub fn new(photo: RawPhoto) -> Self {
        Self { photo, base: None, slots: Vec::new(), filmic: None, primaries: Vec::new(), primaries_weights: None, sensor_clip: None }
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
        self.filmic = None;
        self.primaries.clear();
        self.primaries_weights = None;
        self.sensor_clip = None;
    }

    fn transform(&self, params: &EditParams) -> geometry::Transform {
        let identity = Geometry::default();
        let g = params.get::<Geometry>().unwrap_or(&identity);
        geometry::Transform {
            lens: self.photo.lens.as_ref().and(params.get::<Lens>().copied()),
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

    pub fn render(&mut self, params: &EditParams, size: RenderSize, quality: Quality) -> Rgba8 {
        let filmic = params.get::<Filmic>().map(|f| self.filmic_stage(f, quality));
        let ops = self.point_ops(params, filmic);
        ops.render(self.spatial_image(params, size))
    }

    /// The point operations, with colour primaries tables from cache when possible.
    fn point_ops(&mut self, params: &EditParams, filmic: Option<Rc<FilmicStage>>) -> PointOps {
        let cache = std::mem::take(&mut self.primaries);
        let mut weights = self.primaries_weights.take();
        let mut used = Vec::new();
        let ops = PointOps::with_stages(params, self.photo.as_shot_illuminant, filmic, &mut |p| {
            let stage = match cache.iter().find(|(q, _)| q == p) {
                Some((_, stage)) => stage.clone(),
                None => {
                    // Moving a primary keeps the weights; only gamut coverage and
                    // smoothing rebuild them (~10× the cost of a table).
                    let w = match &weights {
                        Some(w) if w.key() == WeightsKey::of(p) => w.clone(),
                        _ => Rc::new(FieldWeights::new(p)),
                    };
                    let stage = Rc::new(ColorPrimariesStage::new(p, &w));
                    weights = Some(w);
                    stage
                }
            };
            used.push((p.clone(), stage.clone()));
            stage
        });
        self.primaries = used;
        self.primaries_weights = weights;
        ops
    }

    /// [`render`](Self::render), with clipping indicators painted on top.
    pub fn render_with_overlays(&mut self, params: &EditParams, size: RenderSize, quality: Quality, overlays: &Overlays) -> Rgba8 {
        let mut img = self.render(params, size, quality);
        let sensor = overlays.sensor.then(|| self.sensor_clip_mask(params, size));
        clipping::paint(&mut img, overlays, sensor);
        img
    }

    /// Output pixels that contain saturated photosites, from cache when possible.
    pub fn sensor_clip_mask(&mut self, params: &EditParams, size: RenderSize) -> &Mask {
        let (width, height, _) = self.output_size(params, size);
        // Builds the base and selects this size's slot, as for a render.
        self.spatial_image(params, size);
        let base_factor = self.base.as_ref().expect("base was just built").0;
        let gkey = GeometryKey { base_factor, transform: self.transform(params), width, height };

        if self.sensor_clip.as_ref().map(|(f, _)| *f) != Some(base_factor) {
            self.sensor_clip = Some((base_factor, demosaic::clipped_photosites(&self.photo, base_factor)));
            for slot in &mut self.slots {
                slot.sensor_clip = None;
            }
        }
        let base_mask = &self.sensor_clip.as_ref().expect("mask was just built").1;
        let slot = &mut self.slots[0];
        if slot.sensor_clip.as_ref().map(|(k, _)| k) != Some(&gkey) {
            slot.sensor_clip = Some((gkey, geometry::apply_mask(base_mask, &gkey.transform, self.photo.lens.as_ref(), width, height)));
        }
        &slot.sensor_clip.as_ref().expect("mask was just built").1
    }

    /// The output of the spatial stages (geometry, blur, sharpen), from cache when possible.
    pub fn spatial_image(&mut self, params: &EditParams, size: RenderSize) -> &Image {
        let (width, height, scale) = self.output_size(params, size);
        // Bin as much as possible while keeping the base at least as large as the output.
        let factor = ((1.0 / scale).floor() as usize).clamp(1, 64);
        let base_factor = self.ensure_base(factor);

        let gkey = GeometryKey { base_factor, transform: self.transform(params), width, height };

        // Pick (or create) the cache slot for this output size, and make it the most recent.
        let slot = match self.slots.iter().position(|s| s.size == (width, height)) {
            Some(i) => self.slots.remove(i),
            None => Slot { size: (width, height), geometry: None, detail: None, sensor_clip: None },
        };
        self.slots.insert(0, slot);
        self.slots.truncate(MAX_SLOTS);
        let slot = &mut self.slots[0];
        let base = &self.base.as_ref().expect("base was just built").1;

        if slot.geometry.as_ref().map(|(k, _)| k) != Some(&gkey) {
            slot.detail = None;
            slot.geometry = None; // free before allocating
            slot.geometry = Some((gkey, geometry::apply(base, &gkey.transform, self.photo.lens.as_ref(), width, height)));
        }

        // Spatial parameters are expressed in full-resolution pixels.
        let steps: Vec<DetailStep> = params
            .modules
            .iter()
            .filter(|m| m.enabled)
            .filter_map(|m| match &m.module {
                Module::Blur(b) => Some(DetailStep::Blur { sigma: b.radius * scale }),
                Module::Sharpen(s) => Some(DetailStep::Sharpen { amount: s.amount, sigma: s.radius * scale }),
                Module::ContrastEqualizer(e) => Some(DetailStep::Equalizer { params: *e, scale }),
                _ => None,
            })
            .filter(|step| match *step {
                DetailStep::Blur { sigma } => filters::blur_active(sigma),
                DetailStep::Sharpen { amount, sigma } => filters::sharpen_active(amount, sigma),
                DetailStep::Equalizer { params, .. } => !params.is_identity(),
            })
            .collect();
        let geometry_img = &slot.geometry.as_ref().expect("geometry was just built").1;
        if steps.is_empty() {
            slot.detail = None;
            return geometry_img;
        }
        let dkey = DetailKey { geometry: gkey, steps };
        if slot.detail.as_ref().map(|(k, _)| k) != Some(&dkey) {
            let mut img = geometry_img.clone();
            for step in &dkey.steps {
                match *step {
                    DetailStep::Blur { sigma } => filters::blur(&mut img, sigma),
                    DetailStep::Sharpen { amount, sigma } => filters::sharpen(&mut img, amount, sigma),
                    DetailStep::Equalizer { params, scale } => equalizer::apply(&mut img, &params, scale),
                }
            }
            slot.detail = Some((dkey, img));
        }
        &slot.detail.as_ref().expect("detail was just built").1
    }

    /// Filmic auto-tune on the current image (after crop and the adjustments that
    /// precede filmic). Returns `(white_exposure, black_exposure)`, or `None` without
    /// an enabled filmic instance or anything to measure.
    pub fn auto_tune_filmic(&mut self, params: &EditParams, size: RenderSize) -> Option<(f32, f32)> {
        let scaling = params.get::<Filmic>()?.dynamic_range_scaling;
        let ops = self.point_ops(params, None);
        let img = self.spatial_image(params, size);
        filmic::auto_tune(img.pixels.iter().map(|px| ops.adjust(*px)), scaling)
    }

    /// Estimate the scene's light on the input of colour calibration instance `id` (the
    /// image after the modules before it), as Ansel's auto-detection does. Returns its
    /// xy chromaticity, or `None` without such an instance or anything to measure.
    pub fn detect_illuminant(&mut self, params: &EditParams, id: &str, size: RenderSize, method: Detection) -> Option<[f32; 2]> {
        let at = params.modules.iter().position(|m| m.id == id && m.module.kind() == ModuleKind::ColorCalibration)?;
        let before = EditParams { version: params.version, modules: params.modules[..at].to_vec() };
        let ops = self.point_ops(&before, None);
        // The spatial modules all come before calibration: same image, from cache.
        let img = self.spatial_image(params, size);
        calibration::detect_illuminant(img, |px| ops.adjust(px), method)
    }

    /// Filmic for interactive renders: computed exactly right after its parameters
    /// change (e.g. while one of its sliders is dragged), then baked into a 3D lookup
    /// table once the same parameters are rendered again (other sliders, full-size
    /// render after a draft…).
    fn filmic_stage(&mut self, p: &Filmic, quality: Quality) -> Rc<FilmicStage> {
        if quality == Quality::Final {
            return Rc::new(FilmicStage::new(p, None));
        }
        let lut = match &self.filmic {
            Some((cached, stage)) if cached == p => {
                if stage.has_lut() {
                    return stage.clone();
                }
                Some(FILMIC_LUT_SIZE)
            }
            _ => None,
        };
        let stage = Rc::new(FilmicStage::new(p, lut));
        self.filmic = Some((p.clone(), stage.clone()));
        stage
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
