//! Exports fit their bounds (frame included) and fill them as well as they can, and
//! decode to what was asked for.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::export::{self, ExportMetadata, ExportOptions, Format, Size};
use rawtisserie_pipeline::frame::{Frame, Orientation};
use rawtisserie_pipeline::output::ColorSpace;
use rawtisserie_pipeline::{Developer, EditParams, RenderSize};

fn developer(name: &str) -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws").join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    Developer::from_bytes(&bytes).unwrap()
}

fn frames() -> Vec<Option<Frame>> {
    vec![
        None,
        Some(Frame { size: 0.0, ..Frame::default() }),
        Some(Frame::default()),
        Some(Frame { size: 0.137, line: 0.01, line_offset: 0.02, ..Frame::default() }),
        Some(Frame { size: 0.03, aspect: 1.0, ..Frame::default() }),
        Some(Frame { size: 0.05, aspect: 1.25, orientation: Orientation::Portrait, ..Frame::default() }),
        Some(Frame { size: 0.2, aspect: 16.0 / 9.0, orientation: Orientation::Landscape, position: [0.2, 0.9], ..Frame::default() }),
    ]
}

/// The exported size for a photo rendered within `size`.
fn exported(dev: &Developer, params: &EditParams, size: RenderSize, frame: Option<&Frame>) -> (usize, usize) {
    let (w, h, _) = dev.output_size(params, size);
    frame.map_or((w, h), |f| {
        let l = f.layout(w, h);
        (l.width, l.height)
    })
}

#[test]
fn exports_fit_their_bounds() {
    let cropped = EditParams::from_json(
        r#"{ "version": 6, "modules": [ { "kind": "geometry", "params": { "rotation": 1, "angle": 2.3,
            "crop": { "x": 0.1, "y": 0.05, "width": 0.61, "height": 0.85 } } } ] }"#,
    )
    .unwrap();
    let sizes: Vec<(Size, Box<dyn Fn(usize, usize) -> bool>)> = vec![
        (Size::LongEdge { size: 2048 }, Box::new(|w, h| w.max(h) <= 2048)),
        (Size::LongEdge { size: 333 }, Box::new(|w, h| w.max(h) <= 333)),
        (Size::ShortEdge { size: 1080 }, Box::new(|w, h| w.min(h) <= 1080)),
        (Size::Fit { width: 1000, height: 0 }, Box::new(|w, _| w <= 1000)),
        (Size::Fit { width: 1200, height: 700 }, Box::new(|w, h| w <= 1200 && h <= 700)),
        (Size::Megapixels { megapixels: 2.0 }, Box::new(|w, h| w * h <= 2_000_000)),
    ];
    for raw in ["sony-ilce-7m3.arw", "fujifilm-x-t30.raf"] {
        let dev = developer(raw);
        for params in [EditParams::default(), cropped.clone()] {
            for f in frames() {
                let f = f.as_ref();
                for (size, fits) in &sizes {
                    let render = export::render_size(&dev, &params, *size, f);
                    let (w, h) = exported(&dev, &params, render, f);
                    assert!(fits(w, h), "{raw} {f:?} {size:?}: {w}×{h}");
                    // The largest that fits: one more pixel of photo overflows (the
                    // photo's own size rounds, so allow for it without a frame).
                    let (pw, ..) = dev.output_size(&params, render);
                    let (w1, h1) = exported(&dev, &params, RenderSize::fit(pw as u32 + 2, 0), f);
                    assert!(!fits(w1, h1), "{raw} {f:?} {size:?}: only {w}×{h}");
                }
                // Unbounded, or bounds larger than the framed photo: full resolution.
                for size in [Size::Full, Size::LongEdge { size: 100_000 }, Size::Megapixels { megapixels: 1000.0 }] {
                    let render = export::render_size(&dev, &params, size, f);
                    assert_eq!(exported(&dev, &params, render, f), exported(&dev, &params, RenderSize::FULL, f), "{size:?}");
                }
            }
        }
    }
}

/// Decodes a PNG: size, bits per sample and samples (as 16 bits).
fn decode_png(bytes: &[u8]) -> (u32, u32, u8, Vec<u16>, png::Info<'static>) {
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut buf).unwrap();
    let depth = frame.bit_depth as u8;
    let samples = match depth {
        16 => buf[..frame.buffer_size()].chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect(),
        _ => buf[..frame.buffer_size()].iter().map(|&v| u16::from(v) * 257).collect(),
    };
    (frame.width, frame.height, depth, samples, reader.info().clone())
}

#[test]
fn framed_png_has_the_layout_and_colours() {
    let mut dev = developer("sony-ilce-7m3.arw");
    let params = EditParams::default();
    let frame = Frame { size: 0.1, aspect: 1.0, line: 0.01, color: "#ff0000".into(), ..Frame::default() };
    let meta = ExportMetadata { photo: dev.metadata().clone(), rating: 3, ..Default::default() };
    for (space, depth) in [(ColorSpace::Srgb, 8), (ColorSpace::DisplayP3, 16)] {
        let options = ExportOptions {
            format: Format::Png,
            depth,
            color_space: space,
            size: Size::LongEdge { size: 300 },
            frame: Some(frame.clone()),
            ..ExportOptions::default()
        };
        let file = export::render(&mut dev, &params, &options, &meta).unwrap();
        let (w, h, d, samples, info) = decode_png(&file);
        assert_eq!((w, h, d), (300, 300, depth));
        assert!(info.icc_profile.is_some() && info.exif_metadata.is_some());
        assert!(info.utf8_text.iter().any(|t| t.keyword == "XML:com.adobe.xmp"));
        // The corner is the border: sRGB red, in the export's space.
        let want = space.from_srgb([1.0, 0.0, 0.0]).map(|v| (v * 65535.0).round());
        for (got, want) in samples[..3].iter().zip(want) {
            assert!((f32::from(*got) - want).abs() <= 257.0, "{space:?}: {:?} vs {want:?}", &samples[..3]);
        }
    }
}

#[test]
fn sixteen_bits_match_eight_bits() {
    let mut dev = developer("sony-ilce-7m3.arw");
    let params = EditParams::default();
    let png = |dev: &mut Developer, depth| {
        let options = ExportOptions { format: Format::Png, depth, size: Size::LongEdge { size: 400 }, ..ExportOptions::default() };
        decode_png(&export::render(dev, &params, &options, &ExportMetadata::default()).unwrap()).3
    };
    let (eight, sixteen) = (png(&mut dev, 8), png(&mut dev, 16));
    assert_eq!(eight.len(), sixteen.len());
    // Same values, 8-bit ones rounded.
    let worst = eight.iter().zip(&sixteen).map(|(&a, &b)| (i32::from(a) - i32::from(b)).abs()).max().unwrap();
    assert!(worst <= 129, "{worst}");
    // And 16 bits have more than 256 levels in them.
    let mut levels: Vec<u16> = sixteen.iter().map(|v| v % 257).collect();
    levels.sort_unstable();
    levels.dedup();
    assert!(levels.len() > 100);
}

#[test]
fn tiff_and_sharpened_jpeg_encode() {
    let mut dev = developer("sony-ilce-7m3.arw");
    let params = EditParams::default();
    let options = ExportOptions { format: Format::Tiff, size: Size::LongEdge { size: 200 }, ..ExportOptions::default() };
    let tiff = export::render(&mut dev, &params, &options, &ExportMetadata::default()).unwrap();
    assert_eq!(&tiff[..4], b"II*\0");
    let options = ExportOptions { size: Size::LongEdge { size: 200 }, sharpening: export::Sharpening::High, ..ExportOptions::default() };
    let jpeg = export::render(&mut dev, &params, &options, &ExportMetadata::default()).unwrap();
    assert_eq!(&jpeg[..2], [0xff, 0xd8]);
}
