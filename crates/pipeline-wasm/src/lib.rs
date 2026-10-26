//! WebAssembly bindings for the RAWtisserie pipeline.
//!
//! The same `.wasm` module is used by the browser developer (inside a Web Worker)
//! and by the Node server to render thumbnails headlessly. Edit parameters and
//! metadata cross the boundary as JSON strings; pixels as byte arrays.

use rawtisserie_pipeline::{self as pipeline, EditParams, RenderSize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
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

    /// `[width, height]` that `render` would produce for these parameters and bounds.
    #[wasm_bindgen(js_name = outputSize)]
    pub fn output_size(&self, params_json: &str, max_width: u32, max_height: u32) -> Result<Vec<u32>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let (w, h, _) = self.inner.output_size(&params, RenderSize::fit(max_width, max_height));
        Ok(vec![w as u32, h as u32])
    }

    /// Render to RGBA8, fitted within `max_width × max_height` (0 = unbounded).
    pub fn render(&mut self, params_json: &str, max_width: u32, max_height: u32) -> Result<RenderedImage, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.render(&params, RenderSize::fit(max_width, max_height));
        Ok(RenderedImage {
            width: img.width as u32,
            height: img.height as u32,
            data: img.data,
        })
    }

    /// Render and encode as a JPEG file.
    #[wasm_bindgen(js_name = renderJpeg)]
    pub fn render_jpeg(&mut self, params_json: &str, max_width: u32, max_height: u32, quality: u8) -> Result<Vec<u8>, JsError> {
        let params = EditParams::from_json(params_json).map_err(js_err)?;
        let img = self.inner.render(&params, RenderSize::fit(max_width, max_height));
        pipeline::encode::jpeg(&img, quality).map_err(js_err)
    }

    /// Free the cached demosaiced image (it is rebuilt on the next render).
    #[wasm_bindgen(js_name = releaseCache)]
    pub fn release_cache(&mut self) {
        self.inner.release_cache();
    }
}
