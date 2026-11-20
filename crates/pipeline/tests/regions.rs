//! The developer's zoomed-in view renders only the region it shows
//! (`RenderSize::with_region`), from a patch of the sensor. It must look the same as
//! that part of a render of the whole image at the same size.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::ops::clipping::{DisplayClipping, MaskPart, MaskView, Overlays};
use rawtisserie_pipeline::params::{AutoCrop, ContrastEqualizer, Diffuse, Geometry, Glow, GlowShape};
use rawtisserie_pipeline::{Developer, EditParams, Quality, Region, RenderSize, Rgba8};

fn developer() -> Developer {
    Developer::from_bytes(&golden_raw("sony-ilce-7m3.arw")).unwrap()
}

fn golden_raw(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()))
}

const OVERLAYS: Overlays = Overlays {
    display: Some(DisplayClipping { mode: rawtisserie_pipeline::ops::clipping::ClipMode::AnyChannel, upper: 0.9, lower_ev: -8.0 }),
    sensor: true,
    stripes: 5.0,
    mask: None,
    mask_view: MaskView { part: MaskPart::Mask, values: false },
    tone_curve: None,
    tone_range: None,
};

fn crop(img: &Rgba8, r: Region) -> Vec<u8> {
    (r.y..r.bottom()).flat_map(|y| &img.data[(y * img.width + r.x) * 4..(y * img.width + r.right()) * 4]).copied().collect()
}

/// Render `params` whole and by regions, at `size`, and compare.
fn check(name: &str, params: &EditParams, size: RenderSize) {
    check_with(name, params, size, &OVERLAYS);
}

fn check_with(name: &str, params: &EditParams, size: RenderSize, overlays: &Overlays) {
    check_in(developer, name, params, size, overlays);
}

/// [`check_with`], on developers made by `new`.
fn check_in(new: impl Fn() -> Developer, name: &str, params: &EditParams, size: RenderSize, overlays: &Overlays) {
    // A fresh developer: the whole render then uses the base at its own binning factor.
    let mut dev = new();
    let whole = dev.render_with_overlays(params, size, Quality::Final, overlays);
    let (w, h) = (whole.width, whole.height);
    let regions = [
        Region { x: w / 3, y: h / 4, width: w / 4, height: h / 3 },
        Region { x: 0, y: 0, width: w / 2, height: h / 5 },
        Region { x: w - w / 5, y: h - h / 3, width: w / 5, height: h / 3 },
        // Partly outside: clipped.
        Region { x: w - 40, y: 10, width: 200, height: 60 },
    ];
    for region in regions {
        let img = dev.render_with_overlays(params, size.with_region(region), Quality::Final, overlays);
        let want = region.clipped(w, h);
        assert_eq!((img.width, img.height), (want.width, want.height), "{name} {region:?}");
        assert_eq!(dev.output_region(params, size.with_region(region)), want);
        let expected = crop(&whole, want);
        // Box blurs keep running sums, which round differently from another start.
        let worst = img.data.iter().zip(&expected).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
        assert!(worst <= 1, "{name} {region:?}: differs by up to {worst} levels");
        assert!(dev.is_spatial_cached(params, size.with_region(region)));
    }
}

#[test]
fn regions_match_the_whole_render() {
    let dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    check("default", &p, RenderSize::fit(1200, 1200));

    let g = p.get_mut::<Geometry>();
    g.angle = 2.5;
    g.rotation = 1;
    g.flip_horizontal = true;
    g.crop = rawtisserie_pipeline::params::Crop { x: 0.1, y: 0.05, width: 0.7, height: 0.8 };
    p.add(Diffuse::default());
    p.get_mut::<ContrastEqualizer>().luma = [0.7, 0.6, 0.55, 0.5, 0.65, 0.7];
    check("detail", &p, RenderSize::fit(1500, 1500));

    // Glow: computed on reduced copies aligned on the frame, so regions match.
    let mut glowing = p.clone();
    glowing.add(Glow { threshold: 0.5, radius: 120.0, strength: 2.0, saturation: 0.6, ..Glow::default() });
    glowing.add(Glow { threshold: 1.0, radius: 8.0, strength: 3.0, ..Glow::default() });
    check("glow", &glowing, RenderSize::fit(1500, 1500));
    // Along an axis: on a turned grid fixed in the frame.
    let mut streaks = p.clone();
    streaks.add(Glow { threshold: 0.5, radius: 200.0, strength: 2.0, shape: GlowShape::Streak, angle: 20.0, thickness: 0.02, ..Glow::default() });
    streaks.add(Glow { threshold: 1.0, radius: 60.0, strength: 2.0, shape: GlowShape::Motion, angle: -125.0, ..Glow::default() });
    // Without the display indicator, as for perspective below: a pixel within the level
    // allowed lands on either side of its threshold.
    let no_display = Overlays { display: None, ..OVERLAYS };
    check_with("streak and motion glow", &streaks, RenderSize::fit(1500, 1500), &no_display);

    // Diffuse or sharpen: iterated, so its margin is its reach times the iterations.
    // Ansel's "lens deblur: soft", and "inpaint highlights" (noise seeded by frame
    // position) on a threshold low enough to cover much of the image.
    let mut diffused = p.clone();
    diffused.add(Diffuse {
        iterations: 8.0,
        radius: 8.0,
        speed1: -0.25,
        speed2: 0.125,
        speed3: -0.125,
        speed4: 0.0625,
        anisotropy1: 2.0,
        anisotropy2: 0.0,
        anisotropy3: 2.0,
        anisotropy4: 0.0,
        ..Diffuse::default()
    });
    diffused.add(Diffuse {
        iterations: 32.0,
        radius: 4.0,
        luminance_threshold: 0.2,
        speed1: 0.0,
        speed2: 0.0,
        speed3: 0.0,
        speed4: 0.5,
        anisotropy1: 0.0,
        anisotropy2: 0.0,
        anisotropy3: 0.0,
        anisotropy4: 2.0,
        edge_sensitivity: 0.0,
        ..Diffuse::default()
    });
    check("diffuse", &diffused, RenderSize::fit(1500, 1500));

    // Perspective: a homography, framed each way (black borders when not auto-cropped).
    let g = p.get_mut::<Geometry>();
    (g.vertical, g.horizontal, g.shear, g.aspect) = (14.0, -6.0, 0.04, 0.2);
    // Without the display indicator: it thresholds the rendered values, and a pixel
    // within the level of difference allowed can land on either side.
    let overlays = Overlays { display: None, ..OVERLAYS };
    for auto_crop in [AutoCrop::Aspect, AutoCrop::Area, AutoCrop::Off] {
        p.get_mut::<Geometry>().auto_crop = auto_crop;
        check_with(&format!("perspective, {auto_crop:?}"), &p, RenderSize::fit(1500, 1500), &overlays);
    }
}

#[test]
fn full_resolution_regions_match() {
    let dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    p.get_mut::<Geometry>().crop = rawtisserie_pipeline::params::Crop { x: 0.4, y: 0.3, width: 0.15, height: 0.2 };
    check("100 %", &p, RenderSize::FULL);
    // Diffuse's default (sharpen demosaicing) first, as the unsharp mask was: the
    // equalizer alone at 100 % is 2 levels off here, its margin being less than its reach.
    p.add(Diffuse::default());
    // The equalizer's margin is less than its reach (`equalizer::margin`): still within
    // a level with every band boosted to the maximum.
    p.get_mut::<ContrastEqualizer>().luma = [1.0; 6];
    check("100 %, equalizer", &p, RenderSize::FULL);
    p.add(Glow { threshold: 0.0, radius: 300.0, ..Glow::default() });
    check("100 %, glow", &p, RenderSize::FULL);
    // Reaching further than the margin's cap: its regions are developed whole.
    let mut wide = EditParams::default_for(dev.metadata());
    wide.get_mut::<Geometry>().crop = rawtisserie_pipeline::params::Crop { x: 0.2, y: 0.2, width: 0.6, height: 0.5 };
    wide.add(Glow { threshold: 0.0, radius: 1000.0, ..Glow::default() });
    check("100 %, wide glow", &wide, RenderSize::FULL);
    check("100 %, diffuse", &p, RenderSize::FULL);
    // Many iterations at full size: the margin is much less than the reach
    // (`DiffuseOp::reach`). Ansel's "lens deblur: medium".
    p.add(Diffuse {
        iterations: 16.0,
        radius: 10.0,
        speed1: -0.25,
        speed2: 0.125,
        speed3: -0.125,
        speed4: 0.0625,
        anisotropy1: 2.0,
        anisotropy2: 0.0,
        anisotropy3: 2.0,
        anisotropy4: 0.0,
        ..Diffuse::default()
    });
    check("100 %, lens deblur", &p, RenderSize::FULL);
    let mut rgb = [0.0; 9];
    rgb[2] = 1.0;
    p.add(rawtisserie_pipeline::params::ToneCurve { preserve_detail: true, rgb, ..Default::default() });
    check("100 %, tones", &p, RenderSize::FULL);
}

#[test]
fn regions_have_their_own_cache() {
    let mut dev = developer();
    let p = EditParams::default_for(dev.metadata());
    let size = RenderSize::fit(1200, 1200);
    let a = size.with_region(Region { x: 100, y: 100, width: 300, height: 200 });
    let b = size.with_region(Region { x: 150, y: 100, width: 300, height: 200 });
    let (whole, _) = dev.spatial_image_id(&p, size);
    let (ia, _) = dev.spatial_image_id(&p, a);
    let (ib, _) = dev.spatial_image_id(&p, b);
    assert!(ia != whole && ib != ia);
    // The whole image and both regions fit in the cache.
    assert!(dev.is_spatial_cached(&p, size) && dev.is_spatial_cached(&p, a));
    assert_eq!(dev.spatial_image_id(&p, size).0, whole);
}

#[test]
fn retouched_regions_match() {
    let dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    // Spots of every kind and shape, some with sources well outside the regions, one
    // healing from where another one cloned to, and one across the sensor's edge.
    let spots: EditParams = serde_json::from_value(serde_json::json!({
        "version": 6,
        "modules": [{ "kind": "retouch", "params": { "spots": [
            { "shape": "a", "mode": "heal", "source": [0.2, 0.05] },
            { "shape": "b", "mode": "clone", "source": [-0.15, 0.1], "opacity": 0.8 },
            { "shape": "c", "mode": "heal", "source": [0.1, 0.0] },
            { "shape": "d", "mode": "fill", "color": [0.3, 0.1, 0.05] },
            { "shape": "e", "mode": "blur", "radius": 12 },
            { "shape": "f", "mode": "heal", "source": [0.0, 0.3] }
        ] } }],
        "shapes": {
            "a": { "type": "ellipse", "center": [0.4, 0.35], "radii": [0.03, 0.02], "rotation": 0.4, "feather": 0.01 },
            "b": { "type": "ellipse", "center": [0.62, 0.3], "radii": [0.05, 0.05], "feather": 0.02 },
            "c": { "type": "ellipse", "center": [0.37, 0.4], "radii": [0.04, 0.04], "feather": 0.01 },
            "d": { "type": "path", "feather": 0.01, "points": [
                [0.7, 0.6, 0.7, 0.6, 0.75, 0.55], [0.8, 0.62, 0.8, 0.62, 0.8, 0.62], [0.74, 0.72, 0.74, 0.72, 0.74, 0.72]
            ] },
            "e": { "type": "brush", "points": [[0.2, 0.7, 0.02, 0.5], [0.3, 0.75, 0.03, 0.5], [0.35, 0.8, 0.02, 0.8]] },
            "f": { "type": "ellipse", "center": [0.98, 0.1], "radii": [0.04, 0.04] }
        }
    }))
    .unwrap();
    p.modules.extend(spots.modules);
    p.shapes = spots.shapes;
    p.normalize();
    assert_eq!(p.shapes.len(), 6);
    check("retouch", &p, RenderSize::fit(1200, 1200));
    p.get_mut::<Geometry>().angle = -3.0;
    p.get_mut::<Geometry>().rotation = 3;
    check("retouch, rotated", &p, RenderSize::fit(1500, 1500));
}

#[test]
fn moving_a_spot_restores_the_pixels_under_it() {
    let mut dev = developer();
    let base = EditParams::default_for(dev.metadata());
    let size = RenderSize::fit(800, 800);
    let before = dev.render(&base, size, Quality::Final);
    let with = |x: f32| {
        let mut p = base.clone();
        let json = serde_json::json!({ "version": 6, "modules": [{ "kind": "retouch", "params": { "spots": [
            { "shape": "s", "mode": "fill", "color": [1, 0, 0] }] } }],
            "shapes": { "s": { "type": "ellipse", "center": [x, 0.5], "radii": [0.05, 0.05] } } });
        let spot: EditParams = serde_json::from_value(json).unwrap();
        p.modules.extend(spot.modules);
        p.shapes = spot.shapes;
        p.normalize();
        p
    };
    let a = dev.render(&with(0.3), size, Quality::Final);
    assert_ne!(a.data, before.data);
    // Same developer: the base was retouched in place and must come back.
    let b = dev.render(&with(0.7), size, Quality::Final);
    let fresh = developer().render(&with(0.7), size, Quality::Final);
    assert_eq!(b.data, fresh.data);
    assert_eq!(dev.render(&base, size, Quality::Final).data, before.data);
}

#[test]
fn masked_regions_match() {
    let dev = developer();
    let base = EditParams::default_for(dev.metadata());
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/recipes/masks.json");
    let case: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut p: EditParams = serde_json::from_value(case["recipe"].clone()).unwrap();
    // With the camera's lens correction too.
    p.modules.extend(base.modules.into_iter().filter(|m| m.module.kind() == rawtisserie_pipeline::params::ModuleKind::Lens));
    p.normalize();
    check("masks", &p, RenderSize::fit(1200, 1200));
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/recipes/blend.json");
    let blend: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    check("blend", &serde_json::from_value(blend["recipe"].clone()).unwrap(), RenderSize::fit(1200, 1200));
    // Tone curves preserving detail: their masks are smoothed over a fraction of the frame.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/recipes/tones_local.json");
    let tones: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let tones: EditParams = serde_json::from_value(tones["recipe"].clone()).unwrap();
    check("tones", &tones, RenderSize::fit(1200, 1200));
    // Mask overlays as well: the mask, a range alone, and the values of each part.
    let mut dev = developer();
    let size = RenderSize::fit(1000, 1000);
    let region = Region { x: 300, y: 200, width: 250, height: 200 };
    let plain = dev.render(&p, size.with_region(region), Quality::Final);
    let mut views = vec![("subject", MaskView::default()), ("sky", MaskView { part: MaskPart::Luminance, values: false })];
    for part in [MaskPart::Luminance, MaskPart::Saturation, MaskPart::Hue, MaskPart::Red, MaskPart::Blue] {
        views.push(("sky", MaskView { part, values: true }));
    }
    for (id, view) in views {
        let overlays = Overlays { mask: Some(id.into()), mask_view: view, ..OVERLAYS };
        let whole = dev.render_with_overlays(&p, size, Quality::Final, &overlays);
        let part = dev.render_with_overlays(&p, size.with_region(region), Quality::Final, &overlays);
        let worst = part.data.iter().zip(crop(&whole, region)).map(|(a, b)| a.abs_diff(b)).max().unwrap();
        assert!(worst <= 1, "{view:?}: mask overlay differs by up to {worst} levels");
        assert_ne!(part.data, plain.data, "{view:?}: the overlay shows");
    }
    // The tone curve overlay too, with a node tinted.
    p.add(rawtisserie_pipeline::params::ToneCurve { range: [-4.0, 3.0], ..Default::default() });
    let id = p.modules.iter().rev().find(|m| m.module.kind() == rawtisserie_pipeline::params::ModuleKind::ToneCurve).unwrap().id.clone();
    let view = rawtisserie_pipeline::ops::clipping::ToneCurveView { id, channel: None, node: Some(4) };
    let overlays = Overlays { tone_curve: Some(view), ..OVERLAYS };
    let whole = dev.render_with_overlays(&p, size, Quality::Final, &overlays);
    let part = dev.render_with_overlays(&p, size.with_region(region), Quality::Final, &overlays);
    let worst = part.data.iter().zip(crop(&whole, region)).map(|(a, b)| a.abs_diff(b)).max().unwrap();
    assert!(worst <= 1, "tone curve overlay differs by up to {worst} levels");
    assert_ne!(part.data, plain.data, "the tone curve overlay shows");
    // And colour balance's ranges.
    p.add(rawtisserie_pipeline::params::ColorBalance { chroma: [0.2; 3], ..Default::default() });
    let id = p.modules.iter().find(|m| m.module.kind() == rawtisserie_pipeline::params::ModuleKind::ColorBalance).unwrap().id.clone();
    for range in 0..3 {
        let view = rawtisserie_pipeline::ops::clipping::ToneRangeView { id: id.clone(), range };
        let overlays = Overlays { tone_range: Some(view), ..OVERLAYS };
        let whole = dev.render_with_overlays(&p, size, Quality::Final, &overlays);
        let part = dev.render_with_overlays(&p, size.with_region(region), Quality::Final, &overlays);
        let worst = part.data.iter().zip(crop(&whole, region)).map(|(a, b)| a.abs_diff(b)).max().unwrap();
        assert!(worst <= 1, "range {range} overlay differs by up to {worst} levels");
    }
}

#[test]
fn x_trans_base_regions_match() {
    // Markesteijn's tiles are fixed on the sensor: a region runs the ones holding it.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws/fujifilm-x-t30.raf");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    let photo = rawtisserie_pipeline::decode::decode(&bytes).unwrap();
    let whole = rawtisserie_pipeline::demosaic::develop_base(&photo, 1);
    let (w, h) = (whole.width, whole.height);
    for r in [
        Region { x: w / 3 + 1, y: h / 4 + 5, width: 300, height: 200 },
        Region { x: 0, y: 0, width: 130, height: 70 },
        Region { x: w - 77, y: h - 101, width: 77, height: 101 },
        Region { x: 517, y: h - 3, width: 1, height: 3 },
    ] {
        let part = rawtisserie_pipeline::demosaic::develop_base_region(&photo, 1, r);
        for y in 0..r.height {
            for x in 0..r.width {
                assert_eq!(part.get(x, y), whole.get(r.x + x, r.y + y), "{r:?} at {x},{y}");
            }
        }
    }
}

#[test]
fn multiple_exposure_regions_match() {
    use rawtisserie_pipeline::params::{ExposureBlend, MultipleExposure, PhotoRef};
    use rawtisserie_pipeline::decode;
    // The same sensor size, then another one (scaled to cover, centred).
    for (other, blend) in [("sony-ilce-7m3.arw", ExposureBlend::Lighten), ("nikon-z6.nef", ExposureBlend::Average)] {
        let bytes = golden_raw(other);
        let new = || {
            let dev = developer();
            dev.exposures_mut().insert("ab", decode::decode(&bytes).unwrap());
            dev
        };
        let dev = new();
        let mut p = EditParams::default_for(dev.metadata());
        p.add(MultipleExposure { photo: Some(PhotoRef { sha256: "AB".into(), name: other.into() }), blend, ev: -0.5 });
        let size = RenderSize::fit(1200, 1200);
        check_in(new, other, &p, size, &OVERLAYS);
        p.get_mut::<Geometry>().crop = rawtisserie_pipeline::params::Crop { x: 0.4, y: 0.3, width: 0.1, height: 0.1 };
        check_in(new, &format!("{other}, 100 %"), &p, RenderSize::FULL, &OVERLAYS);
    }
}

#[test]
fn multiple_exposure_changes_the_render() {
    use rawtisserie_pipeline::params::{ExposureBlend, MultipleExposure, PhotoRef};
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    let size = RenderSize::fit(600, 600);
    let plain = dev.render(&p, size, Quality::Final);
    p.add(MultipleExposure { photo: Some(PhotoRef { sha256: "ab".into(), name: String::new() }), blend: ExposureBlend::Additive, ev: 0.0 });
    // Not loaded: skipped.
    assert_eq!(dev.render(&p, size, Quality::Final).data, plain.data);
    dev.exposures_mut().insert("ab", rawtisserie_pipeline::decode::decode(&golden_raw("canon-eos-r6.cr3")).unwrap());
    assert!(!dev.is_spatial_cached(&p, size));
    let added = dev.render(&p, size, Quality::Final);
    assert_ne!(added.data, plain.data);
    // Another gain: the base again, the same as from a fresh developer.
    p.get_mut::<MultipleExposure>().ev = -1.0;
    assert!(!dev.is_spatial_cached(&p, size));
    let lower = dev.render(&p, size, Quality::Final);
    let mut fresh = developer();
    fresh.exposures_mut().insert("ab", rawtisserie_pipeline::decode::decode(&golden_raw("canon-eos-r6.cr3")).unwrap());
    assert_eq!(fresh.render(&p, size, Quality::Final).data, lower.data);
    // Removed: as before.
    p.modules.retain(|m| m.module.kind() != rawtisserie_pipeline::params::ModuleKind::MultipleExposure);
    assert_eq!(dev.render(&p, size, Quality::Final).data, plain.data);
}
