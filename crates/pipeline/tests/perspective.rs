//! Perspective correction end to end, on a photo. The guides and the fit work in the
//! full sensor's frame (`Developer::sensor_mapping`); renders read a base binned for
//! their size. Both must agree, whatever the size.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::ops::lines::GuideLine;
use rawtisserie_pipeline::ops::perspective::FitMode;
use rawtisserie_pipeline::params::{AutoCrop, Geometry};
use rawtisserie_pipeline::{Developer, EditParams, Quality, RenderSize, Rgba8};

fn developer(name: &str) -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws").join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    Developer::from_bytes(&bytes).unwrap()
}

#[test]
fn fitted_guides_are_straight_where_they_are_drawn() {
    let mut dev = developer("leica-m10.dng");
    let mut params = EditParams::default_for(dev.metadata());
    let detected = dev.detect_lines(&params, RenderSize::fit(1600, 1600));
    let guides: Vec<GuideLine> = detected.iter().filter(|s| s.selected).map(|s| GuideLine { a: s.a, b: s.b, vertical: s.vertical }).collect();
    for mode in [FitMode::Vertical, FitMode::Both] {
        let fit = dev.fit_perspective(&params, &guides, mode).expect("a fit");
        let g: &mut Geometry = params.get_mut();
        (g.angle, g.vertical, g.horizontal, g.shear) = (fit.angle, fit.vertical, fit.horizontal, fit.shear);
        // Where the developer draws them over the corrected image (in its pixels).
        let (w, h, _) = dev.output_size(&params, RenderSize::FULL);
        let m = dev.sensor_mapping(&params);
        let mut worst: f32 = 0.0;
        for l in guides.iter().filter(|l| l.vertical || mode == FitMode::Both) {
            let (a, b) = (m.from_sensor(l.a.0, l.a.1), m.from_sensor(l.b.0, l.b.1));
            let (dx, dy) = ((b.0 - a.0) * w as f32, (b.1 - a.1) * h as f32);
            worst = worst.max(if l.vertical { dx / dy } else { dy / dx }.atan().to_degrees().abs());
        }
        // The guides were detected on a 1600 px render: they're good to a pixel or so.
        assert!(worst < 1.5, "{mode:?} {fit:?}: a guide is {worst:.2}° off");
    }
}

/// Mean absolute difference (8-bit levels) between `small` and `large` averaged down to it.
fn difference(small: &Rgba8, large: &Rgba8) -> f64 {
    let (kx, ky) = (large.width as f64 / small.width as f64, large.height as f64 / small.height as f64);
    let mut total = 0.0;
    for y in 0..small.height {
        for x in 0..small.width {
            let (x0, x1) = ((x as f64 * kx) as usize, (((x + 1) as f64 * kx) as usize).min(large.width));
            let (y0, y1) = ((y as f64 * ky) as usize, (((y + 1) as f64 * ky) as usize).min(large.height));
            for c in 0..3 {
                let mut sum = 0.0;
                for v in y0..y1 {
                    for u in x0..x1 {
                        sum += large.data[(v * large.width + u) * 4 + c] as f64;
                    }
                }
                let mean = sum / ((x1 - x0) * (y1 - y0)) as f64;
                total += (mean - small.data[(y * small.width + x) * 4 + c] as f64).abs();
            }
        }
    }
    total / (small.width * small.height * 3) as f64
}

#[test]
fn renders_bend_the_same_at_every_size() {
    let mut dev = developer("leica-m10.dng");
    let mut params = EditParams::default_for(dev.metadata());
    let g: &mut Geometry = params.get_mut();
    (g.angle, g.vertical, g.horizontal, g.shear) = (1.5, 15.0, -8.0, 0.03);
    for auto_crop in [AutoCrop::Aspect, AutoCrop::Off] {
        params.get_mut::<Geometry>().auto_crop = auto_crop;
        // From a base binned 8× and one binned 2×.
        let small = dev.render(&params, RenderSize::fit(600, 600), Quality::Final);
        let large = dev.render(&params, RenderSize::fit(2400, 2400), Quality::Final);
        let diff = difference(&small, &large);
        // Two sizes never match exactly (textures resample differently): compare with
        // the same renders without perspective. A perspective that bends differently
        // at each size differs by several times more.
        let mut plain = params.clone();
        let g: &mut Geometry = plain.get_mut();
        (g.vertical, g.horizontal, g.shear) = (0.0, 0.0, 0.0);
        let small_plain = dev.render(&plain, RenderSize::fit(600, 600), Quality::Final);
        let base = difference(&small_plain, &dev.render(&plain, RenderSize::fit(2400, 2400), Quality::Final));
        assert!(diff < 1.5 * base, "{auto_crop:?}: renders differ by {diff:.1} levels on average ({base:.1} without perspective)");
    }
}
