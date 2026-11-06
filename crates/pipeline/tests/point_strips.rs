//! The web developer splits the point operations of a render across workers, each
//! holding a strip of the spatial image (`apps/web/src/develop/pointPool.ts`). The
//! strips must put together exactly what `Developer::render` gives.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`) and recipes.

use std::path::Path;

use rawtisserie_pipeline::params::{Blur, DrawnShape, Exposure, Mask, Shape};
use rawtisserie_pipeline::pipeline::PointRenderer;
use rawtisserie_pipeline::{Developer, EditParams, Image, Quality, RenderSize};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    recipe: EditParams,
}

const SIZE: RenderSize = RenderSize::fit(900, 900);

fn developer() -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws/sony-ilce-7m3.arw");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    Developer::from_bytes(&bytes).unwrap()
}

fn strips(dev: &mut Developer, params: &EditParams, n: usize) -> Vec<PointRenderer> {
    let as_shot = dev.photo().as_shot_illuminant;
    let (_, img, masks) = dev.spatial(params, SIZE);
    let rows = img.height.div_ceil(n);
    (0..img.height)
        .step_by(rows)
        .map(|y0| {
            let y1 = (y0 + rows).min(img.height);
            let pixels = img.pixels[y0 * img.width..y1 * img.width].to_vec();
            let masks = masks.iter().map(|m| m.rows(img.width, y0, y1)).collect();
            PointRenderer::with_masks(Image { width: img.width, height: y1 - y0, pixels }, masks, as_shot)
        })
        .collect()
}

#[test]
fn strips_match_the_full_render() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/recipes");
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let case: Case = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // A fresh developer, like the strips: a developer that rendered a recipe with the
        // same filmic parameters before would use filmic's 3D table on the first pass.
        let mut dev = developer();
        let mut parts = strips(&mut dev, &case.recipe, 5);
        // Twice: the second render of the same recipe goes through filmic's 3D table.
        for pass in 0..2 {
            let want = dev.render(&case.recipe, SIZE, Quality::Interactive);
            let got: Vec<u8> = parts.iter_mut().flat_map(|p| p.render(&case.recipe, Quality::Interactive).data).collect();
            assert!(got == want.data, "{} (pass {pass}): strips differ from the full render", path.display());
        }
    }
}

#[test]
fn spatial_cache_and_ids_follow_the_spatial_parameters() {
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    assert!(!dev.is_spatial_cached(&p, SIZE));
    let (id, _) = dev.spatial_image_id(&p, SIZE);
    assert!(dev.is_spatial_cached(&p, SIZE));

    p.get_mut::<Exposure>().ev += 0.5;
    assert!(dev.is_spatial_cached(&p, SIZE), "exposure is a point operation");
    assert_eq!(dev.spatial_image_id(&p, SIZE).0, id);

    p.get_mut::<Blur>().radius = 10.0;
    assert!(!dev.is_spatial_cached(&p, SIZE), "blur is spatial");
    let (blurred, _) = dev.spatial_image_id(&p, SIZE);
    assert_ne!(blurred, id);
    assert!(dev.is_spatial_cached(&p, SIZE));

    // Another size has its own cache and id; going back to the first one keeps its image.
    let draft = RenderSize::fit(400, 400);
    assert!(!dev.is_spatial_cached(&p, draft));
    let (small, _) = dev.spatial_image_id(&p, draft);
    assert_ne!(small, blurred);
    assert_eq!(dev.spatial_image_id(&p, SIZE).0, blurred);
}

#[test]
fn masks_are_spatial_only_through_their_shapes() {
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    p.shapes.insert("s".into(), Shape::Ellipse { center: [0.5, 0.5], radii: [0.2, 0.2], rotation: 0.0, feather: 0.02, opacity: 1.0 });
    p.add(Exposure { ev: 1.0, black: 0.0 });
    let masked = p.modules.iter().rposition(|m| m.id == "exposure-2").unwrap();
    p.modules[masked].mask = Some(Mask { drawn: vec![DrawnShape { shape: "s".into(), ..Default::default() }], feather: 20.0, ..Mask::default() });
    let (id, _) = dev.spatial_image_id(&p, SIZE);
    assert!(dev.is_spatial_cached(&p, SIZE));

    // Invert and opacity are per pixel.
    let mask = p.modules[masked].mask.as_mut().unwrap();
    mask.opacity = 0.5;
    mask.invert = true;
    assert!(dev.is_spatial_cached(&p, SIZE), "invert and opacity are point operations");
    assert_eq!(dev.spatial_image_id(&p, SIZE).0, id);
    // So are ranges, without a feather.
    let mask = p.modules[masked].mask.as_mut().unwrap();
    mask.feather = 0.0;
    dev.spatial_image_id(&p, SIZE);
    p.modules[masked].mask.as_mut().unwrap().luminance = Some([-2.0, -1.0, 3.0, 4.0]);
    assert!(dev.is_spatial_cached(&p, SIZE), "unfeathered ranges are point operations");
    // With a feather, the whole mask is measured and feathered with the spatial stages:
    // its ranges and the point modules before it are spatial, invert and opacity aren't.
    p.modules[masked].mask.as_mut().unwrap().feather = 20.0;
    assert!(!dev.is_spatial_cached(&p, SIZE));
    let (whole, _) = dev.spatial_image_id(&p, SIZE);
    p.modules[masked].mask.as_mut().unwrap().luminance = Some([-2.0, -1.0, 2.0, 4.0]);
    assert!(!dev.is_spatial_cached(&p, SIZE), "feathered ranges are spatial");
    dev.spatial_image_id(&p, SIZE);
    p.get_mut::<Exposure>().ev += 0.3;
    assert!(!dev.is_spatial_cached(&p, SIZE), "so is what comes before the mask");
    let (pushed, _) = dev.spatial_image_id(&p, SIZE);
    assert_ne!(pushed, whole);
    p.modules[masked].mask.as_mut().unwrap().opacity = 0.8;
    if let rawtisserie_pipeline::params::Module::Exposure(e) = &mut p.modules[masked].module {
        e.ev = 0.4;
    }
    assert!(dev.is_spatial_cached(&p, SIZE), "the masked module itself, its opacity and invert aren't");

    // The shape, its feather, and the drawn list are spatial.
    p.shapes.insert("s".into(), Shape::Ellipse { center: [0.4, 0.5], radii: [0.2, 0.2], rotation: 0.0, feather: 0.02, opacity: 1.0 });
    assert!(!dev.is_spatial_cached(&p, SIZE), "moving the shape changes the drawn plane");
    let (moved, _) = dev.spatial_image_id(&p, SIZE);
    assert_ne!(moved, id);
    p.modules[masked].mask.as_mut().unwrap().feather = 5.0;
    assert!(!dev.is_spatial_cached(&p, SIZE));
    dev.spatial_image_id(&p, SIZE);
    // Switching the instance off drops its plane.
    p.modules[masked].enabled = false;
    assert!(!dev.is_spatial_cached(&p, SIZE));
    let (_, _, masks) = dev.spatial(&p, SIZE);
    assert!(masks.is_empty());
}

#[test]
fn a_masked_exposure_applies_inside_its_shape_only() {
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    let before = dev.render(&p, SIZE, Quality::Final);
    // The left half of the sensor (no geometry: the left half of the image).
    p.shapes.insert("left".into(), Shape::Gradient { anchor: [0.5, 0.5], angle: std::f32::consts::PI, feather: 0.0, opacity: 1.0 });
    p.add(Exposure { ev: 2.0, black: 0.0 });
    let i = p.modules.iter().rposition(|m| m.id == "exposure-2").unwrap();
    p.modules[i].mask = Some(Mask { drawn: vec![DrawnShape { shape: "left".into(), ..Default::default() }], ..Mask::default() });
    let after = dev.render(&p, SIZE, Quality::Final);
    let w = after.width;
    let luma = |img: &rawtisserie_pipeline::Rgba8, x0: usize, x1: usize| -> f64 {
        let mut sum = 0.0;
        for y in 0..img.height {
            for x in x0..x1 {
                let k = (y * img.width + x) * 4;
                sum += img.data[k] as f64 + img.data[k + 1] as f64 + img.data[k + 2] as f64;
            }
        }
        sum / ((x1 - x0) * img.height) as f64
    };
    assert!(luma(&after, 0, w / 2 - 4) > luma(&before, 0, w / 2 - 4) + 20.0, "brighter on the left");
    let right = |img| luma(img, w / 2 + 4, w);
    assert_eq!(right(&after), right(&before), "the right is untouched");
    // Inverted, the other way round.
    p.modules[i].mask.as_mut().unwrap().invert = true;
    let inverted = dev.render(&p, SIZE, Quality::Final);
    assert_eq!(luma(&inverted, 0, w / 2 - 4), luma(&before, 0, w / 2 - 4));
    assert!(right(&inverted) > right(&before) + 20.0);
}

#[test]
fn a_switched_off_mask_applies_everywhere() {
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    p.shapes.insert("s".into(), Shape::Ellipse { center: [0.5, 0.5], radii: [0.1, 0.1], rotation: 0.0, feather: 0.0, opacity: 1.0 });
    let i = p.add(Exposure { ev: 1.0, black: 0.0 });
    let plain = dev.render(&p, SIZE, Quality::Final);
    p.modules[i].mask = Some(Mask { drawn: vec![DrawnShape { shape: "s".into(), ..Default::default() }], luminance: Some([-1.0, 0.0, 1.0, 2.0]), feather: 10.0, ..Mask::default() });
    assert_ne!(dev.render(&p, SIZE, Quality::Final).data, plain.data);
    p.modules[i].mask.as_mut().unwrap().enabled = false;
    assert_eq!(dev.render(&p, SIZE, Quality::Final).data, plain.data);
}

/// Fitting a tone curve measures its input: an exposure before it moves the fit by as much.
#[test]
fn tone_curve_fit_follows_the_modules_before_it() {
    use rawtisserie_pipeline::params::ToneCurve;
    let mut dev = developer();
    let mut p = EditParams::default();
    p.add(ToneCurve::default());
    let id = p.modules.iter().find(|m| matches!(m.module, rawtisserie_pipeline::params::Module::ToneCurve(_))).unwrap().id.clone();
    let a = dev.tone_curve_input(&p, &id, SIZE).unwrap();
    assert!(a.fit[0] < a.fit[1] - 1.0, "{:?}", a.fit);
    p.get_mut::<Exposure>().ev += 1.0;
    let b = dev.tone_curve_input(&p, &id, SIZE).unwrap();
    for k in 0..2 {
        assert!((b.fit[k] - a.fit[k] - 1.0).abs() <= 0.15, "{:?} → {:?}", a.fit, b.fit);
    }
    assert!(dev.tone_curve_input(&p, "exposure", SIZE).is_none());
}
