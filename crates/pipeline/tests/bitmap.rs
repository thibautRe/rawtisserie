//! Images that aren't RAW files (JPEG, PNG, TIFF, WebP: `bitmap`) go through the
//! pipeline linearised, and come out as they went in when the recipe has nothing in it.

use std::io::Cursor;

use image::{ImageEncoder, RgbImage};
use jpeg_encoder::{ColorType, Encoder};
use moxcms::{ColorProfile, Layout, TransformOptions};
use rawtisserie_pipeline::{Developer, EditParams, PhotoMetadata, Quality, RenderSize, Rgba8, metadata};

const W: u32 = 48;
const H: u32 = 32;

/// A recipe with no modules: what an image starts with.
fn empty() -> EditParams {
    EditParams::from_json(r#"{"version":8,"modules":[]}"#).unwrap()
}

fn render(bytes: &[u8]) -> Rgba8 {
    Developer::from_bytes(bytes).unwrap().render(&empty(), RenderSize::FULL, Quality::Final)
}

fn pattern() -> RgbImage {
    RgbImage::from_fn(W, H, |x, y| image::Rgb([(x * 255 / (W - 1)) as u8, (y * 255 / (H - 1)) as u8, ((x + y) * 3 % 256) as u8]))
}

fn assert_close(out: &Rgba8, expected: &[[u8; 3]], tolerance: u8) {
    assert_eq!(out.data.len() / 4, expected.len());
    for (i, (px, want)) in out.data.chunks_exact(4).zip(expected).enumerate() {
        for c in 0..3 {
            assert!(px[c].abs_diff(want[c]) <= tolerance, "pixel {i}: {:?} vs {want:?}", &px[..3]);
        }
    }
}

fn jpeg(rgb: &[u8], w: u32, h: u32, segments: &[(u8, Vec<u8>)], icc: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = Encoder::new(&mut out, 100);
    for (nr, data) in segments {
        enc.add_app_segment(*nr, data.clone()).unwrap();
    }
    if let Some(icc) = icc {
        enc.add_icc_profile(icc).unwrap();
    }
    enc.encode(rgb, w as u16, h as u16, ColorType::Rgb).unwrap();
    out
}

/// What another decoder makes of `bytes`.
fn reference(bytes: &[u8]) -> Vec<[u8; 3]> {
    let img = image::load_from_memory(bytes).unwrap().into_rgb8();
    img.pixels().map(|p| p.0).collect()
}

#[test]
fn jpeg_round_trips() {
    let bytes = jpeg(pattern().as_raw(), W, H, &[], None);
    let out = render(&bytes);
    assert_eq!((out.width, out.height), (W as usize, H as usize));
    assert_close(&out, &reference(&bytes), 1);
}

#[test]
fn png_16_bit_round_trips() {
    let data: Vec<u16> = (0..W * H).flat_map(|i| [(i * 41) as u16, (i * 977) as u16, 65535 - (i * 13) as u16]).collect();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(bytemuck(&data), W, H, image::ExtendedColorType::Rgb16)
        .unwrap();
    let expected: Vec<[u8; 3]> = data.chunks_exact(3).map(|p| [0, 1, 2].map(|c| ((p[c] as u32 * 255 + 32767) / 65535) as u8)).collect();
    assert_close(&render(&bytes), &expected, 1);
}

fn bytemuck(data: &[u16]) -> &[u8] {
    // PNG's encoder takes native-endian samples.
    unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2) }
}

#[test]
fn grey_png_stays_grey() {
    let grey = image::GrayImage::from_fn(W, H, |x, _| image::Luma([(x * 5) as u8]));
    let mut bytes = Vec::new();
    grey.write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
    let expected: Vec<[u8; 3]> = grey.pixels().map(|p| [p.0[0]; 3]).collect();
    assert_close(&render(&bytes), &expected, 1);
}

#[test]
fn webp_and_tiff_decode() {
    for format in [image::ImageFormat::WebP, image::ImageFormat::Tiff] {
        let mut bytes = Vec::new();
        pattern().write_to(&mut Cursor::new(&mut bytes), format).unwrap();
        assert_close(&render(&bytes), &reference(&bytes), 1);
        let meta = metadata::read(&bytes).unwrap();
        assert_eq!((meta.width, meta.height), (Some(W), Some(H)));
    }
}

/// A Display P3 JPEG (as phones take them) is read through its profile.
#[test]
fn icc_profile_is_applied() {
    let p3 = ColorProfile::new_display_p3();
    let bytes = jpeg(pattern().as_raw(), W, H, &[], Some(&p3.encode().unwrap()));
    // In sRGB, by a colour management system.
    let decoded: Vec<u8> = reference(&bytes).concat();
    let mut srgb = vec![0u8; decoded.len()];
    p3.create_transform_8bit(Layout::Rgb, &ColorProfile::new_srgb(), Layout::Rgb, TransformOptions::default())
        .unwrap()
        .transform(&decoded, &mut srgb)
        .unwrap();
    let out = render(&bytes);
    // Out of sRGB's gamut, both clip: compare only what's inside.
    let inside: Vec<usize> = (0..srgb.len() / 3).filter(|&i| srgb[i * 3..i * 3 + 3].iter().all(|&v| v > 2 && v < 253)).collect();
    assert!(inside.len() > 200, "{}", inside.len());
    for i in inside {
        for c in 0..3 {
            let (got, want) = (out.data[i * 4 + c], srgb[i * 3 + c]);
            assert!(got.abs_diff(want) <= 2, "pixel {i}: {got} vs {want}");
        }
    }
}

/// A minimal EXIF block: make, model, orientation, and the date taken.
fn exif(orientation: u16) -> Vec<u8> {
    let mut tiff: Vec<u8> = b"II*\0\x08\0\0\0".to_vec();
    let strings: [(u16, &[u8]); 2] = [(0x010F, b"Phone\0"), (0x0110, b"Model X\0")];
    let entries = 4u16;
    let ifd_end = 8 + 2 + entries as u32 * 12 + 4;
    let exif_ifd = ifd_end + 6 + 8;
    let mut data: Vec<u8> = Vec::new();
    tiff.extend(entries.to_le_bytes());
    let mut offset = ifd_end;
    for (tag, value) in strings {
        tiff.extend(tag.to_le_bytes());
        tiff.extend(2u16.to_le_bytes());
        tiff.extend((value.len() as u32).to_le_bytes());
        tiff.extend(offset.to_le_bytes());
        data.extend(value);
        offset += value.len() as u32;
    }
    tiff.extend(0x0112u16.to_le_bytes());
    tiff.extend(3u16.to_le_bytes());
    tiff.extend(1u32.to_le_bytes());
    tiff.extend((orientation as u32).to_le_bytes());
    tiff.extend(0x8769u16.to_le_bytes());
    tiff.extend(4u16.to_le_bytes());
    tiff.extend(1u32.to_le_bytes());
    tiff.extend(exif_ifd.to_le_bytes());
    tiff.extend(0u32.to_le_bytes());
    tiff.extend(&data);
    assert_eq!(tiff.len() as u32, exif_ifd);
    let date = b"2024:05:06 07:08:09\0";
    tiff.extend(1u16.to_le_bytes());
    tiff.extend(0x9003u16.to_le_bytes());
    tiff.extend(2u16.to_le_bytes());
    tiff.extend((date.len() as u32).to_le_bytes());
    tiff.extend((exif_ifd + 2 + 12 + 4).to_le_bytes());
    tiff.extend(0u32.to_le_bytes());
    tiff.extend(date);
    [b"Exif\0\0".as_slice(), &tiff].concat()
}

#[test]
fn exif_metadata_and_orientation() {
    let bytes = jpeg(pattern().as_raw(), W, H, &[(1, exif(6))], None);
    let meta = metadata::read(&bytes).unwrap();
    assert_eq!(
        meta,
        PhotoMetadata {
            make: Some("Phone".into()),
            model: Some("Model X".into()),
            captured_at: Some("2024-05-06T07:08:09".into()),
            orientation: Some(6),
            width: Some(H),
            height: Some(W),
            image_format: Some("jpeg".into()),
            ..Default::default()
        }
    );
    // Turned upright like a RAW file: a quarter turn clockwise.
    let out = render(&bytes);
    assert_eq!((out.width, out.height), (H as usize, W as usize));
    let src = reference(&bytes);
    let at = |x: usize, y: usize| -> [u8; 3] { out.data[(y * out.width + x) * 4..][..3].try_into().unwrap() };
    // The source's top-left pixel ends up top-right.
    let want = src[0];
    let got = at(out.width - 1, 0);
    assert!((0..3).all(|c| got[c].abs_diff(want[c]) <= 1), "{got:?} vs {want:?}");
    // And the developer reads the same metadata.
    assert_eq!(Developer::from_bytes(&bytes).unwrap().metadata(), &meta);
}

/// The recipe an image starts with has nothing in it.
#[test]
fn default_recipe_is_empty() {
    let meta = PhotoMetadata { image_format: Some("jpeg".into()), ..Default::default() };
    assert!(EditParams::default_for(&meta).modules.is_empty());
}

/// RAW files are TIFFs too, mostly: none of the golden ones reads as an image. Skipped
/// without them (`./scripts/fetch-golden-raws.sh`).
#[test]
fn raws_are_not_images() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws");
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries {
        let path = entry.unwrap().path();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(rawtisserie_pipeline::bitmap::detect(&bytes), None, "{}", path.display());
        assert_eq!(metadata::read(&bytes).unwrap().image_format, None, "{}", path.display());
    }
}
