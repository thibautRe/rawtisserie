//! A framed export fits the export bounds, and fills them as well as it can.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::frame::{self, Frame, Orientation};
use rawtisserie_pipeline::{Developer, EditParams, RenderSize};

fn developer(name: &str) -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws").join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    Developer::from_bytes(&bytes).unwrap()
}

fn frames() -> Vec<Frame> {
    vec![
        Frame { size: 0.0, ..Frame::default() },
        Frame::default(),
        Frame { size: 0.137, line: 0.01, line_offset: 0.02, ..Frame::default() },
        Frame { size: 0.03, aspect: 1.0, ..Frame::default() },
        Frame { size: 0.05, aspect: 1.25, orientation: Orientation::Portrait, ..Frame::default() },
        Frame { size: 0.2, aspect: 16.0 / 9.0, orientation: Orientation::Landscape, position: [0.2, 0.9], ..Frame::default() },
    ]
}

#[test]
fn framed_exports_fit_their_bounds() {
    let cropped = EditParams::from_json(
        r#"{ "version": 6, "modules": [ { "kind": "geometry", "params": { "rotation": 1, "angle": 2.3,
            "crop": { "x": 0.1, "y": 0.05, "width": 0.61, "height": 0.85 } } } ] }"#,
    )
    .unwrap();
    for raw in ["sony-ilce-7m3.arw", "fujifilm-x-t30.raf"] {
        let dev = developer(raw);
        for params in [EditParams::default(), cropped.clone()] {
            for f in frames() {
                for max in [3840, 2048, 1080, 1000, 333] {
                    let size = frame::fit(&dev, &params, max, max, &f);
                    let (w, h, _) = dev.output_size(&params, size);
                    let l = f.layout(w, h);
                    assert!(l.width.max(l.height) <= max as usize, "{raw} {f:?} at {max}: {}×{}", l.width, l.height);
                    // The largest that fits: one more pixel of photo overflows.
                    let (w1, h1, _) = dev.output_size(&params, RenderSize::fit(w as u32 + 1, 0));
                    let l1 = f.layout(w1, h1);
                    assert!(l1.width.max(l1.height) > max as usize, "{raw} {f:?} at {max}: only {}×{}", l.width, l.height);
                }
                // Unbounded, or bounds larger than the framed photo: full resolution.
                assert_eq!(frame::fit(&dev, &params, 0, 0, &f).max_width, RenderSize::FULL.max_width);
                assert_eq!(frame::fit(&dev, &params, 100_000, 100_000, &f).max_width, RenderSize::FULL.max_width);
            }
        }
    }
}

#[test]
fn framed_render_has_the_layout_size() {
    let mut dev = developer("sony-ilce-7m3.arw");
    let params = EditParams::default();
    let f = Frame { size: 0.1, aspect: 1.0, line: 0.01, ..Frame::default() };
    let img = frame::render(&mut dev, &params, 300, 300, Some(&f));
    assert_eq!((img.width, img.height), (300, 300));
    assert_eq!(img.data.len(), 300 * 300 * 4);
}
