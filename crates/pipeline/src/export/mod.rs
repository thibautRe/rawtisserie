//! Exports: a final-quality render to a file, with its options (format, bit depth,
//! colour space, size, output sharpening, frame, metadata).
//!
//! The point operations run in bands of rows straight to encoded values in the output
//! space ([`PointOps::render_encoded_rows`]), so a full-size export holds no second
//! floating-point copy of the image. Output sharpening is an unsharp mask on the
//! encoded luminance, at the export size, computed per band with a margin.
//!
//! [`ExportOptions`] and [`ExportMetadata`] are mirrored in
//! `packages/pipeline/src/export.ts`.

pub mod exif;
pub mod icc;
pub mod tiff;

use serde::{Deserialize, Serialize};

pub use exif::{ExportMetadata, MetadataMode};
use tiff::{Ifd, Sample, Value};

use crate::frame::Frame;
use crate::image::{Image, Rgb};
use crate::ops::filters;
use crate::ops::mask::MaskPlane;
use crate::ops::point::PointOps;
use crate::output::ColorSpace;
use crate::params::EditParams;
use crate::pipeline::{Developer, RenderSize};
use crate::{Error, Result};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    #[default]
    Jpeg,
    Png,
    Tiff,
}

impl Format {
    pub fn mime_type(self) -> &'static str {
        match self {
            Format::Jpeg => "image/jpeg",
            Format::Png => "image/png",
            Format::Tiff => "image/tiff",
        }
    }
}

/// Bounds of the exported image (frame included). Never upscaled.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Size {
    #[default]
    Full,
    LongEdge {
        size: u32,
    },
    ShortEdge {
        size: u32,
    },
    /// Within `width × height`; 0 leaves that side unbounded.
    Fit {
        width: u32,
        height: u32,
    },
    Megapixels {
        megapixels: f32,
    },
}

impl Size {
    /// Whether a `width × height` image fits.
    fn fits(self, width: usize, height: usize) -> bool {
        let within = |n: u32, v: usize| n == 0 || v <= n as usize;
        match self {
            Size::Full => true,
            Size::LongEdge { size } => within(size, width.max(height)),
            Size::ShortEdge { size } => within(size, width.min(height)),
            Size::Fit { width: w, height: h } => within(w, width) && within(h, height),
            Size::Megapixels { megapixels } => {
                megapixels.is_nan() || megapixels <= 0.0 || (width * height) as f64 <= (f64::from(megapixels) * 1e6).round()
            }
        }
    }
}

/// Output sharpening, for the export size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sharpening {
    #[default]
    None,
    Low,
    Standard,
    High,
}

/// Radius (gaussian sigma, in output pixels) of output sharpening.
const SHARPEN_SIGMA: f32 = 0.7;

impl Sharpening {
    fn amount(self) -> f32 {
        match self {
            Sharpening::None => 0.0,
            Sharpening::Low => 0.3,
            Sharpening::Standard => 0.6,
            Sharpening::High => 1.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub format: Format,
    /// JPEG quality, 1–100.
    pub quality: u8,
    /// Bits per sample for PNG and TIFF: 8 or 16 (JPEG is always 8).
    pub depth: u8,
    pub color_space: ColorSpace,
    pub size: Size,
    pub sharpening: Sharpening,
    pub frame: Option<Frame>,
    pub metadata: MetadataMode,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: Format::Jpeg,
            quality: 92,
            depth: 16,
            color_space: ColorSpace::Srgb,
            size: Size::Full,
            sharpening: Sharpening::None,
            frame: None,
            metadata: MetadataMode::All,
        }
    }
}

impl ExportOptions {
    fn sixteen_bits(&self) -> bool {
        self.format != Format::Jpeg && self.depth == 16
    }
}

/// Bounds for the photo so that, framed if `frame` is given, it fits `size`.
pub fn render_size(dev: &Developer, params: &EditParams, size: Size, frame: Option<&Frame>) -> RenderSize {
    match (size, frame) {
        (Size::Full, _) => return RenderSize::FULL,
        // What the photo's own size takes care of.
        (Size::LongEdge { size }, None) => return RenderSize::fit(size, size),
        (Size::Fit { width, height }, None) => return RenderSize::fit(width, height),
        _ => {}
    }
    // The (framed) size grows with the photo's width: find the widest photo that fits
    // (never wider than at full resolution).
    let fits = |width: u32| {
        let (w, h, _) = dev.output_size(params, RenderSize::fit(width, 0));
        match frame {
            Some(frame) => {
                let l = frame.layout(w, h);
                size.fits(l.width, l.height)
            }
            None => size.fits(w, h),
        }
    };
    let (full_width, ..) = dev.output_size(params, RenderSize::FULL);
    let (mut lo, mut hi) = (1u32, full_width as u32);
    if fits(hi) {
        return RenderSize::FULL;
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if fits(mid) { lo = mid } else { hi = mid }
    }
    RenderSize::fit(lo, 0)
}

/// Rows per band of the point operations.
const BAND: usize = 64;

/// `img` through `ops`, quantised, with output sharpening of `amount` (0: none).
/// Interleaved RGB samples.
pub fn encode_pixels<T: Sample>(ops: &PointOps, img: &Image, masks: &[MaskPlane], amount: f32) -> Vec<T> {
    let (w, h) = (img.width, img.height);
    let sharpen = filters::sharpen_active(amount, SHARPEN_SIGMA);
    let margin = if sharpen { filters::reach(SHARPEN_SIGMA) } else { 0 };
    let luma = ops.space().xyz_from_rgb()[1];
    let mut out = Vec::with_capacity(w * h * 3);
    let mut band: Vec<Rgb> = Vec::new();
    let mut plane = Vec::new();
    for y0 in (0..h).step_by(BAND) {
        let y1 = (y0 + BAND).min(h);
        let (top, bottom) = (y0.saturating_sub(margin), (y1 + margin).min(h));
        ops.render_encoded_rows(img, masks, top..bottom, &mut band);
        let rows = &band[(y0 - top) * w..(y1 - top) * w];
        if sharpen {
            // The margin rows make the blur match the whole image's.
            plane.clear();
            plane.extend(band.iter().map(|c| c[0] * luma[0] + c[1] * luma[1] + c[2] * luma[2]));
            let mut blurred = plane.clone();
            filters::blur_plane(&mut blurred, w, bottom - top, SHARPEN_SIGMA);
            let at = (y0 - top) * w;
            for (i, c) in rows.iter().enumerate() {
                let detail = amount * (plane[at + i] - blurred[at + i]);
                out.extend(c.map(|v| T::quantize(v + detail)));
            }
        } else {
            out.extend(rows.iter().flat_map(|c| c.map(T::quantize)));
        }
    }
    out
}

/// An encoded image: interleaved RGB samples.
struct Pixels<T> {
    width: usize,
    height: usize,
    data: Vec<T>,
}

/// `px` in `frame`, with its colours converted to `space`.
fn framed<T: Sample>(px: Pixels<T>, frame: Option<&Frame>, space: ColorSpace) -> Pixels<T> {
    let Some(frame) = frame else { return px };
    let [color, line] = frame.colors().map(|c| space.from_srgb(c.map(|v| f32::from(v) / 255.0)).map(T::quantize));
    let (width, height, data) = frame.apply_pixels(&px.data, px.width, px.height, &color, &line);
    Pixels { width, height, data }
}

/// A final-quality export of `params`, encoded as `options` say, with `metadata`.
pub fn render(dev: &mut Developer, params: &EditParams, options: &ExportOptions, metadata: &ExportMetadata) -> Result<Vec<u8>> {
    let size = render_size(dev, params, options.size, options.frame.as_ref());
    let space = options.color_space;
    let ops = dev.export_ops(params, space);
    let (_, img, masks) = dev.spatial(params, size);
    let amount = options.sharpening.amount();
    let frame = options.frame.as_ref();
    if options.sixteen_bits() {
        let data = encode_pixels::<u16>(&ops, img, masks, amount);
        let px = framed(Pixels { width: img.width, height: img.height, data }, frame, space);
        encode(px, options, metadata)
    } else {
        let data = encode_pixels::<u8>(&ops, img, masks, amount);
        let px = framed(Pixels { width: img.width, height: img.height, data }, frame, space);
        encode(px, options, metadata)
    }
}

/// XMP's identifier in a JPEG APP1 segment.
const XMP_NAMESPACE: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
/// Largest APP segment payload.
const MAX_SEGMENT: usize = 65533;

fn encode<T: Sample + EncodeAs>(px: Pixels<T>, options: &ExportOptions, metadata: &ExportMetadata) -> Result<Vec<u8>> {
    let space = options.color_space;
    let mode = options.metadata;
    let ifd = exif::ifd0(metadata, mode, space, px.width, px.height);
    let xmp = exif::xmp(metadata, mode);
    let icc = icc::profile(space);
    match options.format {
        Format::Jpeg => T::jpeg(&px, options.quality, &ifd, xmp.as_deref(), &icc),
        Format::Png => png(&px, &ifd, xmp, icc),
        Format::Tiff => {
            let mut ifd = ifd;
            if let Some(xmp) = xmp {
                ifd.set(exif::XMP, Value::Byte(xmp.into_bytes()));
            }
            ifd.set(exif::ICC_PROFILE, Value::Undefined(icc));
            tiff::encode(px.width, px.height, &px.data, ifd)
        }
    }
}

/// What only 8-bit samples can be encoded as.
trait EncodeAs: Sized {
    fn jpeg(px: &Pixels<Self>, quality: u8, ifd: &Ifd, xmp: Option<&str>, icc: &[u8]) -> Result<Vec<u8>>;
}

impl EncodeAs for u16 {
    fn jpeg(_: &Pixels<Self>, _: u8, _: &Ifd, _: Option<&str>, _: &[u8]) -> Result<Vec<u8>> {
        Err(Error::Encode("JPEG is 8 bits only".into()))
    }
}

impl EncodeAs for u8 {
    fn jpeg(px: &Pixels<Self>, quality: u8, ifd: &Ifd, xmp: Option<&str>, icc: &[u8]) -> Result<Vec<u8>> {
        use jpeg_encoder::{ColorType, Encoder};
        let err = |e: jpeg_encoder::EncodingError| Error::Encode(e.to_string());
        let (Ok(w), Ok(h)) = (u16::try_from(px.width), u16::try_from(px.height)) else {
            return Err(Error::Encode(format!("{}×{} is too large for JPEG (65,535 px at most)", px.width, px.height)));
        };
        let mut out = Vec::new();
        let mut encoder = Encoder::new(&mut out, quality.clamp(1, 100));
        encoder.set_progressive(true);
        if !ifd.is_empty() {
            encoder.add_exif_metadata(&tiff::exif_block(ifd)?).map_err(err)?;
        }
        if let Some(xmp) = xmp {
            let segment = [XMP_NAMESPACE, xmp.as_bytes()].concat();
            // A packet too large for one segment would need extended XMP: leave it out.
            if segment.len() <= MAX_SEGMENT {
                encoder.add_app_segment(1, segment).map_err(err)?;
            }
        }
        encoder.add_icc_profile(icc).map_err(err)?;
        encoder.encode(&px.data, w, h, ColorType::Rgb).map_err(err)?;
        Ok(out)
    }
}

fn png<T: Sample>(px: &Pixels<T>, ifd: &Ifd, xmp: Option<String>, icc: Vec<u8>) -> Result<Vec<u8>> {
    let err = |e: png::EncodingError| Error::Encode(e.to_string());
    let (Ok(w), Ok(h)) = (u32::try_from(px.width), u32::try_from(px.height)) else {
        return Err(Error::Encode("the image is too large for PNG".into()));
    };
    let mut info = png::Info::with_size(w, h);
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = if T::BITS == 16 { png::BitDepth::Sixteen } else { png::BitDepth::Eight };
    info.icc_profile = Some(icc.into());
    if !ifd.is_empty() {
        info.exif_metadata = Some(tiff::exif_block(ifd)?.into());
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::with_info(&mut out, info).map_err(err)?;
    encoder.set_compression(png::Compression::Fast);
    if let Some(xmp) = xmp {
        encoder.add_itxt_chunk("XML:com.adobe.xmp".into(), xmp).map_err(err)?;
    }
    let mut writer = encoder.write_header().map_err(err)?;
    let mut bytes = Vec::with_capacity(px.data.len() * usize::from(T::BITS / 8));
    px.data.iter().for_each(|s| s.write_be(&mut bytes));
    writer.write_image_data(&bytes).map_err(err)?;
    writer.finish().map_err(err)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert!(Size::LongEdge { size: 100 }.fits(100, 50) && !Size::LongEdge { size: 100 }.fits(101, 50));
        assert!(Size::ShortEdge { size: 50 }.fits(100, 50) && !Size::ShortEdge { size: 49 }.fits(100, 50));
        assert!(Size::Fit { width: 0, height: 50 }.fits(1000, 50) && !Size::Fit { width: 10, height: 0 }.fits(11, 1));
        assert!(Size::Megapixels { megapixels: 0.01 }.fits(100, 100) && !Size::Megapixels { megapixels: 0.01 }.fits(101, 100));
    }

    #[test]
    fn options_parse_from_partial_json() {
        let o: ExportOptions = serde_json::from_str(
            r#"{"format":"tiff","colorSpace":"displayP3","size":{"type":"shortEdge","size":1080},"sharpening":"standard","metadata":"noLocation"}"#,
        )
        .unwrap();
        assert_eq!(o.format, Format::Tiff);
        assert_eq!(o.depth, 16);
        assert_eq!(o.color_space, ColorSpace::DisplayP3);
        assert_eq!(o.size, Size::ShortEdge { size: 1080 });
        assert_eq!(o.metadata, MetadataMode::NoLocation);
        assert!(o.sixteen_bits());
        let jpeg: ExportOptions = serde_json::from_str(r#"{"depth":16}"#).unwrap();
        assert!(!jpeg.sixteen_bits());
    }

    #[test]
    fn metadata_parses() {
        let m: ExportMetadata = serde_json::from_str(r#"{"photo":{"make":"Sony","rating":1},"rating":3,"tags":["a"]}"#).unwrap();
        assert_eq!((m.photo.make.as_deref(), m.rating, m.tags.len()), (Some("Sony"), 3, 1));
    }
}
