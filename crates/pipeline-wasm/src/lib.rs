//! WebAssembly bindings for the RAWtisserie pipeline.
//!
//! The same `.wasm` module is used by the browser developer (inside a Web Worker)
//! and by the Node server to render thumbnails headlessly. Edit parameters and
//! metadata cross the boundary as JSON strings; pixels as byte arrays.

use rawtisserie_pipeline::ops::clipping::Overlays;
use rawtisserie_pipeline::{self as pipeline, EditParams, Quality, RenderSize};
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

/// A recipe of any version, migrated to the current one and normalised, as JSON.
#[wasm_bindgen(js_name = normalizeParams)]
pub fn normalize_params(params_json: &str) -> Result<String, JsError> {
    let params = EditParams::from_json(params_json).map_err(js_err)?;
    serde_json::to_string(&params).map_err(js_err)
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
}

#[wasm_bindgen]
impl Developer {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<Developer, JsError> {
        Ok(Self {
            inner: pipeline::Developer::from_bytes(bytes).map_err(js_err)?,
        })
    }

    /// Metadata of the decoded file, as JSON.
    #[wasm_bindgen(js_name = metadata)]
    pub fn metadata(&self) -> Result<String, JsError> {
        serde_json::to_string(self.inner.metadata()).map_err(js_err)
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

    /// Whether a render of these parameters within these bounds (and region, as for
    /// `render`) would only re-run the point operations (the spatial stages' output is cached).
    #[wasm_bindgen(js_name = isSpatialCached)]
    pub fn is_spatial_cached(&self, params_json: &str, max_width: u32, max_height: u32, region: Option<Vec<u32>>) -> Result<bool, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        Ok(self.inner.is_spatial_cached(&params, render_size(max_width, max_height, region)?))
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

    /// Final-quality render, encoded as a JPEG file.
    #[wasm_bindgen(js_name = renderJpeg)]
    pub fn render_jpeg(&mut self, params_json: &str, max_width: u32, max_height: u32, quality: u8) -> Result<Vec<u8>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.render(&params, RenderSize::fit(max_width, max_height), Quality::Final);
        pipeline::encode::jpeg(&img, quality).map_err(js_err)
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

    /// Free the cached demosaiced image (it is rebuilt on the next render).
    #[wasm_bindgen(js_name = releaseCache)]
    pub fn release_cache(&mut self) {
        self.inner.release_cache();
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
    /// `pixels`: interleaved linear RGB, `width × height`; `as_shot`: `[x, y]` or empty.
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, pixels: &[f32], as_shot: &[f32]) -> Result<PointRenderer, JsError> {
        let (width, height) = (width as usize, height as usize);
        if pixels.len() != width * height * 3 {
            return Err(JsError::new("pixel count doesn't match the size"));
        }
        let image = pipeline::Image { width, height, pixels: pixels.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect() };
        let as_shot = <[f32; 2]>::try_from(as_shot).ok();
        Ok(Self { inner: pipeline::pipeline::PointRenderer::new(image, as_shot) })
    }

    /// Interactive render of the strip to RGBA8.
    pub fn render(&mut self, params_json: &str) -> Result<RenderedImage, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.render(&params, Quality::Interactive);
        Ok(RenderedImage { width: img.width as u32, height: img.height as u32, data: img.data })
    }
}
