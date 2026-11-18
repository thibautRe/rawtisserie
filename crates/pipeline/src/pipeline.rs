//! The [`Developer`]: one decoded RAW file, rendered as many times as needed.

use crate::decode::{self, RawPhoto};
use crate::demosaic;
use crate::image::{Image, Mask, Region, Rgb, Rgba8};
use crate::metadata::PhotoMetadata;
use crate::output::ColorSpace;
use std::rc::Rc;
use std::sync::Arc;

use crate::lens::LensProfile;

use crate::ops::clut::ClutStore;
use crate::ops::point::{self, FILMIC_LUT_SIZE, FilmicStage, PointOps};
use crate::ops::calibration::{self, Detection};
use crate::ops::clipping::{self, MaskPart, MaskView, Overlays};
use crate::ops::blend::Blend;
use crate::ops::mask::{self, Drawn, MaskPlane, MaskStage};
use crate::ops::primaries::{ColorPrimariesStage, FieldWeights, WeightsKey};
use crate::ops::retouch::{self, Saved, Stamp};
use crate::ops::color_balance;
use crate::ops::tone_curve::{self, InputHistogram, Local};
use crate::ops::lines::{self, GuideLine, Segment};
use crate::ops::perspective::{self, Fit, FitMode, Guide, Perspective};
use crate::ops::diffuse::{DiffuseOp, Planes};
use crate::ops::glow::GlowOp;
use crate::ops::{equalizer, filmic, geometry};
use crate::params::{self, ColorPrimaries, ContrastEqualizer, EditParams, Filmic, Geometry, Glow, Lens, Module, ModuleInstance, ModuleKind};
use crate::Result;

mod denoising;
mod sample;
pub use denoising::{DenoiseJob, DenoiseKey, DenoiseStatus};
pub use sample::{ModuleRead, PixelSample};

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
    /// Render only this part of the fitted image (output pixels, clipped to it), e.g.
    /// what a zoomed-in view shows. Only the photosites under it are developed.
    pub region: Option<Region>,
}

impl RenderSize {
    pub const FULL: RenderSize = RenderSize { max_width: 0, max_height: 0, region: None };

    pub const fn fit(max_width: u32, max_height: u32) -> Self {
        Self { max_width, max_height, region: None }
    }

    /// Only `region` of the fitted image.
    pub const fn with_region(self, region: Region) -> Self {
        Self { region: Some(region), ..self }
    }
}

/// Holds a decoded RAW file plus caches of intermediate images, so that re-rendering
/// with different parameters (e.g. dragging a slider) only re-runs the stages that
/// are affected:
///
/// ```text
///  base        demosaic/bin, reference WB, camera → working       keyed by binning factor
///              then retouch spots, in place                       keyed by the spots and their shapes
///   └ geometry  lens, orientation, straighten, crop, resample    keyed by the above + lens + geometry + output size (3 sizes kept)
///      ├ masks  drawn parts of the instances' masks, feathered    keyed by the above + the masks' shapes and feather
///      └ detail diffuse, equalizer, glow instances keyed by the above + their parameters (and masks) at this scale
///         ├ masks of point modules feathered whole, and of tone   keyed by the above + the point modules before them
///         │ curves preserving detail
///         └ point ops (exposure … tone mapping → sRGB)            always re-run, one fused pass, reading the masks
/// ```
///
/// A mask's drawn part depends only on its shapes and the geometry, so it is cached
/// with the spatial stages and handed to the point operations as planes next to the
/// spatial image ([`spatial`](Developer::spatial)); its parametric part is per pixel.
///
/// A render of a region (a zoomed-in view) develops only the photosites under it, in a
/// "patch" of the base at the region's own binning factor, kept for nearby regions. Its
/// geometry stage renders the region with a margin for the detail stages to read, so
/// that it gives the same pixels as the whole image at that size would.
///
/// Retouching changes the base (or patch) in place, remembering what each spot
/// overwrote: changing the spots puts those pixels back and applies the new ones. A
/// patch covers what the spots touching its region read (`retouch::needed`).
///
/// Clipping indicators are painted on the result when asked for. Sensor clipping
/// needs a mask of saturated photosites, built on demand next to the base and
/// resampled like the geometry stage (cached per slot).
///
/// The detail stages run before exposure, white balance and saturation, so the most-used
/// sliders never invalidate them. Diffuse scales the image to the level its parameters
/// are tuned for (`ops::diffuse`), and the contrast equalizer works on log luminance, so
/// exposure doesn't affect it either.
pub struct Developer {
    /// Shared with [`sibling`](Self::sibling)s.
    photo: Rc<RawPhoto>,
    base: Option<(usize, Image)>,
    /// The spots applied to the base.
    base_retouch: Retouched,
    /// Part of a base image, for region renders.
    patch: Option<Patch>,
    /// Spatial-stage caches per output size (and region), most recently used first.
    /// The interactive case uses a reduced "draft" size while dragging and full size
    /// after; zoomed in, the visible region too.
    slots: Vec<Slot>,
    /// Last id given to a spatial image (see [`spatial_image_id`](Self::spatial_image_id)).
    last_id: u64,
    point_ops: PointOpsCache,
    /// Saturated photosites at the base's resolution, built on demand.
    sensor_clip: Option<(usize, Mask)>,
    /// Outputs of diffuse steps computed elsewhere (see [`next_diffuse_job`](Self::next_diffuse_job)),
    /// by [`diffuse_key`], until a render uses them; most recent last.
    diffused: Vec<(u64, Image)>,
    /// Raw denoise: models, tiles, and the denoised photo (see `denoising.rs`).
    denoising: denoising::Denoising,
}

/// Most diffuse outputs kept for the next render.
const MAX_DIFFUSED: usize = 4;

/// A diffuse step for the caller to compute, one channel at a time if it likes (see
/// [`Developer::next_diffuse_job`]).
#[derive(Clone, Debug)]
pub struct DiffuseJob {
    /// Identifies the step and its input, for [`Developer::provide_diffuse`].
    pub key: u64,
    pub params: params::Diffuse,
    /// Output pixels per full-resolution pixel: with `params`, [`DiffuseOp::new`]'s arguments.
    pub scale: f32,
    pub width: usize,
    pub height: usize,
    /// The step's input, prepared ([`DiffuseOp::prepare`]): diffuse each plane with
    /// [`DiffuseOp::diffuse_plane`].
    pub planes: Planes,
}

/// Point-operation stages compiled for recent parameters, so that dragging one slider
/// doesn't rebuild the tables of the others.
#[derive(Default)]
pub struct PointOpsCache {
    /// Filmic, compiled for the last parameters (and LUTs after it) used interactively.
    filmic: Option<(Filmic, Rc<FilmicStage>)>,
    /// Colour primaries tables used by the last render.
    primaries: Vec<(ColorPrimaries, Rc<ColorPrimariesStage>)>,
    /// What those tables are built from besides the edits, for the last settings used.
    primaries_weights: Option<Rc<FieldWeights>>,
    /// The creative LUTs recipes can use, by id.
    pub luts: ClutStore,
}

/// The point operations alone, over a fixed image: typically one strip of a
/// [`Developer`]'s spatial image, rendered in a worker of a pool.
pub struct PointRenderer {
    image: Image,
    /// The drawn planes of the masks over the same pixels.
    masks: Vec<MaskPlane>,
    as_shot: Option<[f32; 2]>,
    cache: PointOpsCache,
}

impl PointRenderer {
    /// `as_shot`: the photo's as-shot light ([`RawPhoto::as_shot_illuminant`]).
    pub fn new(image: Image, as_shot: Option<[f32; 2]>) -> Self {
        Self::with_masks(image, Vec::new(), as_shot)
    }

    /// With the drawn planes of the masks over `image` (the same rows of
    /// [`Developer::spatial`]'s).
    pub fn with_masks(image: Image, masks: Vec<MaskPlane>, as_shot: Option<[f32; 2]>) -> Self {
        Self { image, masks, as_shot, cache: PointOpsCache::default() }
    }

    /// Work on another strip, keeping the loaded LUTs and compiled stages.
    pub fn set_image(&mut self, image: Image, masks: Vec<MaskPlane>, as_shot: Option<[f32; 2]>) {
        (self.image, self.masks, self.as_shot) = (image, masks, as_shot);
    }

    /// The creative LUTs recipes can use: give it the same ones as the [`Developer`].
    pub fn luts_mut(&mut self) -> &mut ClutStore {
        &mut self.cache.luts
    }

    /// Same pixels as [`Developer::render`] gives for these rows.
    pub fn render(&mut self, params: &EditParams, quality: Quality) -> Rgba8 {
        self.cache.render_ops(params, self.as_shot, quality).render_masked(&self.image, &self.masks)
    }
}

const MAX_SLOTS: usize = 3;
/// Most a region render develops around the region for the detail stages to read (in
/// output pixels): wider blurs and equalizer bands are approximated at its edges. Not
/// a glow's, which would show the regions' seams.
const MAX_PADDING: usize = 1024;

/// A patch extends this fraction of its size past what a region render needs.
const PATCH_MARGIN: usize = 8;

/// `at`, a part of the base image for `factor`.
struct Patch {
    factor: usize,
    at: Region,
    /// Retouched as `retouch` says.
    image: Image,
    retouch: Retouched,
    /// Saturated photosites at the patch's pixels, built on demand.
    sensor_clip: Option<Mask>,
}

/// The retouch spots applied to an image in place, and what they overwrote.
#[derive(Default)]
struct Retouched {
    /// `retouch::key` of the stamps; 0 for none.
    key: u64,
    saved: Vec<Saved>,
}

impl Retouched {
    /// Make `img` (pixels `at` of a `frame`-sized base) retouched with `stamps`.
    fn update(&mut self, img: &mut Image, at: Region, frame: (usize, usize), stamps: &[Stamp], key: u64, scale: f32) {
        if self.key == key {
            return;
        }
        retouch::restore(img, at, std::mem::take(&mut self.saved));
        self.saved = retouch::apply(img, at, frame, stamps, scale);
        self.key = key;
    }
}

/// What the spatial stages give for a render size.
#[derive(Clone, Debug, PartialEq)]
struct Plan {
    /// Size of the whole fitted image.
    frame: (usize, usize),
    scale: f32,
    /// What is rendered: the whole frame, or the region asked for.
    region: Region,
    /// Whether the region's pixels come from a patch rather than the whole base.
    patch: bool,
    /// `region` plus what the detail steps and mask feathering read around it.
    padded: Region,
    steps: Vec<DetailStep>,
    /// The drawn masks of the enabled instances, by id.
    drawn: Vec<(String, Drawn)>,
}

impl Plan {
    /// Whether the geometry stage's output goes through more spatial work: detail steps,
    /// or a crop of the margin around the region.
    fn has_detail(&self) -> bool {
        !self.steps.is_empty() || self.padded != self.region
    }
}

struct Slot {
    frame: (usize, usize),
    region: Region,
    /// Changes whenever the image the spatial stages give for this size does.
    id: u64,
    geometry: Option<(GeometryKey, Image)>,
    /// The drawn masks over `geometry`'s pixels, and the same cropped to `region`
    /// (what the point operations read, unless `point_masks` has more).
    masks: Option<(MasksKey, Vec<MaskPlane>, Vec<MaskPlane>)>,
    detail: Option<Detail>,
    /// With masks of point modules feathered whole: those and the drawn ones, over
    /// `region` (what the point operations read).
    point_masks: Option<(PointMasksKey, Vec<MaskPlane>)>,
    /// `sensor_clip` through the geometry stage.
    sensor_clip: Option<(GeometryKey, Mask)>,
}

#[derive(Clone, Debug, PartialEq)]
struct GeometryKey {
    base_factor: usize,
    /// `retouch::key` of the spots applied to the base.
    retouch: u64,
    transform: geometry::Transform,
    /// The whole fitted image.
    width: usize,
    height: usize,
    /// What is rendered of it.
    region: Region,
}

#[derive(Clone, Debug, PartialEq)]
struct MasksKey {
    geometry: GeometryKey,
    drawn: Vec<(String, Drawn)>,
}

/// The detail stage's output.
struct Detail {
    key: DetailKey,
    /// Over the padded region, when it differs from `image`'s.
    padded: Option<Image>,
    /// Over the region.
    image: Image,
    /// The masks of the masked steps over the region (for the mask overlay).
    step_masks: Vec<MaskPlane>,
}

/// What the masks of point modules feathered whole, and those of tone curves preserving
/// detail, are computed from.
#[derive(Clone, Debug, PartialEq)]
struct PointMasksKey {
    geometry: GeometryKey,
    steps: Vec<DetailStep>,
    drawn: Vec<(String, Drawn)>,
    /// In pipeline order: each one's instance id, the enabled point modules before it,
    /// and what it is.
    masks: Vec<(String, Vec<ModuleInstance>, PointMask)>,
}

/// A plane computed on a point module's input.
#[derive(Clone, Debug, PartialEq)]
enum PointMask {
    /// Its mask, feathered whole.
    Whole(params::Mask),
    /// A tone curve's mask, preserving detail: its statistics (`tone_curve::plane_ids`).
    Tones(Local),
}

#[derive(Clone, Debug, PartialEq)]
struct DetailKey {
    geometry: GeometryKey,
    /// The active detail instances, in pipeline order.
    steps: Vec<DetailStep>,
}

/// A spatial instance, with its parameters at the output size, and its mask.
#[derive(Clone, Debug, PartialEq)]
struct DetailStep {
    op: DetailOp,
    mask: Option<Box<StepMask>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum DetailOp {
    /// `scale`: output pixels per full-resolution pixel.
    Diffuse { params: params::Diffuse, scale: f32 },
    /// `scale`: output pixels per full-resolution pixel.
    Equalizer { params: ContrastEqualizer, scale: f32 },
    /// `scale`: output pixels per full-resolution pixel.
    Glow { params: Glow, scale: f32 },
}

/// The mask of a spatial instance (with its drawn part resolved, so that the key
/// changes with its shapes).
#[derive(Clone, Debug, PartialEq)]
struct StepMask {
    id: String,
    mask: params::Mask,
    drawn: Option<Drawn>,
}

impl PointOpsCache {
    /// The point operations for a render at this quality.
    pub fn render_ops(&mut self, params: &EditParams, as_shot: Option<[f32; 2]>, quality: Quality) -> PointOps {
        let looks = point::looks_of(params, &self.luts);
        let filmic = params.get::<Filmic>().map(|f| self.filmic_stage(f, point::bakeable(&looks), quality));
        self.ops(params, as_shot, filmic)
    }

    /// Final-quality point operations with output to `space` (exports).
    pub fn export_ops(&mut self, params: &EditParams, as_shot: Option<[f32; 2]>, space: ColorSpace) -> PointOps {
        let filmic = params.get::<Filmic>().map(|f| Rc::new(FilmicStage::for_space(f, None, space)));
        self.ops(params, as_shot, filmic).for_space(space)
    }

    /// The point operations, with colour primaries tables from cache when possible.
    fn ops(&mut self, params: &EditParams, as_shot: Option<[f32; 2]>, filmic: Option<Rc<FilmicStage>>) -> PointOps {
        let cache = std::mem::take(&mut self.primaries);
        let mut weights = self.primaries_weights.take();
        let mut used = Vec::new();
        let luts = &self.luts;
        let ops = PointOps::with_stages(params, as_shot, filmic, &mut |p| {
            let stage = match cache.iter().find(|(q, _)| q == p) {
                Some((_, stage)) => stage.clone(),
                None => {
                    // Moving a primary keeps the weights; only gamut coverage and
                    // smoothing rebuild them (~10× the cost of a table).
                    let w = match &weights {
                        Some(w) if w.key() == WeightsKey::of(p) => w.clone(),
                        _ => Rc::new(FieldWeights::new(p)),
                    };
                    // While a slider is dragged, most of the previous table carries over.
                    let prev = cache.iter().map(|(_, s)| &**s).find(|s| s.key() == w.key());
                    let stage = Rc::new(ColorPrimariesStage::update(prev, p, &w));
                    weights = Some(w);
                    stage
                }
            };
            used.push((p.clone(), stage.clone()));
            stage
        }, luts);
        self.primaries = used;
        self.primaries_weights = weights;
        ops
    }

    /// The point operations before filmic of `before` (the modules before an instance):
    /// what gives that instance's input. Colour primaries tables come from cache, and
    /// new ones join it without evicting those of the whole recipe.
    fn input_ops(&mut self, before: &EditParams, as_shot: Option<[f32; 2]>) -> PointOps {
        let cache = &mut self.primaries;
        let mut stage = |p: &ColorPrimaries| match cache.iter().find(|(q, _)| q == p) {
            Some((_, stage)) => stage.clone(),
            None => {
                let stage = Rc::new(ColorPrimariesStage::build(p));
                cache.push((p.clone(), stage.clone()));
                stage
            }
        };
        PointOps::with_stages(before, as_shot, None, &mut stage, &ClutStore::default())
    }

    /// Filmic for interactive renders: computed exactly right after its parameters
    /// change (e.g. while one of its sliders is dragged), then baked into a 3D lookup
    /// table, with the creative LUTs after it, once the same parameters are rendered
    /// again (other sliders, full-size render after a draft…). Choosing other LUTs
    /// isn't a drag: the table is rebuilt at once. `looks`: the LUTs it can hold
    /// ([`point::bakeable`]); dragging a LUT's opacity rebuilds it on every frame, at
    /// the cost of a filmic drag.
    fn filmic_stage(&mut self, p: &Filmic, looks: &[point::Look], quality: Quality) -> Rc<FilmicStage> {
        if quality == Quality::Final {
            return Rc::new(FilmicStage::new(p, None));
        }
        let lut = match &self.filmic {
            Some((cached, stage)) if cached == p => {
                if stage.has_lut() && stage.has_looks(looks) {
                    return stage.clone();
                }
                Some(FILMIC_LUT_SIZE)
            }
            _ => None,
        };
        let stage = Rc::new(FilmicStage::with_looks(p, lut, looks));
        self.filmic = Some((p.clone(), stage.clone()));
        stage
    }
}

impl Developer {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(Self::new(decode::decode(bytes)?))
    }

    pub fn new(photo: RawPhoto) -> Self {
        Self::with_photo(Rc::new(photo))
    }

    fn with_photo(photo: Rc<RawPhoto>) -> Self {
        Self {
            denoising: denoising::Denoising::new(Rc::clone(&photo)),
            photo,
            base: None,
            base_retouch: Retouched::default(),
            patch: None,
            slots: Vec::new(),
            last_id: 0,
            point_ops: PointOpsCache::default(),
            sensor_clip: None,
            diffused: Vec::new(),
        }
    }

    /// Another developer of the same photo, without copying it, with caches of its own:
    /// renders at very different sizes (e.g. thumbnails) there don't evict these. LUTs
    /// aren't shared: load them in each.
    pub fn sibling(&self) -> Developer {
        let mut dev = Self::with_photo(Rc::clone(&self.photo));
        dev.denoising = self.denoising.share();
        dev
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
        self.base_retouch = Retouched::default();
        self.patch = None;
        self.slots.clear();
        self.point_ops = PointOpsCache { luts: std::mem::take(&mut self.point_ops.luts), ..Default::default() };
        self.sensor_clip = None;
    }

    /// The creative LUTs recipes can use (LUT instances whose table isn't there are
    /// skipped). Kept by [`release_cache`](Self::release_cache).
    pub fn luts(&self) -> &ClutStore {
        &self.point_ops.luts
    }

    pub fn luts_mut(&mut self) -> &mut ClutStore {
        &mut self.point_ops.luts
    }

    fn transform(&self, params: &EditParams) -> geometry::Transform {
        let identity = Geometry::default();
        let g = params.get::<Geometry>().unwrap_or(&identity);
        geometry::Transform {
            lens: params.get::<Lens>().and_then(|lens| {
                // Lensfun's profile from the recipe, else the file's embedded one.
                let profile = match &lens.lensfun {
                    Some(lensfun) => Arc::new(LensProfile::from_lensfun(lensfun)),
                    None => Arc::new(self.photo.lens.clone()?),
                };
                Some(geometry::LensChoice { profile, strengths: lens.strengths() })
            }),
            orient: self.photo.orientation.then(g.rotation % 4, g.flip_horizontal),
            angle: g.angle.clamp(-45.0, 45.0),
            perspective: Perspective::new(g, self.focal_length()),
            auto_crop: g.auto_crop,
            crop: g.crop.sanitized(),
        }
    }

    /// The focal length as a multiple of the frame's long side. Files don't record the
    /// sensor size, so it's read as a full-frame one (36 mm across the long side); 28 mm
    /// when it's unknown or too short for full frame (a small sensor's).
    fn focal_length(&self) -> f32 {
        let mm = self.photo.metadata.focal_length.filter(|f| f.is_finite() && *f >= 8.0).unwrap_or(28.0);
        mm as f32 / 36.0
    }

    /// `params` with the geometry reduced to its orientation: the frame perspective
    /// guides are detected and fitted in.
    fn unwarped(params: &EditParams) -> EditParams {
        let g = params.get::<Geometry>().cloned().unwrap_or_default();
        let mut plain = params.clone();
        *plain.get_mut::<Geometry>() = Geometry { rotation: g.rotation, flip_horizontal: g.flip_horizontal, ..Geometry::default() };
        plain
    }

    /// Straight lines for perspective correction, detected on the image before
    /// straightening and perspective (oriented, lens-corrected, uncropped) as rendered
    /// within `size`. Endpoints are in the sensor frame (normalised), as shapes'.
    pub fn detect_lines(&mut self, params: &EditParams, size: RenderSize) -> Vec<Segment> {
        self.sync_source(params);
        let plain = Self::unwarped(params);
        let (width, height, scale) = self.output_size(&plain, size);
        let transform = self.transform(&plain);
        self.ensure_base(Self::binning(scale));
        let (_, base) = self.base.as_ref().expect("base was just built");
        let img = geometry::apply(base, &transform, width, height);
        let found = lines::detect(&img, self.focal_length() * width.max(height) as f32, 0.04 * width.max(height) as f32);
        let mapping = self.sensor_mapping(&plain);
        let to_sensor = |p: (f32, f32)| mapping.to_sensor(p.0 / width as f32, p.1 / height as f32);
        found.into_iter().map(|s| Segment { a: to_sensor(s.a), b: to_sensor(s.b), ..s }).collect()
    }

    /// Fit the perspective correction (and the straighten angle) to guide lines, whose
    /// endpoints are in the sensor frame (normalised): see [`perspective::fit`].
    pub fn fit_perspective(&self, params: &EditParams, guides: &[GuideLine], mode: FitMode) -> Option<Fit> {
        let plain = Self::unwarped(params);
        let mapping = self.sensor_mapping(&plain);
        let (ow, oh) = self.transform(&plain).oriented_size(self.photo.width as f32, self.photo.height as f32);
        let centred = |p: (f32, f32)| {
            let (x, y) = mapping.from_sensor(p.0, p.1);
            (((x - 0.5) * ow) as f64, ((y - 0.5) * oh) as f64)
        };
        let guides: Vec<Guide> = guides.iter().map(|g| Guide { a: centred(g.a), b: centred(g.b), vertical: g.vertical }).collect();
        perspective::fit(&guides, mode, (self.focal_length() * ow.max(oh)) as f64)
    }

    /// Maps points between the output frame of `params` and the sensor frame, where
    /// shapes live (both normalised).
    pub fn sensor_mapping(&self, params: &EditParams) -> geometry::SensorMapping {
        geometry::SensorMapping::new(&self.transform(params), self.photo.width as f32, self.photo.height as f32)
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

    /// The part of the [`output_size`](Self::output_size) image that a render within
    /// `size` gives: its region, clipped (at least one pixel), or all of it.
    pub fn output_region(&self, params: &EditParams, size: RenderSize) -> Region {
        let (width, height, _) = self.output_size(params, size);
        clip_region(size.region, width, height)
    }

    fn plan(&self, params: &EditParams, size: RenderSize) -> Plan {
        let (width, height, scale) = self.output_size(params, size);
        let region = clip_region(size.region, width, height);
        let steps = detail_steps(params, scale);
        let drawn = mask::drawn_masks(params);
        let patch = size.region.is_some();
        let padding = if patch {
            let detail = steps.iter().map(|s| s.margin((width, height))).sum::<usize>();
            let whole = params.modules.iter().filter(|m| m.enabled).filter_map(mask::active).filter(|m| m.feathers_whole());
            let whole = whole.map(|m| mask::feather_margin(m.feather, m.edge_aware, scale));
            let tones = params.modules.iter().filter(|m| m.enabled).filter_map(|m| Local::of(<params::ToneCurve as params::ModuleParams>::get(&m.module)?));
            let tones = tones.map(|l| l.reach((width, height)));
            let feather = drawn.iter().map(|(_, d)| d.margin(scale)).chain(whole).chain(tones).max().unwrap_or(0);
            let padding = (detail + feather).next_multiple_of(32);
            // Light from past the margin would be missing from a glow, unevenly from one
            // region to the next: a wide one gets all it reaches, up to the whole frame.
            let wide_glow = steps.iter().any(|s| matches!(s.op, DetailOp::Glow { .. }) && s.margin((width, height)) > MAX_PADDING);
            if wide_glow { padding } else { padding.min(MAX_PADDING) }
        } else {
            0
        };
        let padded = region.padded(padding, width, height);
        Plan { frame: (width, height), scale, region, patch, padded, steps, drawn }
    }

    /// Binning factor of the base or patch the geometry stage reads for `plan`: whole
    /// renders reuse the base within a range of sizes; region renders use their own.
    fn plan_factor(&self, plan: &Plan) -> Option<usize> {
        if plan.patch { Some(Self::binning(plan.scale)) } else { self.base_factor_for(plan.scale) }
    }
    pub fn render(&mut self, params: &EditParams, size: RenderSize, quality: Quality) -> Rgba8 {
        self.sync_source(params);
        let ops = self.point_ops.render_ops(params, self.photo.as_shot_illuminant, quality);
        let (_, img, masks) = self.spatial(params, size);
        ops.render_masked(img, masks)
    }

    /// Final-quality point operations with output to `space`, for [`spatial`](Self::spatial)'s
    /// image (see [`crate::export`]).
    pub fn export_ops(&mut self, params: &EditParams, space: ColorSpace) -> PointOps {
        self.point_ops.export_ops(params, self.photo.as_shot_illuminant, space)
    }

    /// [`render`](Self::render), with clipping indicators painted on top.
    pub fn render_with_overlays(&mut self, params: &EditParams, size: RenderSize, quality: Quality, overlays: &Overlays) -> Rgba8 {
        self.sync_source(params);
        let mut img = self.render(params, size, quality);
        self.paint_overlays(params, size, &mut img, overlays);
        img
    }

    /// Paint clipping indicators (and the mask overlay) on a render of `params` within `size`.
    pub fn paint_overlays(&mut self, params: &EditParams, size: RenderSize, img: &mut Rgba8, overlays: &Overlays) {
        self.sync_source(params);
        if let Some(id) = overlays.mask.as_deref() {
            self.paint_mask_view(params, id, size, overlays.mask_view, img);
        }
        if let Some(view) = &overlays.tone_curve {
            self.paint_tone_curve_view(params, view, size, img);
        }
        if let Some(view) = &overlays.tone_range {
            self.paint_tone_range_view(params, view, size, img);
        }
        let (_, frame_height, _) = self.output_size(params, size);
        let region = self.output_region(params, size);
        let sensor = overlays.sensor.then(|| self.sensor_clip_mask(params, size));
        clipping::paint_region(img, overlays, sensor, region, frame_height);
    }

    /// Output pixels that contain saturated photosites, from cache when possible.
    pub fn sensor_clip_mask(&mut self, params: &EditParams, size: RenderSize) -> &Mask {
        self.sync_source(params);
        let plan = self.plan(params, size);
        let (width, height) = plan.frame;
        // Builds the base and selects this size's slot, as for a render.
        self.spatial_image(params, size);
        let transform = self.transform(params);

        if plan.patch {
            let factor = Self::binning(plan.scale);
            let base = demosaic::base_size(&self.photo, factor);
            let gkey = GeometryKey { base_factor: factor, retouch: 0, transform: transform.clone(), width, height, region: plan.region };
            if self.slots[0].sensor_clip.as_ref().map(|(k, _)| k) != Some(&gkey) {
                // The slot's geometry may come from cache, built from another patch.
                let bounds = geometry::source_bounds(base, &transform, width, height, plan.region);
                self.ensure_patch(factor, bounds);
                let patch = self.patch.as_mut().expect("patch was just built");
                let src = patch.sensor_clip.get_or_insert_with(|| demosaic::clipped_photosites_region(&self.photo, factor, patch.at));
                let mask = geometry::apply_mask_region(src, patch.at, base, &transform, width, height, plan.region);
                self.slots[0].sensor_clip = Some((gkey, mask));
            }
            return &self.slots[0].sensor_clip.as_ref().expect("mask was just built").1;
        }

        let base_factor = self.base.as_ref().expect("base was just built").0;
        let gkey = GeometryKey { base_factor, retouch: 0, transform, width, height, region: plan.region };
        if self.sensor_clip.as_ref().map(|(f, _)| *f) != Some(base_factor) {
            self.sensor_clip = Some((base_factor, demosaic::clipped_photosites(&self.photo, base_factor)));
            for slot in &mut self.slots {
                slot.sensor_clip = None;
            }
        }
        let base_mask = &self.sensor_clip.as_ref().expect("mask was just built").1;
        let slot = &mut self.slots[0];
        if slot.sensor_clip.as_ref().map(|(k, _)| k) != Some(&gkey) {
            let mask = geometry::apply_mask(base_mask, &gkey.transform, width, height);
            slot.sensor_clip = Some((gkey, mask));
        }
        &slot.sensor_clip.as_ref().expect("mask was just built").1
    }

    /// The output of the spatial stages (geometry, diffuse, equalizer, glow), from cache when possible.
    pub fn spatial_image(&mut self, params: &EditParams, size: RenderSize) -> &Image {
        self.sync_source(params);
        self.spatial(params, size).1
    }

    /// Whether [`spatial_image`](Self::spatial_image) would come from cache, i.e. a
    /// render would only re-run the point operations.
    pub fn is_spatial_cached(&self, params: &EditParams, size: RenderSize) -> bool {
        if self.source_changes(params) {
            return false;
        }
        let plan = self.plan(params, size);
        let Some(base_factor) = self.plan_factor(&plan) else { return false };
        let (width, height) = plan.frame;
        let retouch = retouch::key(&retouch::stamps(params));
        let gkey = GeometryKey { base_factor, retouch, transform: self.transform(params), width, height, region: plan.padded };
        let Some(slot) = self.slots.iter().find(|s| s.frame == plan.frame && s.region == plan.region) else { return false };
        if slot.geometry.as_ref().map(|(k, _)| k) != Some(&gkey) {
            return false;
        }
        let masks = slot.masks.as_ref().map(|(k, ..)| k);
        if masks.map_or(!plan.drawn.is_empty(), |k| k.geometry != gkey || k.drawn != plan.drawn) {
            return false;
        }
        if plan.has_detail() && !slot.detail.as_ref().is_some_and(|d| d.key.geometry == gkey && d.key.steps == plan.steps) {
            return false;
        }
        slot.point_masks.as_ref().map(|(k, _)| k) == point_masks_key(params, &plan, gkey).as_ref()
    }

    /// [`spatial_image`](Self::spatial_image), with an id that changes whenever the
    /// image does (so copies of it elsewhere can tell when they are stale).
    pub fn spatial_image_id(&mut self, params: &EditParams, size: RenderSize) -> (u64, &Image) {
        self.sync_source(params);
        let (id, img, _) = self.spatial(params, size);
        (id, img)
    }

    /// [`spatial_image_id`](Self::spatial_image_id), with the drawn planes of the
    /// enabled instances' masks over its pixels (by instance id): what the point
    /// operations read. The id changes whenever either does.
    pub fn spatial(&mut self, params: &EditParams, size: RenderSize) -> (u64, &Image, &[MaskPlane]) {
        self.sync_source(params);
        let (plan, gkey, inner, mut changed) = self.prepare_slot(params, size);
        let pkey = point_masks_key(params, &plan, gkey.clone());
        let diffused = &mut self.diffused;
        let slot = &mut self.slots[0];
        if !plan.has_detail() {
            changed |= slot.detail.take().is_some();
        } else {
            let dkey = DetailKey { geometry: gkey.clone(), steps: plan.steps.clone() };
            if slot.detail.as_ref().map(|d| &d.key) != Some(&dkey) {
                let img = slot.geometry.as_ref().expect("geometry was just built").1.clone();
                let planes = &slot.masks.as_ref().expect("masks were just built").1;
                let origin = (plan.padded.x, plan.padded.y);
                // Diffuse steps computed elsewhere are used (and dropped), the rest computed here.
                let diffuse = |i: usize, p: &params::Diffuse, scale: f32, input: &Image| {
                    let key = diffuse_key(&gkey, &plan, i);
                    Some(match diffused.iter().position(|(k, _)| *k == key) {
                        Some(at) => diffused.remove(at).1,
                        None => {
                            let mut out = input.clone();
                            DiffuseOp::new(p, scale).apply(&mut out, origin);
                            out
                        }
                    })
                };
                let (img, step_masks) = detail_pass(img, &dkey.steps, &plan, planes, inner, diffuse).expect("every step is computed");
                let (padded, image) = if plan.padded != plan.region { (Some(img.clone()), img.crop(inner)) } else { (None, img) };
                slot.detail = Some(Detail { key: dkey, padded, image, step_masks });
                changed = true;
            }
        }

        if slot.point_masks.as_ref().map(|(k, _)| k) != pkey.as_ref() {
            slot.point_masks = None;
            if let Some(key) = pkey {
                let planes = self.point_masks(&key, &plan, inner, params);
                self.slots[0].point_masks = Some((key, planes));
            }
            changed = true;
        }
        if changed {
            self.last_id += 1;
            self.slots[0].id = self.last_id;
        }
        let (img, masks) = self.output();
        (self.slots[0].id, img, masks)
    }

    /// Make the most recent slot the one for `params` at `size`, with its geometry stage
    /// and drawn mask planes built: the plan, the geometry key, the region within the
    /// padded render, and whether anything was rebuilt (the slot's id then changes).
    fn prepare_slot(&mut self, params: &EditParams, size: RenderSize) -> (Plan, GeometryKey, Region, bool) {
        let plan = self.plan(params, size);
        let base_factor = if plan.patch { Self::binning(plan.scale) } else { self.ensure_base(Self::binning(plan.scale)) };
        let (width, height) = plan.frame;
        let stamps = retouch::stamps(params);
        let retouch = retouch::key(&stamps);
        let gkey = GeometryKey { base_factor, retouch, transform: self.transform(params), width, height, region: plan.padded };

        // Pick (or create) the cache slot for this output size, and make it the most recent.
        let slot = match self.slots.iter().position(|s| s.frame == plan.frame && s.region == plan.region) {
            Some(i) => self.slots.remove(i),
            None => {
                self.last_id += 1;
                Slot { frame: plan.frame, region: plan.region, id: self.last_id, geometry: None, masks: None, detail: None, point_masks: None, sensor_clip: None }
            }
        };
        self.slots.insert(0, slot);
        self.slots.truncate(MAX_SLOTS);
        let mut changed = false;

        if self.slots[0].geometry.as_ref().map(|(k, _)| k) != Some(&gkey) {
            let slot = &mut self.slots[0];
            slot.detail = None;
            slot.masks = None;
            slot.geometry = None; // free before allocating
            let img = self.geometry_stage(&gkey, plan.patch, &stamps);
            self.slots[0].geometry = Some((gkey.clone(), img));
            changed = true;
        }

        // The region within the padded render.
        let (r, p) = (plan.region, plan.padded);
        let inner = Region { x: r.x - p.x, y: r.y - p.y, ..r };

        let mkey = MasksKey { geometry: gkey.clone(), drawn: plan.drawn.clone() };
        if self.slots[0].masks.as_ref().map(|(k, ..)| k) != Some(&mkey) {
            // Planes whose shapes didn't change are kept (one mask is edited at a time).
            let old = self.slots[0].masks.take().filter(|(k, ..)| k.geometry == gkey);
            let reuse = |id: &str, drawn: &Drawn| {
                let (k, planes, _) = old.as_ref()?;
                let at = k.drawn.iter().position(|(i, d)| i == id && d == drawn)?;
                Some(planes[at].alpha.clone())
            };
            let guide = &self.slots[0].geometry.as_ref().expect("geometry was just built").1;
            let planes: Vec<MaskPlane> = mkey
                .drawn
                .iter()
                .map(|(id, drawn)| MaskPlane { id: id.clone(), alpha: reuse(id, drawn).unwrap_or_else(|| self.drawn_plane(drawn, &plan, &gkey.transform, guide)) })
                .collect();
            let cropped = if inner == Region::full(p.width, p.height) { planes.clone() } else { planes.iter().map(|m| m.crop(p.width, inner)).collect() };
            // Masked detail steps read them, but their key holds their drawn parts:
            // the detail stage only runs again if those changed.
            self.slots[0].masks = Some((mkey, planes, cropped));
            changed = true;
        }
        if changed {
            self.last_id += 1;
            self.slots[0].id = self.last_id;
        }
        (plan, gkey, inner, changed)
    }

    /// The next diffuse step a render of `params` at `size` would compute, for the caller
    /// to compute instead (and hand back with [`provide_diffuse`](Self::provide_diffuse)):
    /// the browser diffuses its three channels on separate workers. `None` when the
    /// spatial stages are cached or every diffuse step has been provided. Steps are given
    /// in order: each one's input is the output of those before it.
    pub fn next_diffuse_job(&mut self, params: &EditParams, size: RenderSize) -> Option<DiffuseJob> {
        self.sync_source(params);
        let plan = self.plan(params, size);
        let last = plan.steps.iter().rposition(|s| matches!(s.op, DetailOp::Diffuse { .. }))?;
        if self.is_spatial_cached(params, size) {
            return None;
        }
        let (plan, gkey, inner, _) = self.prepare_slot(params, size);
        let missing = (0..=last).find(|&i| {
            matches!(plan.steps[i].op, DetailOp::Diffuse { .. }) && !self.diffused.iter().any(|(k, _)| *k == diffuse_key(&gkey, &plan, i))
        })?;
        let slot = &self.slots[0];
        let img = slot.geometry.as_ref().expect("geometry was just built").1.clone();
        let planes = &slot.masks.as_ref().expect("masks were just built").1;
        let origin = (plan.padded.x, plan.padded.y);
        let mut job = None;
        // Run the steps before it (diffuse steps, all provided: diffuse comes first) to get
        // its input.
        let diffused = &self.diffused;
        detail_pass(img, &plan.steps[..=missing], &plan, planes, inner, |i, p, scale, input| {
            let key = diffuse_key(&gkey, &plan, i);
            if let Some((_, out)) = diffused.iter().find(|(k, _)| *k == key) {
                return Some(out.clone());
            }
            let planes = DiffuseOp::new(p, scale).prepare(input, origin);
            job = Some(DiffuseJob { key, params: *p, scale, width: input.width, height: input.height, planes });
            None
        });
        job
    }

    /// The diffused planes of [`next_diffuse_job`](Self::next_diffuse_job)'s `key`, for
    /// the next render to use.
    pub fn provide_diffuse(&mut self, key: u64, width: usize, height: usize, planes: &[Vec<f32>; 3]) {
        let mut img = Image::new(width, height);
        DiffuseOp::finish(&mut img, planes);
        self.diffused.retain(|(k, _)| *k != key);
        self.diffused.push((key, img));
        if self.diffused.len() > MAX_DIFFUSED {
            self.diffused.remove(0);
        }
    }

    /// The most recent slot's spatial image and the planes the point operations read.
    fn output(&self) -> (&Image, &[MaskPlane]) {
        let slot = &self.slots[0];
        let img = match &slot.detail {
            Some(d) => &d.image,
            None => &slot.geometry.as_ref().expect("geometry was built").1,
        };
        let masks = match &slot.point_masks {
            Some((_, planes)) => planes,
            None => &slot.masks.as_ref().expect("masks were built").2,
        };
        (img, masks)
    }

    /// The masks of the point modules feathered whole and of the tone curves preserving
    /// detail (`key`), in pipeline order, each computed on its input (the padded spatial
    /// image through the point modules before it), the former feathered steered by it;
    /// with the other drawn planes, cropped to `inner`.
    fn point_masks(&mut self, key: &PointMasksKey, plan: &Plan, inner: Region, params: &EditParams) -> Vec<MaskPlane> {
        let slot = &self.slots[0];
        let img = match &slot.detail {
            Some(d) => d.padded.as_ref().unwrap_or(&d.image),
            None => &slot.geometry.as_ref().expect("geometry was built").1,
        };
        let mut planes = slot.masks.as_ref().expect("masks were built").1.clone();
        for (id, before, m) in &key.masks {
            let before = EditParams { version: params.version, modules: before.clone(), shapes: params.shapes.clone() };
            let ops = self.point_ops.input_ops(&before, self.photo.as_shot_illuminant);
            let m = match m {
                PointMask::Whole(m) => m,
                PointMask::Tones(local) => {
                    // Its statistics read the input at samples only.
                    let (origin, size) = ((plan.padded.x, plan.padded.y), (img.width, img.height));
                    let Some(samples) = local.samples(origin, size, plan.frame) else { continue };
                    let pick = |v: &[f32]| samples.rows.iter().flat_map(|&y| samples.cols.iter().map(move |&x| v[y * img.width + x])).collect();
                    let sampled = Image {
                        width: samples.cols.len(),
                        height: samples.rows.len(),
                        pixels: samples.rows.iter().flat_map(|&y| samples.cols.iter().map(move |&x| img.pixels[y * img.width + x])).collect(),
                    };
                    let sampled_planes: Vec<MaskPlane> = planes.iter().map(|q| MaskPlane { id: q.id.clone(), alpha: pick(&q.alpha) }).collect();
                    let input = ops.adjust_image(&sampled, &sampled_planes);
                    let stats = local.stats(&samples, &input, origin, size);
                    for (id, alpha) in tone_curve::plane_ids(id).into_iter().zip(stats) {
                        planes.push(MaskPlane { id, alpha });
                    }
                    continue;
                }
            };
            let input = ops.adjust_image(img, &planes);
            let at = planes.iter().position(|q| &q.id == id);
            let stage = MaskStage::parametric(m);
            let mut values: Vec<f32> = input.iter().enumerate().map(|(k, px)| stage.eval(*px, at.map_or(1.0, |i| planes[i].alpha[k]))).collect();
            let guide = Image { width: img.width, height: img.height, pixels: input };
            mask::feather(&mut values, &guide, m.feather, m.edge_aware, plan.scale);
            let plane = MaskPlane { id: id.clone(), alpha: values };
            match at {
                Some(i) => planes[i] = plane,
                None => planes.push(plane),
            }
        }
        let (w, h) = (img.width, img.height);
        if inner == Region::full(w, h) { planes } else { planes.iter().map(|q| q.crop(w, inner)).collect() }
    }

    /// A drawn mask over `plan`'s padded region: rasterised in the sensor frame at the
    /// render's scale, through the geometry, feathered (steered by `guide`, the
    /// geometry stage's output over the same pixels).
    fn drawn_plane(&self, drawn: &Drawn, plan: &Plan, transform: &geometry::Transform, guide: &Image) -> Vec<f32> {
        let (width, height) = plan.frame;
        let frame = mask::raster_frame((self.photo.width, self.photo.height), plan.scale);
        let bounds = geometry::source_bounds(frame, transform, width, height, plan.padded);
        let mut plane = match mask::rasterize(drawn, frame, bounds) {
            Some((at, alpha)) => geometry::apply_plane_region(&alpha, at, frame, transform, width, height, plan.padded),
            None => vec![0.0; plan.padded.width * plan.padded.height],
        };
        mask::feather(&mut plane, guide, drawn.feather, drawn.edge_aware, plan.scale);
        plane
    }

    /// Paint what `view` shows of instance `id`'s mask on `img`, a render of `params`
    /// within `size`: where it (or one of its ranges alone) applies, in yellow, or the
    /// values a range measures on the instance's input, in its slider's colours.
    fn paint_mask_view(&mut self, params: &EditParams, id: &str, size: RenderSize, view: MaskView, img: &mut Rgba8) {
        if view.part == MaskPart::Mask && !view.values {
            if let Some(values) = self.mask_values(params, id, size) {
                clipping::paint_mask(img, &values);
            }
            return;
        }
        let Some(input) = self.module_input(params, id, size) else { return };
        if view.values {
            let colors = mask::ValueColors::new();
            let paint: Vec<[u8; 3]> = match view.part {
                MaskPart::Mask | MaskPart::Luminance => input.iter().map(|c| colors.luminance(*c)).collect(),
                MaskPart::Saturation => input.iter().map(|c| colors.saturation(*c)).collect(),
                MaskPart::Hue => input.iter().map(|c| colors.hue(*c)).collect(),
                MaskPart::Red | MaskPart::Green | MaskPart::Blue => {
                    let i = view.part as usize - MaskPart::Red as usize;
                    input.iter().map(|c| colors.channel(*c, i)).collect()
                }
            };
            clipping::paint_colors(img, &paint);
            return;
        }
        let Some(mask) = params.modules.iter().find(|m| m.id == id).and_then(|m| m.mask.as_ref()) else { return };
        let only = |part: MaskPart, r: Option<[f32; 4]>| (view.part == part).then_some(r).flatten();
        let alone = params::Mask {
            luminance: only(MaskPart::Luminance, mask.luminance),
            saturation: only(MaskPart::Saturation, mask.saturation),
            hue: only(MaskPart::Hue, mask.hue),
            red: only(MaskPart::Red, mask.red),
            green: only(MaskPart::Green, mask.green),
            blue: only(MaskPart::Blue, mask.blue),
            ..params::Mask::default()
        };
        if alone.has_ranges() {
            let stage = MaskStage::new(&alone, false);
            clipping::paint_mask(img, &input.iter().map(|c| stage.eval(*c, 1.0)).collect::<Vec<_>>());
        }
    }

    /// The input of instance `id` (of a maskable kind) over a render of `params` within
    /// `size`: for a point module, the spatial image through the point modules before
    /// it; for a spatial one, the spatial image (approximately its input).
    fn module_input(&mut self, params: &EditParams, id: &str, size: RenderSize) -> Option<Vec<Rgb>> {
        let at = params.modules.iter().position(|m| m.id == id)?;
        let kind = params.modules[at].module.kind();
        if !kind.maskable() {
            return None;
        }
        let as_shot = self.photo.as_shot_illuminant;
        self.spatial(params, size);
        if kind < ModuleKind::Exposure {
            return Some(self.output().0.pixels.clone());
        }
        let before = EditParams { version: params.version, modules: params.modules[..at].to_vec(), shapes: params.shapes.clone() };
        let ops = self.point_ops.input_ops(&before, as_shot);
        let (img, masks) = self.output();
        Some(ops.adjust_image(img, masks))
    }

    /// The mask of instance `id` over a render of `params` within `size`, 0 … 1 per
    /// pixel, as the instance applies it (measured on its input). `None` unless the
    /// instance is enabled with a mask (one that selects everything gives all 1s).
    pub fn mask_values(&mut self, params: &EditParams, id: &str, size: RenderSize) -> Option<Vec<f32>> {
        self.sync_source(params);
        let at = params.modules.iter().position(|m| m.id == id)?;
        let instance = &params.modules[at];
        if !instance.enabled || !instance.module.kind().maskable() {
            return None;
        }
        let Some(m) = mask::active(instance).cloned() else {
            instance.mask.as_ref()?;
            let r = self.output_region(params, size);
            return Some(vec![1.0; r.width * r.height]);
        };
        let drawn = Drawn::of(params, &m).is_some();
        let stage = MaskStage::new(&m, drawn);
        let kind = instance.module.kind();
        let as_shot = self.photo.as_shot_illuminant;
        let spatial = kind < ModuleKind::Exposure;
        self.spatial(params, size);
        // A point module's input: the point modules before it.
        let before = EditParams { version: params.version, modules: params.modules[..at].to_vec(), shapes: params.shapes.clone() };
        let ops = (!spatial).then(|| self.point_ops.input_ops(&before, as_shot));
        let (img, masks) = self.output();
        if spatial {
            // Kept by the detail stage, when the step is active.
            let slot = &self.slots[0];
            if let Some(values) = slot.detail.as_ref().and_then(|d| d.step_masks.iter().find(|q| q.id == id)) {
                return Some(values.alpha.clone());
            }
            // The step is inactive (it would change nothing): measured on the spatial image.
            // A mask feathered whole shows unfeathered there.
            let stage = if m.feathers_whole() { MaskStage::new(&params::Mask { feather: 0.0, ..m.clone() }, drawn) } else { stage };
            let plane = masks.iter().find(|q| q.id == id);
            return Some(img.pixels.iter().enumerate().map(|(k, px)| stage.eval(*px, plane.map_or(1.0, |q| q.alpha[k]))).collect());
        }
        let input = ops.expect("built for point modules").adjust_image(img, masks);
        let plane = masks.iter().find(|q| q.id == id);
        Some(input.iter().enumerate().map(|(k, px)| stage.eval(*px, if stage.drawn { plane.map_or(0.0, |q| q.alpha[k]) } else { 1.0 })).collect())
    }

    /// Run the geometry stage for `key`, from the whole base or from a patch, retouched
    /// with `stamps` (whose key `key` has).
    fn geometry_stage(&mut self, key: &GeometryKey, patch: bool, stamps: &[Stamp]) -> Image {
        let scale = 1.0 / key.base_factor as f32;
        if !patch {
            let (factor, base) = self.base.as_mut().expect("base was just built");
            let frame = (base.width, base.height);
            self.base_retouch.update(base, Region::full(frame.0, frame.1), frame, stamps, key.retouch, 1.0 / *factor as f32);
            return geometry::apply(base, &key.transform, key.width, key.height);
        }
        let base = demosaic::base_size(&self.photo, key.base_factor);
        let bounds = geometry::source_bounds(base, &key.transform, key.width, key.height, key.region);
        // With what the spots changing those pixels read.
        let bounds = retouch::needed(stamps, base, scale, bounds);
        self.ensure_patch(key.base_factor, bounds);
        let patch = self.patch.as_mut().expect("patch was just built");
        patch.retouch.update(&mut patch.image, patch.at, base, stamps, key.retouch, scale);
        geometry::apply_region(&patch.image, patch.at, base, &key.transform, key.width, key.height, key.region)
    }

    /// Make sure the patch covers `bounds` of the base image for `factor`.
    fn ensure_patch(&mut self, factor: usize, bounds: Region) {
        if self.patch.as_ref().is_some_and(|p| p.factor == factor && p.at.contains(&bounds)) {
            return;
        }
        self.patch = None; // free before allocating
        // With room around, so that panning a little doesn't develop it again.
        let (width, height) = demosaic::base_size(&self.photo, factor);
        let at = bounds.padded(bounds.width.max(bounds.height) / PATCH_MARGIN, width, height);
        let image = demosaic::develop_base_region(&self.photo, factor, at);
        self.patch = Some(Patch { factor, at, image, retouch: Retouched::default(), sensor_clip: None });
    }

    /// Binning factor for a render at `scale`: as much as possible while keeping the
    /// base at least as large as the output.
    fn binning(scale: f32) -> usize {
        ((1.0 / scale).floor() as usize).clamp(1, 64)
    }

    /// The factor of the cached base, if [`ensure_base`](Self::ensure_base) would keep it.
    fn base_factor_for(&self, scale: f32) -> Option<usize> {
        let factor = Self::binning(scale);
        self.base.as_ref().map(|(f, _)| *f).filter(|&f| f <= factor && factor <= f * 4)
    }

    /// Filmic auto-tune on the current image (after crop and the adjustments that
    /// precede filmic). Returns `(white_exposure, black_exposure)`, or `None` without
    /// an enabled filmic instance or anything to measure.
    pub fn auto_tune_filmic(&mut self, params: &EditParams, size: RenderSize) -> Option<(f32, f32)> {
        self.sync_source(params);
        let scaling = params.get::<Filmic>()?.dynamic_range_scaling;
        let ops = self.point_ops.ops(params, self.photo.as_shot_illuminant, None);
        let (_, img, masks) = self.spatial(params, size);
        filmic::auto_tune(ops.adjust_image(img, masks).into_iter(), scaling)
    }

    /// Estimate the scene's light on the input of colour calibration instance `id` (the
    /// image after the modules before it), as Ansel's auto-detection does. Returns its
    /// xy chromaticity, or `None` without such an instance or anything to measure.
    pub fn detect_illuminant(&mut self, params: &EditParams, id: &str, size: RenderSize, method: Detection) -> Option<[f32; 2]> {
        self.sync_source(params);
        let at = params.modules.iter().position(|m| m.id == id && m.module.kind() == ModuleKind::ColorCalibration)?;
        let before = EditParams { version: params.version, modules: params.modules[..at].to_vec(), shapes: params.shapes.clone() };
        let ops = self.point_ops.ops(&before, self.photo.as_shot_illuminant, None);
        // The spatial modules all come before calibration: same image, from cache.
        let (_, img, masks) = self.spatial(params, size);
        let input = Image { width: img.width, height: img.height, pixels: ops.adjust_image(img, masks) };
        calibration::detect_illuminant(&input, |px| px, method)
    }

    /// Paint what tone curve instance `view.id` reads on its input over `img`, a render
    /// of `params` within `size` (see [`tone_curve::view_colors`]).
    fn paint_tone_curve_view(&mut self, params: &EditParams, view: &clipping::ToneCurveView, size: RenderSize, img: &mut Rgba8) {
        let Some(instance) = params.modules.iter().find(|m| m.id == view.id) else { return };
        let Some(p) = <params::ToneCurve as params::ModuleParams>::get(&instance.module).cloned() else { return };
        let Some(input) = self.module_input(params, &view.id, size) else { return };
        let mask = self.tone_mask(&p, &view.id, &input);
        if input.len() == img.width * img.height {
            clipping::paint_colors(img, &tone_curve::view_colors(&p, &input, mask.as_deref(), view.channel.unwrap_or(0), view.node));
        }
    }

    /// Paint where one range of colour balance instance `view.id` applies on `img`, a
    /// render of `params` within `size`: the range's weight on the instance's input.
    fn paint_tone_range_view(&mut self, params: &EditParams, view: &clipping::ToneRangeView, size: RenderSize, img: &mut Rgba8) {
        let Some(instance) = params.modules.iter().find(|m| m.id == view.id) else { return };
        let Some(p) = <params::ColorBalance as params::ModuleParams>::get(&instance.module).cloned() else { return };
        let Some(input) = self.module_input(params, &view.id, size) else { return };
        if input.len() == img.width * img.height {
            let range = view.range.min(2);
            let weights: Vec<f32> = input.iter().map(|c| color_balance::range_weights(&p, crate::color::luminance(*c))[range]).collect();
            clipping::paint_mask(img, &weights);
        }
    }

    /// What tone curve instance `id` reads on its input (the image after the modules
    /// before it, over a render of `params` within `size`), and the range of its nodes
    /// that fits it. `None` without such an instance or anything to measure.
    pub fn tone_curve_input(&mut self, params: &EditParams, id: &str, size: RenderSize) -> Option<InputHistogram> {
        self.sync_source(params);
        let instance = params.modules.iter().find(|m| m.id == id)?;
        let p = <params::ToneCurve as params::ModuleParams>::get(&instance.module)?.clone();
        let input = self.module_input(params, id, size)?;
        let mask = self.tone_mask(&p, id, &input);
        tone_curve::measure(&p, &input, mask.as_deref())
    }

    /// The mask tone curve instance `id` (`p`) reads when it preserves detail, over its
    /// `input` in the last render (with its statistics from there).
    fn tone_mask(&self, p: &params::ToneCurve, id: &str, input: &[Rgb]) -> Option<Vec<f32>> {
        let local = Local::of(p)?;
        let masks = self.output().1;
        let plane = |id: &str| masks.iter().find(|q| q.id == id).map(|q| q.alpha.as_slice());
        let [mean, var] = tone_curve::plane_ids(id);
        let stats = plane(&mean).zip(plane(&var)).map(|(m, v)| [m, v]);
        Some(local.mask(input, stats))
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

/// `region` within a `width × height` image, at least one pixel; all of it without one.
fn clip_region(region: Option<Region>, width: usize, height: usize) -> Region {
    let Some(r) = region else { return Region::full(width, height) };
    let mut r = r.clipped(width, height);
    if r.width == 0 {
        r = Region { x: r.x.min(width - 1), width: 1, ..r };
    }
    if r.height == 0 {
        r = Region { y: r.y.min(height - 1), height: 1, ..r };
    }
    r
}

/// What the masks of the point modules feathered whole depend on, or `None` without any.
fn point_masks_key(params: &EditParams, plan: &Plan, geometry: GeometryKey) -> Option<PointMasksKey> {
    let is_point = |m: &ModuleInstance| m.enabled && m.module.kind() >= ModuleKind::Exposure;
    // What a mask is measured on: a LUT's, on filmic's input.
    let is_before_filmic = |m: &ModuleInstance| is_point(m) && m.module.kind() < ModuleKind::Filmic;
    let masks: Vec<_> = params
        .modules
        .iter()
        .enumerate()
        .filter(|(_, m)| is_point(m))
        .flat_map(|(i, m)| {
            let before = move || params.modules[..i].iter().filter(|b| is_before_filmic(b)).cloned().collect::<Vec<_>>();
            // Invert, opacity and the blend apply afterwards, per pixel.
            let whole = mask::active(m).filter(|mask| mask.feathers_whole()).map(|mask| PointMask::Whole(params::Mask { invert: false, opacity: 1.0, ..mask.selection() }));
            // Even with flat curves, for the histogram and the overlay.
            let tones = <params::ToneCurve as params::ModuleParams>::get(&m.module).and_then(Local::of).map(PointMask::Tones);
            [whole, tones].into_iter().flatten().map(move |p| (m.id.clone(), before(), p))
        })
        .collect();
    (!masks.is_empty()).then(|| PointMasksKey { geometry, steps: plan.steps.clone(), drawn: plan.drawn.clone(), masks })
}

impl DetailStep {
    /// How much of the render around a region the step needs for the region's pixels.
    fn margin(&self, frame: (usize, usize)) -> usize {
        match self.op {
            DetailOp::Equalizer { params, scale } => equalizer::margin(&params, scale, frame),
            DetailOp::Glow { params, scale } => GlowOp::new(&params, scale).reach(),
            DetailOp::Diffuse { params, scale } => DiffuseOp::new(&params, scale).reach(),
        }
    }
}

/// The detail `steps` of `plan` on `img` (the geometry stage's output, over the padded
/// region), each blended through its mask, and the masks' values over the region
/// (`inner` within the padded render). A diffuse step's output comes from `diffuse`
/// (its index in `steps`, parameters, scale and input), which may stop the pass (`None`).
fn detail_pass(
    mut img: Image,
    steps: &[DetailStep],
    plan: &Plan,
    planes: &[MaskPlane],
    inner: Region,
    mut diffuse: impl FnMut(usize, &params::Diffuse, f32, &Image) -> Option<Image>,
) -> Option<(Image, Vec<MaskPlane>)> {
    let mut step_masks = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let before = step.mask.as_ref().map(|_| img.clone());
        match step.op {
            DetailOp::Equalizer { params, scale } => equalizer::apply_in_frame(&mut img, &params, scale, plan.frame),
            DetailOp::Glow { params, scale } => GlowOp::new(&params, scale).apply(&mut img, (plan.padded.x, plan.padded.y)),
            DetailOp::Diffuse { params, scale } => img = diffuse(i, &params, scale, &img)?,
        }
        if let (Some(m), Some(before)) = (&step.mask, before) {
            // The mask is measured on the step's input.
            let plane = planes.iter().find(|q| q.id == m.id).map(|q| q.alpha.as_slice());
            let values = if m.mask.feathers_whole() {
                let stage = MaskStage::parametric(&m.mask);
                let mut v: Vec<f32> = before.pixels.iter().enumerate().map(|(k, px)| stage.eval(*px, plane.map_or(1.0, |q| q[k]))).collect();
                mask::feather(&mut v, &before, m.mask.feather, m.mask.edge_aware, plan.scale);
                v.into_iter().map(|a| stage.finish(a)).collect()
            } else {
                let stage = MaskStage::new(&m.mask, m.drawn.is_some());
                let drawn = |k: usize| if stage.drawn { plane.map_or(0.0, |q| q[k]) } else { 1.0 };
                before.pixels.iter().enumerate().map(|(k, px)| stage.eval(*px, drawn(k))).collect::<Vec<f32>>()
            };
            let mut out = before.pixels;
            Blend::scene(&m.mask).mix_all(&mut out, &img.pixels, &values);
            img.pixels = out;
            step_masks.push(MaskPlane { id: m.id.clone(), alpha: values }.crop(plan.padded.width, inner));
        }
    }
    Some((img, step_masks))
}

/// Identifies the output of `plan`'s detail step `i` (a diffuse step): the geometry
/// stage's output it starts from, the render's frame and padded region, and the steps
/// up to it (with their masks).
fn diffuse_key(gkey: &GeometryKey, plan: &Plan, i: usize) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    format!("{gkey:?} {:?} {:?} {:?}", plan.frame, plan.padded, &plan.steps[..=i]).hash(&mut h);
    h.finish()
}

/// The active diffuse, equalizer and glow instances, with their parameters at `scale`
/// (spatial parameters are expressed in full-resolution pixels) and their masks.
fn detail_steps(params: &EditParams, scale: f32) -> Vec<DetailStep> {
    params
        .modules
        .iter()
        .filter(|m| m.enabled)
        .filter_map(|m| {
            let op = match &m.module {
                Module::ContrastEqualizer(e) => DetailOp::Equalizer { params: *e, scale },
                Module::Glow(g) => DetailOp::Glow { params: *g, scale },
                Module::Diffuse(d) => DetailOp::Diffuse { params: *d, scale },
                _ => return None,
            };
            let active = match op {
                DetailOp::Equalizer { params, .. } => !params.is_identity(),
                DetailOp::Glow { params, scale } => GlowOp::new(&params, scale).active(),
                DetailOp::Diffuse { params, scale } => DiffuseOp::new(&params, scale).active(),
            };
            let mask = mask::active(m).map(|mask| Box::new(StepMask { id: m.id.clone(), mask: mask.clone(), drawn: Drawn::of(params, mask) }));
            active.then_some(DetailStep { op, mask })
        })
        .collect()
}

