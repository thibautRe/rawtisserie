//! WebAssembly bindings for the RAWtisserie pipeline.
//!
//! The same `.wasm` module is used by the browser developer (inside a Web Worker)
//! and by the Node server to render thumbnails headlessly. Edit parameters and
//! metadata cross the boundary as JSON strings; pixels as byte arrays.

use rawtisserie_pipeline::frame::Frame;
use rawtisserie_pipeline::ops::clipping::Overlays;
use rawtisserie_pipeline::{self as pipeline, EditParams, Quality, Region, RenderSize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Fitted within `max_width × max_height`; `region` (`[x, y, width, height]`, output
/// pixels) renders only that part of it, e.g. a zoomed-in view.
fn render_size(max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<RenderSize, JsError> {
    let size = RenderSize::fit(max_width, max_height);
    match region.as_deref() {
        None => Ok(size),
        Some(&[x, y, width, height]) => Ok(size.with_region(pipeline::Region {
            x: x as usize,
            y: y as usize,
            width: width as usize,
            height: height as usize,
        })),
        Some(_) => Err(JsError::new("a region is [x, y, width, height]")),
    }
}

/// A diffuse step to compute elsewhere (`Developer.nextDiffuseJob`): its three channels,
/// prepared, each to diffuse with `diffusePlane`.
#[wasm_bindgen]
pub struct DiffuseJob {
    inner: pipeline::DiffuseJob,
}

#[wasm_bindgen]
impl DiffuseJob {
    /// For `Developer.provideDiffuse` (a u64, as a decimal string).
    #[wasm_bindgen(getter)]
    pub fn key(&self) -> String {
        self.inner.key.to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height as u32
    }

    /// The step's parameters (`Diffuse`, JSON), for `diffusePlane`.
    #[wasm_bindgen(getter)]
    pub fn params(&self) -> String {
        serde_json::to_string(&self.inner.params).expect("params serialise")
    }

    /// Output pixels per full-resolution pixel, for `diffusePlane`.
    #[wasm_bindgen(getter)]
    pub fn scale(&self) -> f32 {
        self.inner.scale
    }

    /// Channel `c` (0 … 2), taken out of the job.
    #[wasm_bindgen(js_name = takePlane)]
    pub fn take_plane(&mut self, c: usize) -> Result<Vec<f32>, JsError> {
        let plane = self.inner.planes.planes.get_mut(c).ok_or_else(|| JsError::new("a channel is 0, 1 or 2"))?;
        Ok(std::mem::take(plane))
    }

    /// The inpainting mask (1 inside), if the step has one.
    #[wasm_bindgen(getter)]
    pub fn mask(&self) -> Option<Vec<u8>> {
        self.inner.planes.mask.as_ref().map(|m| m.iter().map(|&b| b as u8).collect())
    }
}

/// Diffuse one channel of a `DiffuseJob` (its `params`, `scale`, size and `mask`): the
/// same as the developer would.
#[wasm_bindgen(js_name = diffusePlane)]
pub fn diffuse_plane(params_json: &str, scale: f32, width: u32, height: u32, mut plane: Vec<f32>, mask: Option<Vec<u8>>) -> Result<Vec<f32>, JsError> {
    let params: pipeline::params::Diffuse = serde_json::from_str(params_json).map_err(js_err)?;
    let (width, height) = (width as usize, height as usize);
    if plane.len() != width * height || mask.as_ref().is_some_and(|m| m.len() != plane.len()) {
        return Err(JsError::new("the plane (and mask) have width × height values"));
    }
    let mask: Option<Vec<bool>> = mask.map(|m| m.into_iter().map(|v| v != 0).collect());
    pipeline::ops::diffuse::DiffuseOp::new(&params, scale).diffuse_plane(&mut plane, mask.as_deref(), width, height);
    Ok(plane)
}

/// What a stored denoised photo for this recipe is named by (`DenoiseKey::name`), or
/// undefined without raw denoise. For the TS tests (`denoiseKeyName` mirrors it).
#[wasm_bindgen(js_name = denoiseKeyName)]
pub fn denoise_key_name(params_json: &str) -> Result<Option<String>, JsError> {
    let params = EditParams::from_json(params_json).map_err(js_err)?;
    Ok(pipeline::pipeline::DenoiseKey::of(&params).map(|(k, s)| k.name(s)))
}

/// A raw denoise model, loaded once in a denoise worker: runs the tiles the pipeline
/// worker's developer hands out (`Developer.nextDenoiseTile`).
#[wasm_bindgen]
pub struct DenoiseRunner {
    model: pipeline::nn::Model,
}

#[wasm_bindgen]
impl DenoiseRunner {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<DenoiseRunner, JsError> {
        Ok(Self { model: pipeline::nn::Model::from_bytes(bytes).map_err(js_err)? })
    }

    /// Denoises a tile at full strength: `core` is `[x, y, width, height]`, `planes`
    /// the tile's input (`DenoiseTile.takePlanes`), `noise` `[a0, a1, a2, b0, b1, b2,
    /// scale0, scale1, scale2]`. Returns the tile's photosites.
    pub fn run(&self, core: &[u32], size: u32, xtrans: bool, noise: &[f32], planes: Vec<f32>) -> Result<Vec<f32>, JsError> {
        let [x, y, width, height] = <[u32; 4]>::try_from(core).map_err(|_| JsError::new("core is [x, y, width, height]"))?.map(|v| v as usize);
        let noise = <[f32; 9]>::try_from(noise).map_err(|_| JsError::new("noise is [a×3, b×3, scale×3]"))?;
        let input = pipeline::denoise::TileInput {
            core: Region { x, y, width, height },
            size: size as usize,
            planes,
            xtrans,
            profile: pipeline::denoise::NoiseProfile { a: [noise[0], noise[1], noise[2]], b: [noise[3], noise[4], noise[5]], matched: true },
            scale: [noise[6], noise[7], noise[8]],
        };
        pipeline::denoise::run_tile(&self.model, input).ok_or_else(|| JsError::new("this tile isn't for this model"))
    }
}

/// A tile to denoise (`Developer.nextDenoiseTile`), for a `DenoiseRunner`.
#[wasm_bindgen]
pub struct DenoiseTile {
    job: Option<pipeline::pipeline::DenoiseJob>,
    core: [u32; 4],
}

#[wasm_bindgen]
impl DenoiseTile {
    /// Which settings it's for: give it back to `provideDenoiseTile`.
    #[wasm_bindgen(getter)]
    pub fn key(&self) -> u64 {
        self.job.as_ref().map_or(0, |j| j.key)
    }

    /// The model's id.
    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String {
        self.job.as_ref().map(|j| j.model.clone()).unwrap_or_default()
    }

    /// `[x, y, width, height]` on the sensor.
    #[wasm_bindgen(getter)]
    pub fn core(&self) -> Vec<u32> {
        self.core.to_vec()
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.job.as_ref().map_or(0, |j| j.input.size as u32)
    }

    #[wasm_bindgen(getter)]
    pub fn xtrans(&self) -> bool {
        self.job.as_ref().is_some_and(|j| j.input.xtrans)
    }

    /// `[a0, a1, a2, b0, b1, b2, scale0, scale1, scale2]`.
    #[wasm_bindgen(getter)]
    pub fn noise(&self) -> Vec<f32> {
        self.job.as_ref().map_or_else(Vec::new, |j| {
            let i = &j.input;
            [i.profile.a, i.profile.b, i.scale].concat()
        })
    }

    /// The input planes. Moves them out.
    #[wasm_bindgen(js_name = takePlanes)]
    pub fn take_planes(&mut self) -> Vec<f32> {
        self.job.as_mut().map(|j| std::mem::take(&mut j.input.planes)).unwrap_or_default()
    }
}

/// Read metadata (EXIF, dimensions…) without decoding the sensor data. Returns JSON.
#[wasm_bindgen(js_name = readMetadata)]
pub fn read_metadata(bytes: &[u8]) -> Result<String, JsError> {
    let meta = pipeline::metadata::read(bytes).map_err(js_err)?;
    serde_json::to_string(&meta).map_err(js_err)
}

/// The default edit parameters, as JSON.
#[wasm_bindgen(js_name = defaultParams)]
pub fn default_params() -> String {
    serde_json::to_string(&EditParams::default()).expect("params serialise")
}

/// The recipe a new image starts with, given its metadata (JSON), as JSON.
#[wasm_bindgen(js_name = defaultRecipe)]
pub fn default_recipe(metadata_json: &str) -> Result<String, JsError> {
    let metadata: pipeline::PhotoMetadata = serde_json::from_str(metadata_json).map_err(js_err)?;
    serde_json::to_string(&EditParams::default_for(&metadata)).map_err(js_err)
}

/// Layout of a `width × height` image in a frame (`Frame` JSON):
/// `[width, height, x, y, lineOffset, lineWidth]`.
#[wasm_bindgen(js_name = frameLayout)]
pub fn frame_layout(frame_json: &str, width: u32, height: u32) -> Result<Vec<u32>, JsError> {
    let frame: Frame = serde_json::from_str(frame_json).map_err(js_err)?;
    let l = frame.layout(width as usize, height as usize);
    Ok([l.width, l.height, l.x, l.y, l.line_offset, l.line_width].map(|v| v as u32).to_vec())
}

/// Export options and metadata (`ExportOptions`, `ExportMetadata` JSON) as Rust reads
/// them, as JSON: `[options, metadata]`. For the TS tests.
#[wasm_bindgen(js_name = normalizeExport)]
pub fn normalize_export(options_json: &str, metadata_json: &str) -> Result<Vec<String>, JsError> {
    let options: pipeline::export::ExportOptions = serde_json::from_str(options_json).map_err(js_err)?;
    let metadata: pipeline::export::ExportMetadata = serde_json::from_str(metadata_json).map_err(js_err)?;
    Ok(vec![serde_json::to_string(&options).map_err(js_err)?, serde_json::to_string(&metadata).map_err(js_err)?])
}

/// A recipe of any version, migrated to the current one and normalised, as JSON.
#[wasm_bindgen(js_name = normalizeParams)]
pub fn normalize_params(params_json: &str) -> Result<String, JsError> {
    let params = EditParams::from_json(params_json).map_err(js_err)?;
    serde_json::to_string(&params).map_err(js_err)
}

/// A creative LUT file (`.cube`, Hald CLUT PNG, or the packed form), decoded.
#[wasm_bindgen]
pub struct ParsedLut {
    id: String,
    size: u32,
    bit_depth: u8,
    packed: Vec<u8>,
}

#[wasm_bindgen]
impl ParsedLut {
    /// SHA-256 of the canonical form, lowercase hex: what recipes refer to.
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    /// Nodes along each axis.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.size
    }

    #[wasm_bindgen(getter, js_name = bitDepth)]
    pub fn bit_depth(&self) -> u8 {
        self.bit_depth
    }

    /// The packed form: what gets uploaded, stored and loaded into renderers. Moves it out.
    #[wasm_bindgen(js_name = takePacked)]
    pub fn take_packed(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.packed)
    }
}

/// Decode a LUT file, to check it and get its id and packed form.
#[wasm_bindgen(js_name = parseLut)]
pub fn parse_lut(bytes: &[u8]) -> Result<ParsedLut, JsError> {
    let lut = pipeline::ops::clut::Clut::parse(bytes).map_err(js_err)?;
    Ok(ParsedLut { id: lut.id().to_owned(), size: lut.size() as u32, bit_depth: lut.bit_depth(), packed: lut.to_packed() })
}

#[wasm_bindgen]
pub struct RenderedImage {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl RenderedImage {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// RGBA8 pixels, ready for `new ImageData(...)`. Moves the buffer out.
    #[wasm_bindgen(js_name = takeData)]
    pub fn take_data(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.data)
    }
}

/// A decoded RAW file that can be rendered repeatedly with different parameters.
#[wasm_bindgen]
pub struct Developer {
    inner: pipeline::Developer,
    /// For `renderThumbnail`, created on first use.
    thumbnails: Option<pipeline::Developer>,
    /// LUTs loaded for thumbnails only (`loadThumbnailLut`).
    thumbnail_luts: pipeline::ops::clut::ClutStore,
}

#[wasm_bindgen]
impl Developer {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<Developer, JsError> {
        Ok(Self {
            inner: pipeline::Developer::from_bytes(bytes).map_err(js_err)?,
            thumbnails: None,
            thumbnail_luts: Default::default(),
        })
    }

    /// Metadata of the decoded file, as JSON.
    #[wasm_bindgen(js_name = metadata)]
    pub fn metadata(&self) -> Result<String, JsError> {
        serde_json::to_string(self.inner.metadata()).map_err(js_err)
    }

    /// Where the photo is sharp (`focus::FocusMap`, roadmap 8.9), as JSON. Takes a
    /// fraction of a second: measured on the sensor data, whatever the recipe.
    #[wasm_bindgen(js_name = focusMap)]
    pub fn focus_map(&self) -> Result<String, JsError> {
        serde_json::to_string(&rawtisserie_pipeline::focus::measure(self.inner.photo())).map_err(js_err)
    }

    /// `[width, height]` of the image fitted within these bounds (0 = unbounded): with
    /// no bounds, the size of the (cropped) image at full resolution.
    #[wasm_bindgen(js_name = outputSize)]
    pub fn output_size(&self, params_json: &str, max_width: u32, max_height: u32) -> Result<Vec<u32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let (w, h, _) = self.inner.output_size(&params, RenderSize::fit(max_width, max_height));
        Ok(vec![w as u32, h as u32])
    }

    /// `[x, y, width, height]` of the fitted image that `render` gives with this
    /// region: the region, clipped to the image.
    #[wasm_bindgen(js_name = outputRegion)]
    pub fn output_region(&self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<Vec<u32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let r = self.inner.output_region(&params, render_size(max_width, max_height, region)?);
        Ok([r.x, r.y, r.width, r.height].map(|v| v as u32).to_vec())
    }

    /// Interactive render to RGBA8, fitted within `max_width × max_height` (0 = unbounded),
    /// or only `region` of that (see `outputRegion`).
    /// May use approximations that are invisible in practice; see `Quality`.
    /// `overlays_json` selects clipping indicators (`Overlays`; `"{}"` for none).
    pub fn render(&mut self, params_json: &str, max_width: u32, max_height: u32, overlays_json: &str, region: Option<Vec<u32>>) -> Result<RenderedImage, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let overlays: Overlays = serde_json::from_str(overlays_json).map_err(js_err)?;
        let img = self.inner.render_with_overlays(&params, render_size(max_width, max_height, region)?, Quality::Interactive, &overlays);
        Ok(RenderedImage {
            width: img.width as u32,
            height: img.height as u32,
            data: img.data,
        })
    }

    /// A small final-quality render (menu previews of presets and styles), from a
    /// developer of the same photo with caches of its own: tiny renders would otherwise
    /// evict the base image the interactive ones use. It has the LUTs loaded here and
    /// those loaded for it (`loadThumbnailLut`).
    #[wasm_bindgen(js_name = renderThumbnail)]
    pub fn render_thumbnail(&mut self, params_json: &str, max_width: u32, max_height: u32) -> Result<RenderedImage, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let thumbnails = self.thumbnails.get_or_insert_with(|| self.inner.sibling());
        let luts = thumbnails.luts_mut();
        *luts = self.inner.luts().clone();
        luts.extend(&self.thumbnail_luts);
        let img = thumbnails.render(&params, RenderSize::fit(max_width, max_height), Quality::Final);
        Ok(RenderedImage {
            width: img.width as u32,
            height: img.height as u32,
            data: img.data,
        })
    }

    /// Whether a render of these parameters within these bounds (and region, as for
    /// `render`) would only re-run the point operations (the spatial stages' output is cached).
    /// The colour picker: pixel `(x, y)` (in the whole frame, as `outputRegion` counts)
    /// of the render of these parameters within these bounds and region, as JSON
    /// (`PixelSample`), or undefined outside the region or without the spatial stages'
    /// output cached, unless `warm` (then they run, as for a render).
    pub fn sample(&mut self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>, x: u32, y: u32, warm: bool) -> Result<Option<String>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let size = render_size(max_width, max_height, region)?;
        let sample = self.inner.sample(&params, size, x as usize, y as usize, warm);
        sample.map(|s| serde_json::to_string(&s).map_err(js_err)).transpose()
    }

    #[wasm_bindgen(js_name = isSpatialCached)]
    pub fn is_spatial_cached(&self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<bool, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        Ok(self.inner.is_spatial_cached(&params, render_size(max_width, max_height, region)?))
    }

    /// The next diffuse step a render of these parameters (and region, as for `render`)
    /// would compute, to diffuse its channels on other workers (`diffusePlane`) and hand
    /// back with `provideDiffuse`; undefined when there's none left to compute.
    #[wasm_bindgen(js_name = nextDiffuseJob)]
    pub fn next_diffuse_job(&mut self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<Option<DiffuseJob>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        Ok(self.inner.next_diffuse_job(&params, render_size(max_width, max_height, region)?).map(|inner| DiffuseJob { inner }))
    }

    /// A `DiffuseJob`'s three planes, diffused, for the next render to use.
    #[wasm_bindgen(js_name = provideDiffuse)]
    pub fn provide_diffuse(&mut self, key: &str, width: u32, height: u32, red: Vec<f32>, green: Vec<f32>, blue: Vec<f32>) -> Result<(), JsError> {
        let key: u64 = key.parse().map_err(js_err)?;
        let n = width as usize * height as usize;
        if [&red, &green, &blue].iter().any(|p| p.len() != n) {
            return Err(JsError::new("a plane has width × height values"));
        }
        self.inner.provide_diffuse(key, width as usize, height as usize, &[red, green, blue]);
        Ok(())
    }

    /// Build (or reuse) the spatial stages' output (of the region, as for `render`):
    /// `[id, width, height]`. The id changes whenever the image does.
    #[wasm_bindgen(js_name = spatialInfo)]
    pub fn spatial_info(&mut self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<Vec<f64>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let (id, img) = self.inner.spatial_image_id(&params, render_size(max_width, max_height, region)?);
        Ok(vec![id as f64, img.width as f64, img.height as f64])
    }

    /// Rows `y0..y1` of the spatial stages' output, as interleaved linear RGB.
    #[wasm_bindgen(js_name = spatialRows)]
    pub fn spatial_rows(&mut self, params_json: &str, max_width: u32, max_height: u32, y0: u32, y1: u32, region: Option<Vec<u32>>) -> Result<Vec<f32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.spatial_image(&params, render_size(max_width, max_height, region)?);
        let (y0, y1) = ((y0 as usize).min(img.height), (y1 as usize).min(img.height));
        Ok(img.pixels[y0 * img.width..y1.max(y0) * img.width].iter().flatten().copied().collect())
    }

    /// The ids of the masks whose drawn planes come with the spatial stages' output (of
    /// the region, as for `render`), as a JSON array: the order of `spatialMaskRows`.
    #[wasm_bindgen(js_name = spatialMaskIds)]
    pub fn spatial_mask_ids(&mut self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<String, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let (_, _, masks) = self.inner.spatial(&params, render_size(max_width, max_height, region)?);
        serde_json::to_string(&masks.iter().map(|m| &m.id).collect::<Vec<_>>()).map_err(js_err)
    }

    /// Rows `y0..y1` of those planes, one after the other (0 … 1 per pixel for masks;
    /// linear values for a tone curve's mask statistics).
    #[wasm_bindgen(js_name = spatialMaskRows)]
    pub fn spatial_mask_rows(&mut self, params_json: &str, max_width: u32, max_height: u32, y0: u32, y1: u32, region: Option<Vec<u32>>) -> Result<Vec<f32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let (_, img, masks) = self.inner.spatial(&params, render_size(max_width, max_height, region)?);
        let (y0, y1) = ((y0 as usize).min(img.height), (y1 as usize).min(img.height));
        Ok(masks.iter().flat_map(|m| m.alpha[y0 * img.width..y1.max(y0) * img.width].iter().copied()).collect())
    }

    /// How points map between the output frame of these parameters and the sensor frame
    /// (`SensorMappingData`), as JSON: what the editor needs to draw shapes.
    #[wasm_bindgen(js_name = sensorMapping)]
    pub fn sensor_mapping(&self, params_json: &str) -> Result<String, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        serde_json::to_string(&self.inner.sensor_mapping(&params).data()).map_err(js_err)
    }

    /// The xy chromaticity of the as-shot light, or an empty array if unknown.
    #[wasm_bindgen(js_name = asShotIlluminant)]
    pub fn as_shot_illuminant(&self) -> Vec<f32> {
        self.inner.photo().as_shot_illuminant.map(Vec::from).unwrap_or_default()
    }

    /// Paint clipping indicators (`Overlays` JSON) on an RGBA8 render of these
    /// parameters within these bounds (and region, as for `render`), in place.
    #[wasm_bindgen(js_name = paintOverlays)]
    pub fn paint_overlays(&mut self, params_json: &str, max_width: u32, max_height: u32, data: &mut [u8], width: u32, height: u32, overlays_json: &str, region: Option<Vec<u32>>) -> Result<(), JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let overlays: Overlays = serde_json::from_str(overlays_json).map_err(js_err)?;
        let mut img = pipeline::Rgba8 { width: width as usize, height: height as usize, data: data.to_vec() };
        self.inner.paint_overlays(&params, render_size(max_width, max_height, region)?, &mut img, &overlays);
        data.copy_from_slice(&img.data);
        Ok(())
    }

    /// Final-quality render within `max_width × max_height` (or only `region` of it, as
    /// for `render`), as RGBA8 pixels (sRGB, opaque): the library's renders, encoded by
    /// the server (AVIF, roadmap 7.11).
    #[wasm_bindgen(js_name = renderFinal)]
    pub fn render_final(&mut self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<RenderedImage, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.render(&params, render_size(max_width, max_height, region)?, Quality::Final);
        Ok(RenderedImage { width: img.width as u32, height: img.height as u32, data: img.data })
    }

    /// Final-quality render within `max_width × max_height` (or only `region` of it, as
    /// for `render`), encoded as a JPEG file (sRGB, no metadata): the culling loupe's
    /// zoomed-in tiles.
    #[wasm_bindgen(js_name = renderJpeg)]
    pub fn render_jpeg(&mut self, params_json: &str, max_width: u32, max_height: u32, quality: u8, region: Option<Vec<u32>>) -> Result<Vec<u8>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.render(&params, render_size(max_width, max_height, region)?, Quality::Final);
        pipeline::encode::jpeg(&img, quality).map_err(js_err)
    }

    /// An export: `ExportOptions` JSON (format, colour space, size, frame…) and
    /// `ExportMetadata` JSON (what goes in the file's EXIF and XMP). Returns the file.
    #[wasm_bindgen(js_name = renderExport)]
    pub fn render_export(&mut self, params_json: &str, options_json: &str, metadata_json: &str) -> Result<Vec<u8>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let options: pipeline::export::ExportOptions = serde_json::from_str(options_json).map_err(js_err)?;
        let metadata: pipeline::export::ExportMetadata = serde_json::from_str(metadata_json).map_err(js_err)?;
        pipeline::export::render(&mut self.inner, &params, &options, &metadata).map_err(js_err)
    }

    /// Filmic auto-tune on the image as rendered at this size: `[white, black]`
    /// relative exposures in EV, or an empty array if nothing could be measured.
    #[wasm_bindgen(js_name = autoTuneFilmic)]
    pub fn auto_tune_filmic(&mut self, params_json: &str, max_width: u32, max_height: u32) -> Result<Vec<f32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let result = self.inner.auto_tune_filmic(&params, RenderSize::fit(max_width, max_height));
        Ok(result.map(|(w, b)| vec![w, b]).unwrap_or_default())
    }

    /// Colour calibration's illuminant auto-detection, on the input of instance `id` as
    /// rendered at this size. `method` is `"surfaces"` or `"edges"`. Returns the light's
    /// `[x, y]` chromaticity, or an empty array if nothing could be measured.
    #[wasm_bindgen(js_name = detectIlluminant)]
    pub fn detect_illuminant(&mut self, params_json: &str, id: &str, max_width: u32, max_height: u32, method: &str) -> Result<Vec<f32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let method = serde_json::from_value(serde_json::Value::String(method.into())).map_err(js_err)?;
        let result = self.inner.detect_illuminant(&params, id, RenderSize::fit(max_width, max_height), method);
        Ok(result.map(Vec::from).unwrap_or_default())
    }

    /// What tone curve instance `id` reads on its input, as rendered at this size:
    /// `[fitLow, fitHigh, count, ...bins]`: the range that fits it, then `count`
    /// histograms over `HISTOGRAM_RANGE` (one per curve in use) one after the other; or
    /// an empty array if nothing could be measured.
    #[wasm_bindgen(js_name = toneCurveInput)]
    pub fn tone_curve_input(&mut self, params_json: &str, id: &str, max_width: u32, max_height: u32) -> Result<Vec<f32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let result = self.inner.tone_curve_input(&params, id, RenderSize::fit(max_width, max_height));
        Ok(result.map(|h| [h.fit.as_slice(), &[h.bins.len() as f32], &h.bins.concat()].concat()).unwrap_or_default())
    }

    /// Straight lines for perspective guides, detected on the image before straightening
    /// and perspective as rendered at this size: a JSON array of `{a, b, vertical,
    /// selected}`, endpoints `[x, y]` in the sensor frame (normalised).
    #[wasm_bindgen(js_name = detectLines)]
    pub fn detect_lines(&mut self, params_json: &str, max_width: u32, max_height: u32) -> Result<String, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        serde_json::to_string(&self.inner.detect_lines(&params, RenderSize::fit(max_width, max_height))).map_err(js_err)
    }

    /// The perspective correction that straightens guide lines (a JSON array of `{a, b,
    /// vertical}` as `detectLines` gives) in `mode` (`vertical`, `horizontal` or `both`):
    /// `{angle, vertical, horizontal, shear}` as JSON, or `null` without enough lines.
    #[wasm_bindgen(js_name = fitPerspective)]
    pub fn fit_perspective(&self, params_json: &str, lines_json: &str, mode: &str) -> Result<String, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let lines: Vec<pipeline::ops::lines::GuideLine> = serde_json::from_str(lines_json).map_err(js_err)?;
        let mode = serde_json::from_value(serde_json::Value::String(mode.into())).map_err(js_err)?;
        serde_json::to_string(&self.inner.fit_perspective(&params, &lines, mode)).map_err(js_err)
    }

    /// Free the cached demosaiced image (it is rebuilt on the next render).
    /// A developer for a denoised photo kept by `denoisedFile`, without its RAW file.
    #[wasm_bindgen(js_name = fromDenoisedFile)]
    pub fn from_denoised_file(bytes: &[u8]) -> Result<Developer, JsError> {
        let (_, inner) = pipeline::Developer::from_denoised_file(bytes).map_err(js_err)?;
        Ok(Self { inner, thumbnails: None, thumbnail_luts: Default::default() })
    }

    /// The RAW file, for a developer opened from a denoised file whose recipe changed.
    #[wasm_bindgen(js_name = setOriginal)]
    pub fn set_original(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.set_original(bytes).map_err(js_err)
    }

    /// Whether it has the RAW file's samples (not only a denoised file's).
    #[wasm_bindgen(js_name = hasOriginal)]
    pub fn has_original(&self) -> bool {
        self.inner.has_original()
    }

    #[wasm_bindgen(js_name = loadDenoiseModel)]
    pub fn load_denoise_model(&mut self, id: &str, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.load_denoise_model(id, bytes).map_err(js_err)
    }

    #[wasm_bindgen(js_name = hasDenoiseModel)]
    pub fn has_denoise_model(&self, id: &str) -> bool {
        self.inner.has_denoise_model(id)
    }

    /// Where the recipe's raw denoise stands, as JSON: `{ "state": "off" | "unsupported"
    /// | "needsModel" | "needsOriginal" | "pending" | "ready", "model"?, "done"?, "total"? }`,
    /// plus `profileMatched` (whether the camera has a noise profile).
    #[wasm_bindgen(js_name = denoiseStatus)]
    pub fn denoise_status(&self, params_json: &str) -> Result<String, JsError> {
        use pipeline::pipeline::DenoiseStatus as S;
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let m = self.inner.metadata();
        let matched = pipeline::denoise::noise_profile(m.make.as_deref(), m.model.as_deref(), m.iso).matched;
        let status = match self.inner.denoise_status(&params) {
            S::Off => serde_json::json!({ "state": "off" }),
            S::Unsupported => serde_json::json!({ "state": "unsupported" }),
            S::NeedsModel(model) => serde_json::json!({ "state": "needsModel", "model": model }),
            S::NeedsOriginal => serde_json::json!({ "state": "needsOriginal" }),
            S::Pending { done, total } => serde_json::json!({ "state": "pending", "done": done, "total": total }),
            S::Ready => serde_json::json!({ "state": "ready" }),
        };
        let mut status = status;
        status["profileMatched"] = matched.into();
        Ok(status.to_string())
    }

    /// The next tile to denoise, nearest the sensor point (`focusX`, `focusY`),
    /// normalised; undefined when none is left to hand out.
    #[wasm_bindgen(js_name = nextDenoiseTile)]
    pub fn next_denoise_tile(&mut self, params_json: &str, focus_x: f32, focus_y: f32) -> Result<Option<DenoiseTile>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let focus = (focus_x.is_finite() && focus_y.is_finite()).then_some((focus_x.clamp(0.0, 1.0), focus_y.clamp(0.0, 1.0)));
        Ok(self.inner.next_denoise_tile(&params, focus).map(|job| {
            let c = job.input.core;
            DenoiseTile { core: [c.x as u32, c.y as u32, c.width as u32, c.height as u32], job: Some(job) }
        }))
    }

    /// A tile's result, or none if it failed (it's handed out again).
    #[wasm_bindgen(js_name = provideDenoiseTile)]
    pub fn provide_denoise_tile(&mut self, key: u64, core: &[u32], values: Option<Vec<f32>>) -> Result<(), JsError> {
        let [x, y, width, height] = <[u32; 4]>::try_from(core).map_err(|_| JsError::new("core is [x, y, width, height]"))?.map(|v| v as usize);
        self.inner.provide_denoise_tile(key, Region { x, y, width, height }, values);
        Ok(())
    }

    /// Denoises what's left here and now (no denoise workers).
    #[wasm_bindgen(js_name = denoiseNow)]
    pub fn denoise_now(&mut self, params_json: &str) -> Result<(), JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        self.inner.denoise_now(&params);
        Ok(())
    }

    /// The denoised photo as a file to keep, once the recipe's raw denoise is ready.
    #[wasm_bindgen(js_name = denoisedFile)]
    pub fn denoised_file(&mut self, params_json: &str) -> Result<Option<Vec<u8>>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        Ok(self.inner.denoised_file(&params))
    }

    #[wasm_bindgen(js_name = releaseCache)]
    pub fn release_cache(&mut self) {
        self.inner.release_cache();
    }

    /// Make a LUT (any format `parseLut` reads) available to recipes; returns its id.
    #[wasm_bindgen(js_name = loadLut)]
    pub fn load_lut(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        self.inner.luts_mut().load(bytes).map_err(js_err)
    }

    /// Make a LUT available to `renderThumbnail` only (menus show many); returns its id.
    #[wasm_bindgen(js_name = loadThumbnailLut)]
    pub fn load_thumbnail_lut(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        self.thumbnail_luts.load(bytes).map_err(js_err)
    }

    #[wasm_bindgen(js_name = unloadThumbnailLut)]
    pub fn unload_thumbnail_lut(&mut self, id: &str) -> bool {
        self.thumbnail_luts.remove(id)
    }

    #[wasm_bindgen(js_name = hasLut)]
    pub fn has_lut(&self, id: &str) -> bool {
        self.inner.luts().contains(id)
    }

    #[wasm_bindgen(js_name = unloadLut)]
    pub fn unload_lut(&mut self, id: &str) -> bool {
        self.inner.luts_mut().remove(id)
    }

    /// Make a photo (a RAW file or an image, as the constructor takes) available to
    /// multiple exposures, by the SHA-256 of its file (`exposurePhotos`).
    #[wasm_bindgen(js_name = loadExposure)]
    pub fn load_exposure(&mut self, sha256: &str, bytes: &[u8]) -> Result<(), JsError> {
        let photo = pipeline::decode::decode(bytes).map_err(js_err)?;
        self.inner.exposures_mut().insert(sha256, photo);
        Ok(())
    }

    #[wasm_bindgen(js_name = hasExposure)]
    pub fn has_exposure(&self, sha256: &str) -> bool {
        self.inner.exposures().contains(sha256)
    }

    #[wasm_bindgen(js_name = unloadExposure)]
    pub fn unload_exposure(&mut self, sha256: &str) -> bool {
        self.inner.exposures_mut().remove(sha256)
    }
}

/// The point operations over a fixed strip of a spatial image (`Developer.spatialRows`),
/// for a pool of workers that share a render.
#[wasm_bindgen]
pub struct PointRenderer {
    inner: pipeline::pipeline::PointRenderer,
}

#[wasm_bindgen]
impl PointRenderer {
    /// `pixels`: interleaved linear RGB, `width × height`; `as_shot`: `[x, y]` or empty;
    /// `mask_ids_json` and `masks`: the drawn planes of the masks over the same rows
    /// (`Developer.spatialMaskIds` and `spatialMaskRows`).
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, pixels: &[f32], as_shot: &[f32], mask_ids_json: &str, masks: &[f32]) -> Result<PointRenderer, JsError> {
        let (image, masks, as_shot) = strip(width, height, pixels, as_shot, mask_ids_json, masks)?;
        Ok(Self { inner: pipeline::pipeline::PointRenderer::with_masks(image, masks, as_shot) })
    }

    /// Work on another strip (same arguments as the constructor), keeping the loaded LUTs.
    #[wasm_bindgen(js_name = setStrip)]
    pub fn set_strip(&mut self, width: u32, height: u32, pixels: &[f32], as_shot: &[f32], mask_ids_json: &str, masks: &[f32]) -> Result<(), JsError> {
        let (image, masks, as_shot) = strip(width, height, pixels, as_shot, mask_ids_json, masks)?;
        self.inner.set_image(image, masks, as_shot);
        Ok(())
    }

    /// Make a LUT available to recipes, like `Developer.loadLut`; returns its id.
    #[wasm_bindgen(js_name = loadLut)]
    pub fn load_lut(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        self.inner.luts_mut().load(bytes).map_err(js_err)
    }

    #[wasm_bindgen(js_name = unloadLut)]
    pub fn unload_lut(&mut self, id: &str) -> bool {
        self.inner.luts_mut().remove(id)
    }

    /// Interactive render of the strip to RGBA8.
    pub fn render(&mut self, params_json: &str) -> Result<RenderedImage, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.render(&params, Quality::Interactive);
        Ok(RenderedImage { width: img.width as u32, height: img.height as u32, data: img.data })
    }
}

type Strip = (pipeline::Image, Vec<pipeline::ops::mask::MaskPlane>, Option<[f32; 2]>);

/// A strip from what `PointRenderer`'s constructor takes.
fn strip(width: u32, height: u32, pixels: &[f32], as_shot: &[f32], mask_ids_json: &str, masks: &[f32]) -> Result<Strip, JsError> {
    let (width, height) = (width as usize, height as usize);
    if pixels.len() != width * height * 3 {
        return Err(JsError::new("pixel count doesn't match the size"));
    }
    let ids: Vec<String> = serde_json::from_str(mask_ids_json).map_err(js_err)?;
    if masks.len() != ids.len() * width * height {
        return Err(JsError::new("mask size doesn't match the size"));
    }
    let masks = ids
        .into_iter()
        .zip(masks.chunks_exact((width * height).max(1)))
        .map(|(id, alpha)| pipeline::ops::mask::MaskPlane { id, alpha: alpha.to_vec() })
        .collect();
    let image = pipeline::Image { width, height, pixels: pixels.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect() };
    let as_shot = <[f32; 2]>::try_from(as_shot).ok();
    Ok((image, masks, as_shot))
}
