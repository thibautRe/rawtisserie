//! The colour picker (`Developer::sample`): one pixel of a render, as the render shows it,
//! and what the modules with a graph read there. Uses the golden RAWs
//! (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::params::{ColorBalance, Exposure, Glow, ToneCurve};
use rawtisserie_pipeline::{Developer, EditParams, Quality, Region, RenderSize};

fn developer() -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws/sony-ilce-7m3.arw");
    Developer::from_bytes(&std::fs::read(path).expect("golden RAW: run ./scripts/fetch-golden-raws.sh")).unwrap()
}

#[test]
fn a_sample_is_the_rendered_pixel() {
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    p.get_mut::<Exposure>().ev = 0.7;
    p.add(ToneCurve::default());
    p.add(ColorBalance::default());
    let size = RenderSize::fit(600, 600);
    let img = dev.render(&p, size, Quality::Interactive);
    for (x, y) in [(10, 10), (300, 200), (img.width - 1, img.height - 1)] {
        let s = dev.sample(&p, size, x, y).expect("cached");
        let at = (y * img.width + x) * 4;
        for c in 0..3 {
            assert!(s.display[c].abs_diff(img.data[at + c]) <= 1, "{x},{y}: {:?} vs {:?}", s.display, &img.data[at..at + 3]);
        }
        // One read per tone curve and colour balance instance (the default recipe has a
        // colour balance of its own).
        let tone = p.modules.iter().find(|m| m.module.kind() == rawtisserie_pipeline::params::ModuleKind::ToneCurve).unwrap();
        assert!(s.reads.iter().any(|r| r.id == tone.id && !r.ev.is_empty()));
        assert!(s.reads.iter().all(|r| r.ev.iter().all(|v| v.is_finite())));
        assert!(s.scene_ev.is_finite());
    }
    // Brighter exposure: brighter scene.
    let before = dev.sample(&p, size, 300, 200).unwrap().scene_ev;
    p.get_mut::<Exposure>().ev += 1.0;
    let after = dev.sample(&p, size, 300, 200).unwrap().scene_ev;
    assert!((after - before - 1.0).abs() < 0.05, "{before} {after}");
}

#[test]
fn nothing_without_the_spatial_cache_or_outside_the_region() {
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    let size = RenderSize::fit(600, 600);
    assert!(dev.sample(&p, size, 10, 10).is_none(), "nothing rendered yet");
    dev.render(&p, size, Quality::Interactive);
    assert!(dev.sample(&p, size, 10, 10).is_some());
    // A spatial edit: not rendered yet, so nothing (sampling must not render).
    p.add(Glow::default());
    assert!(dev.sample(&p, size, 10, 10).is_none());
    // A region: only its own pixels.
    let region = size.with_region(Region { x: 100, y: 100, width: 50, height: 40 });
    dev.render(&p, region, Quality::Interactive);
    assert!(dev.sample(&p, region, 120, 110).is_some());
    assert!(dev.sample(&p, region, 10, 10).is_none());
}
