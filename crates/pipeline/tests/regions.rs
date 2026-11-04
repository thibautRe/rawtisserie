//! The developer's zoomed-in view renders only the region it shows
//! (`RenderSize::with_region`), from a patch of the sensor. It must look the same as
//! that part of a render of the whole image at the same size.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::ops::clipping::{DisplayClipping, Overlays};
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
