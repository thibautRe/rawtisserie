//! Images that are already developed: JPEG, PNG, TIFF and WebP (roadmap 8.11).
//!
//! They go through the same pipeline as RAW files, as a plain RGB (or grey) "sensor":
//! the samples stay as stored (8 or 16 bits) and are linearised when read, by lookup
//! tables built from the embedded ICC profile (sRGB without one), and the profile's
//! primaries become the camera matrix (to linear Rec.2020). There's no white balance
//! to undo and no as-shot light. Recipes for them leave filmic out, so an unedited
//! image comes out as it went in (clipped to the output space).

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use moxcms::{ColorProfile, DataColorSpace, Layout as CmsLayout, TransformOptions};
use rawler::exif::Exif;
use rawler::formats::tiff::GenericTiffReader;
use rawler::formats::tiff::reader::TiffReader;
use rawler::tags::TiffCommonTag;

use crate::color::{self, Mat3};
use crate::metadata::{self, PhotoMetadata};
use crate::{Error, Result};

/// The formats this module reads, by their `PhotoMetadata::image_format` name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    Tiff,
    Webp,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Jpeg => "jpeg",
            Format::Png => "png",
            Format::Tiff => "tiff",
            Format::Webp => "webp",
        }
    }

    fn image_format(self) -> ImageFormat {
        match self {
            Format::Jpeg => ImageFormat::Jpeg,
            Format::Png => ImageFormat::Png,
            Format::Tiff => ImageFormat::Tiff,
            Format::Webp => ImageFormat::WebP,
        }
    }
}

/// The format of `bytes` if they're an image this module reads rather than a RAW file.
///
/// JPEG, PNG and WebP are told by their signature. TIFF is the container of most RAW
/// formats too (ARW, NEF, CR2, DNG…), so a TIFF counts as an image only when its first
/// IFD is a plain RGB or grey image, the largest in the file, with no sub-IFDs (where
/// NEF, ARW, DNG and PEF keep the sensor data) and no DNG version, and it isn't a CR2.
pub fn detect(bytes: &[u8]) -> Option<Format> {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => Some(Format::Jpeg),
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some(Format::Png),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some(Format::Webp),
        [b'I', b'I', 42, 0, ..] | [b'M', b'M', 0, 42, ..] if plain_tiff(bytes) => Some(Format::Tiff),
        _ => None,
    }
}

fn plain_tiff(bytes: &[u8]) -> bool {
    if bytes.get(8..10) == Some(b"CR") {
        return false;
    }
    let Ok(reader) = GenericTiffReader::new_with_buffer(bytes, 0, 0, None) else {
        return false;
    };
    let chain = &reader.file().chain;
    let Some(first) = chain.first() else { return false };
    if first.get_entry(TiffCommonTag::SubIFDs).is_some() || first.get_entry(TiffCommonTag::DNGVersion).is_some() {
        return false;
    }
    let number = |ifd: &rawler::formats::tiff::IFD, tag| ifd.get_entry(tag).map(|e| e.value.force_u32(0));
    // 0: white is zero, 1: black is zero, 2: RGB.
    if !matches!(number(first, TiffCommonTag::PhotometricInt), Some(0..=2)) {
        return false;
    }
    let area = |ifd| number(ifd, TiffCommonTag::ImageWidth).unwrap_or(0) as u64 * number(ifd, TiffCommonTag::ImageLength).unwrap_or(0) as u64;
    let own = area(first);
    own > 0 && chain.iter().skip(1).all(|ifd| area(ifd) <= own)
}

/// Stored samples, as decoded.
enum Samples {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

/// A decoded image: its samples, and how to read them as linear light.
pub struct Bitmap {
    pub format: Format,
    pub width: usize,
    pub height: usize,
    /// 3 (RGB) or 1 (grey).
    pub channels: usize,
    samples: Samples,
    /// Per channel: stored value → linear light (256 or 65 536 entries).
    linear: Vec<Vec<f32>>,
    /// Linear RGB in the image's primaries → linear Rec.2020 (identity for grey).
    pub working_from_image: Mat3,
}

impl Bitmap {
    /// Linear sample of `channel` (only the first for grey) at `(x, y)`.
    #[inline]
    pub fn sample(&self, x: usize, y: usize, channel: usize) -> f32 {
        let c = channel.min(self.channels - 1);
        let i = (y * self.width + x) * self.channels + c;
        let v = match &self.samples {
            Samples::U8(d) => d[i] as usize,
            Samples::U16(d) => d[i] as usize,
        };
        self.linear[c][v]
    }
}

/// Decode `bytes` (a format [`detect`] found), with its metadata.
pub fn decode(bytes: &[u8], format: Format) -> Result<(Bitmap, PhotoMetadata)> {
    let mut decoder = decoder(bytes, format)?;
    let icc = decoder.icc_profile().ok().flatten();
    let meta = metadata_of(bytes, format, &mut decoder);
    let image = DynamicImage::from_decoder(decoder).map_err(decode_err)?;
    let (width, height) = (image.width() as usize, image.height() as usize);
    let grey = !image.color().has_color();
    let deep = image.color().bytes_per_pixel() / image.color().channel_count() > 1;
    let (channels, mut samples) = match (grey, deep) {
        (true, false) => (1, Samples::U8(image.into_luma8().into_raw())),
        (true, true) => (1, Samples::U16(image.into_luma16().into_raw())),
        (false, false) => (3, Samples::U8(image.into_rgb8().into_raw())),
        (false, true) => (3, Samples::U16(image.into_rgb16().into_raw())),
    };
    let (linear, working_from_image) = colour(icc.as_deref(), channels, &mut samples);
    let bitmap = Bitmap { format, width, height, channels, samples, linear, working_from_image };
    Ok((bitmap, meta))
}

/// The metadata of `bytes` (a format [`detect`] found), without decoding the pixels.
pub fn read_metadata(bytes: &[u8], format: Format) -> Result<PhotoMetadata> {
    let mut decoder = decoder(bytes, format)?;
    Ok(metadata_of(bytes, format, &mut decoder))
}

fn decoder(bytes: &[u8], format: Format) -> Result<impl ImageDecoder + '_> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format.image_format());
    reader.no_limits();
    reader.into_decoder().map_err(decode_err)
}

fn decode_err(e: image::ImageError) -> Error {
    Error::Decode(e.to_string())
}

fn metadata_of(bytes: &[u8], format: Format, decoder: &mut impl ImageDecoder) -> PhotoMetadata {
    let exif = match format {
        // The file is a TIFF already.
        Format::Tiff => Some(bytes.to_vec()),
        _ => decoder.exif_metadata().ok().flatten(),
    };
    let mut meta = PhotoMetadata { image_format: Some(format.name().to_string()), ..Default::default() };
    if let Some(reader) = exif.and_then(|e| GenericTiffReader::new_with_buffer(&e, 0, 0, Some(1)).ok()) {
        let root = reader.root_ifd();
        let text = |tag| root.get_entry(tag).and_then(|e| e.value.as_string()).and_then(|s| metadata::non_empty(s));
        meta.make = text(TiffCommonTag::Make);
        meta.model = text(TiffCommonTag::Model);
        if let Ok(exif) = Exif::new(root) {
            metadata::apply_exif(&mut meta, &exif);
            meta.orientation = exif.orientation.filter(|o| (1..=8).contains(o));
        }
    }
    let orientation = *meta.orientation.get_or_insert(1);
    let (w, h) = decoder.dimensions();
    let swap = matches!(orientation, 5..=8);
    meta.width = Some(if swap { h } else { w });
    meta.height = Some(if swap { w } else { h });
    meta
}

/// The lookup tables to linear light and the matrix to linear Rec.2020, from the ICC
/// profile (sRGB's when there's none or it can't be used). A profile that isn't a
/// matrix and curves (LUT-based) is applied to the samples first, to sRGB.
fn colour(icc: Option<&[u8]>, channels: usize, samples: &mut Samples) -> (Vec<Vec<f32>>, Mat3) {
    let srgb = ColorProfile::new_srgb();
    let profile = icc.and_then(|b| ColorProfile::new_from_slice(b).ok());
    let profile = match profile {
        Some(p) if channels == 3 && p.color_space == DataColorSpace::Rgb && !p.is_matrix_shaper() => {
            // Left as they are if that fails: read as sRGB, the most likely.
            to_srgb(&p, samples);
            srgb.clone()
        }
        Some(p) if channels == 3 && p.is_matrix_shaper() => p,
        Some(p) if channels == 1 && p.color_space == DataColorSpace::Gray && p.gray_trc.is_some() => p,
        _ => srgb.clone(),
    };
    let deep = matches!(samples, Samples::U16(_));
    let tables = if channels == 1 {
        let gray = if profile.color_space == DataColorSpace::Gray { gray_table(&profile, deep) } else { None };
        vec![gray.unwrap_or_else(|| srgb_table(deep))]
    } else {
        rgb_tables(&profile, deep).unwrap_or_else(|| vec![srgb_table(deep); 3])
    };
    let matrix = if channels == 1 {
        color::IDENTITY
    } else {
        let m = profile.transform_matrix(&ColorProfile::new_bt2020());
        m.v.map(|row| row.map(|v| v as f32))
    };
    (tables, matrix)
}

fn rgb_tables(p: &ColorProfile, deep: bool) -> Option<Vec<Vec<f32>>> {
    let tables = if deep {
        [
            p.build_r_linearize_table::<u16, 65536, 16>(true).ok()?.to_vec(),
            p.build_g_linearize_table::<u16, 65536, 16>(true).ok()?.to_vec(),
            p.build_b_linearize_table::<u16, 65536, 16>(true).ok()?.to_vec(),
        ]
    } else {
        [
            p.build_r_linearize_table::<u8, 256, 8>(true).ok()?.to_vec(),
            p.build_g_linearize_table::<u8, 256, 8>(true).ok()?.to_vec(),
            p.build_b_linearize_table::<u8, 256, 8>(true).ok()?.to_vec(),
        ]
    };
    Some(tables.to_vec())
}

fn gray_table(p: &ColorProfile, deep: bool) -> Option<Vec<f32>> {
    Some(if deep {
        p.build_gray_linearize_table::<u16, 65536, 16>().ok()?.to_vec()
    } else {
        p.build_gray_linearize_table::<u8, 256, 8>().ok()?.to_vec()
    })
}

fn srgb_table(deep: bool) -> Vec<f32> {
    let max = if deep { 65535.0 } else { 255.0 };
    let eotf = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    (0..=max as u32).map(|v| eotf(v as f32 / max)).collect()
}

/// Convert RGB samples from `profile` to sRGB in place; false if it can't be done.
fn to_srgb(profile: &ColorProfile, samples: &mut Samples) -> bool {
    let srgb = ColorProfile::new_srgb();
    let options = TransformOptions::default();
    match samples {
        Samples::U8(d) => {
            let Ok(t) = profile.create_transform_8bit(CmsLayout::Rgb, &srgb, CmsLayout::Rgb, options) else { return false };
            let src = d.clone();
            t.transform(&src, d).is_ok()
        }
        Samples::U16(d) => {
            let Ok(t) = profile.create_transform_16bit(CmsLayout::Rgb, &srgb, CmsLayout::Rgb, options) else { return false };
            let src = d.clone();
            t.transform(&src, d).is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_formats() {
        assert_eq!(detect(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some(Format::Jpeg));
        assert_eq!(detect(b"\x89PNG\r\n\x1a\n...."), Some(Format::Png));
        assert_eq!(detect(b"RIFF\0\0\0\0WEBPVP8 "), Some(Format::Webp));
        assert_eq!(detect(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(detect(b"II*\0\x08\0\0\0CR\x02\0"), None);
        assert_eq!(detect(&[]), None);
    }

    #[test]
    fn srgb_primaries_to_rec2020() {
        let (_, m) = colour(None, 3, &mut Samples::U8(vec![]));
        // BT.2087's sRGB (BT.709) → BT.2020 matrix.
        let expected = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
        for (row, want) in m.iter().zip(expected) {
            for (v, w) in row.iter().zip(want) {
                assert!((v - w).abs() < 2e-3, "{m:?}");
            }
        }
    }
}
