//! The developer's zoomed-in view renders only the region it shows
//! (`RenderSize::with_region`), from a patch of the sensor. It must look the same as
//! that part of a render of the whole image at the same size.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::ops::clipping::{DisplayClipping, MaskPart, MaskView, Overlays};
use rawtisserie_pipeline::params::{Blur, ContrastEqualizer, Geometry, Sharpen};
use rawtisserie_pipeline::{Developer, EditParams, Quality, Region, RenderSize, Rgba8};

fn developer() -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws/sony-ilce-7m3.arw");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    Developer::from_bytes(&bytes).unwrap()
}

const OVERLAYS: Overlays = Overlays {
    display: Some(DisplayClipping { mode: rawtisserie_pipeline::ops::clipping::ClipMode::AnyChannel, upper: 0.9, lower_ev: -8.0 }),
    sensor: true,
    stripes: 5.0,
    mask: None,
    mask_view: MaskView { part: MaskPart::Mask, values: false },
};

fn crop(img: &Rgba8, r: Region) -> Vec<u8> {
    (r.y..r.bottom()).flat_map(|y| &img.data[(y * img.width + r.x) * 4..(y * img.width + r.right()) * 4]).copied().collect()
}

/// Render `params` whole and by regions, at `size`, and compare.
fn check(name: &str, params: &EditParams, size: RenderSize) {
    // A fresh developer: the whole render then uses the base at its own binning factor.
    let mut dev = developer();
    let whole = dev.render_with_overlays(params, size, Quality::Final, &OVERLAYS);
    let (w, h) = (whole.width, whole.height);
    let regions = [
        Region { x: w / 3, y: h / 4, width: w / 4, height: h / 3 },
        Region { x: 0, y: 0, width: w / 2, height: h / 5 },
        Region { x: w - w / 5, y: h - h / 3, width: w / 5, height: h / 3 },
        // Partly outside: clipped.
        Region { x: w - 40, y: 10, width: 200, height: 60 },
    ];
    for region in regions {
        let img = dev.render_with_overlays(params, size.with_region(region), Quality::Final, &OVERLAYS);
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
    p.get_mut::<Sharpen>().amount = 1.5;
    p.get_mut::<Blur>().radius = 30.0;
    p.get_mut::<ContrastEqualizer>().luma = [0.7, 0.6, 0.55, 0.5, 0.65, 0.7];
    check("detail", &p, RenderSize::fit(1500, 1500));
}

#[test]
fn full_resolution_regions_match() {
    let dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    p.get_mut::<Geometry>().crop = rawtisserie_pipeline::params::Crop { x: 0.4, y: 0.3, width: 0.15, height: 0.2 };
    p.get_mut::<Sharpen>().amount = 1.0;
    check("100 %", &p, RenderSize::FULL);
    // The equalizer's margin is less than its reach (`equalizer::margin`): still within
    // a level with every band boosted to the maximum.
    p.get_mut::<ContrastEqualizer>().luma = [1.0; 6];
    check("100 %, equalizer", &p, RenderSize::FULL);
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
}
