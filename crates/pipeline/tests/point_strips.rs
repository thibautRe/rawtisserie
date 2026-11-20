//! The web developer splits the point operations of a render across workers, each
//! holding a strip of the spatial image (`apps/web/src/develop/pointPool.ts`). The
//! strips must put together exactly what `Developer::render` gives.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`) and recipes.

use std::path::Path;

use rawtisserie_pipeline::params::{BlendMode, Diffuse, DrawnShape, Exposure, Mask, Shape};
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

    p.get_mut::<Diffuse>().iterations = 2.0;
    assert!(!dev.is_spatial_cached(&p, SIZE), "diffuse is spatial");
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
    let mask = p.modules[masked].mask.as_mut().unwrap();
    (mask.blend, mask.blend_fulcrum) = (BlendMode::SoftLight, 1.0);
    assert!(dev.is_spatial_cached(&p, SIZE), "nor its blend");
    // A LUT's mask is measured on filmic's input: filmic and the LUTs before it aren't
    // what it's computed from.
    p.add(rawtisserie_pipeline::params::Lut::default());
    p.modules.last_mut().unwrap().mask = Some(Mask { luminance: Some([-2.0, -1.0, 3.0, 4.0]), feather: 10.0, ..Mask::default() });
    assert!(!dev.is_spatial_cached(&p, SIZE));
    dev.spatial_image_id(&p, SIZE);
    p.get_mut::<rawtisserie_pipeline::params::Filmic>().white_exposure += 1.0;
    p.modules.last_mut().unwrap().mask.as_mut().unwrap().blend = BlendMode::Multiply;
    assert!(dev.is_spatial_cached(&p, SIZE), "filmic and the LUT's blend are point operations");
    p.modules.pop();
    dev.spatial_image_id(&p, SIZE);

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

    // A spatial module blends with its stage.
    let diffuse = p.add(Diffuse::default());
    p.modules[diffuse].mask = Some(Mask { opacity: 0.5, ..Mask::default() });
    dev.spatial_image_id(&p, SIZE);
    p.modules[diffuse].mask.as_mut().unwrap().blend = BlendMode::Darken;
    assert!(!dev.is_spatial_cached(&p, SIZE), "a spatial module's blend is spatial");
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

/// A tone curve preserving detail reads a mask computed with the spatial stages: its
/// nodes stay point edits, what the mask is made from doesn't.
#[test]
fn preserving_detail_is_spatial_only_through_its_mask() {
    use rawtisserie_pipeline::params::{Module, ToneCurve};
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    p.add(ToneCurve { preserve_detail: true, ..Default::default() });
    let at = p.modules.iter().position(|m| matches!(m.module, Module::ToneCurve(_))).unwrap();
    let id = p.modules[at].id.clone();
    fn tones(p: &mut EditParams, at: usize) -> &mut ToneCurve {
        let Module::ToneCurve(t) = &mut p.modules[at].module else { unreachable!() };
        t
    }
    let (first, _, masks) = dev.spatial(&p, SIZE);
    assert!(masks.iter().any(|m| m.id == format!("{id}#tones-mean")), "the mask comes with the spatial image, even with flat curves");
    let plain = dev.render(&p, SIZE, Quality::Final);

    tones(&mut p, at).rgb[4] = 1.5;
    assert!(dev.is_spatial_cached(&p, SIZE), "moving a node is a point edit");
    let lifted = dev.render(&p, SIZE, Quality::Final);
    assert!(lifted.data != plain.data, "the node moves the image");
    tones(&mut p, at).range = [-6.0, 1.0];
    assert!(dev.is_spatial_cached(&p, SIZE), "so is the range");

    tones(&mut p, at).smoothing = 0.1;
    assert!(!dev.is_spatial_cached(&p, SIZE), "the smoothing changes the mask");
    let (smoother, ..) = dev.spatial(&p, SIZE);
    assert_ne!(smoother, first);
    p.get_mut::<Exposure>().ev += 0.5;
    assert!(!dev.is_spatial_cached(&p, SIZE), "the mask is measured on the module's input");

    // Its histogram is the mask's: smoother than the pixels', so narrower.
    tones(&mut p, at).preserve_detail = false;
    let pixels = dev.tone_curve_input(&p, &id, SIZE).unwrap();
    tones(&mut p, at).preserve_detail = true;
    let mask = dev.tone_curve_input(&p, &id, SIZE).unwrap();
    assert!(mask.fit[1] - mask.fit[0] < pixels.fit[1] - pixels.fit[0], "{:?} vs {:?}", mask.fit, pixels.fit);
}

/// A `.cube` file of `f` on a `size³` grid.
fn cube(size: usize, f: impl Fn([f32; 3]) -> [f32; 3]) -> String {
    let mut s = format!("LUT_3D_SIZE {size}\n");
    let node = |i: usize| i as f32 / (size - 1) as f32;
    for b in 0..size {
        for g in 0..size {
            for r in 0..size {
                let [x, y, z] = f([node(r), node(g), node(b)]);
                s += &format!("{x} {y} {z}\n");
            }
        }
    }
    s
}

#[test]
fn luts_render_the_same_in_strips_and_survive_releasing_the_cache() {
    use rawtisserie_pipeline::ops::clut::Interpolation;
    use rawtisserie_pipeline::params::{Lut, LutRef};
    let file = cube(17, |[r, g, b]| [r.powf(1.3), 0.1 + 0.8 * g, (b * 0.7 + r * 0.3).sqrt()]);
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    let plain = dev.render(&p, SIZE, Quality::Final);
    let id = dev.luts_mut().load(file.as_bytes()).unwrap();
    p.add(Lut { lut: Some(LutRef { id: id.clone(), name: "test".into(), path: None }), interpolation: Interpolation::Tetrahedral });
    let looked = dev.render(&p, SIZE, Quality::Final);
    assert_ne!(looked.data, plain.data);

    dev.release_cache();
    assert!(dev.luts().contains(&id));
    assert_eq!(dev.render(&p, SIZE, Quality::Final).data, looked.data);

    let mut parts = strips(&mut dev, &p, 3);
    for part in &mut parts {
        assert_eq!(part.luts_mut().load(file.as_bytes()).unwrap(), id);
    }
    for pass in 0..2 {
        let want = dev.render(&p, SIZE, Quality::Interactive);
        let got: Vec<u8> = parts.iter_mut().flat_map(|part| part.render(&p, Quality::Interactive).data).collect();
        assert!(got == want.data, "pass {pass}: strips differ from the full render");
    }

    // Masked: at half opacity in soft light (baked into filmic's table), then again
    // inside a shape (per pixel, and so is everything after it).
    let lut = p.modules.len() - 1;
    p.modules[lut].mask = Some(Mask { opacity: 0.5, blend: BlendMode::SoftLight, ..Mask::default() });
    let half = dev.render(&p, SIZE, Quality::Final);
    assert!(half.data != looked.data && half.data != plain.data);
    p.shapes.insert("s".into(), Shape::Ellipse { center: [0.4, 0.5], radii: [0.2, 0.3], rotation: 0.0, feather: 0.1, opacity: 1.0 });
    p.add(Lut { lut: Some(LutRef { id: id.clone(), name: "test".into(), path: None }), interpolation: Interpolation::Trilinear });
    p.modules.last_mut().unwrap().mask = Some(Mask { drawn: vec![DrawnShape { shape: "s".into(), ..Default::default() }], blend: BlendMode::Multiply, ..Mask::default() });
    p.add(Lut { lut: Some(LutRef { id: id.clone(), name: "test".into(), path: None }), interpolation: Interpolation::Tetrahedral });
    p.modules.last_mut().unwrap().mask = Some(Mask { opacity: 0.3, ..Mask::default() });
    // A fresh developer, like the strips (see `strips_match_the_full_render`).
    let mut dev = developer();
    dev.luts_mut().load(file.as_bytes()).unwrap();
    // The shape's plane comes with the spatial image.
    assert_eq!(dev.spatial(&p, SIZE).2.len(), 1);
    assert_ne!(dev.render(&p, SIZE, Quality::Final).data, half.data);
    let mut parts = strips(&mut dev, &p, 3);
    for part in &mut parts {
        part.luts_mut().load(file.as_bytes()).unwrap();
    }
    for pass in 0..2 {
        let want = dev.render(&p, SIZE, Quality::Interactive);
        let got: Vec<u8> = parts.iter_mut().flat_map(|part| part.render(&p, Quality::Interactive).data).collect();
        assert!(got == want.data, "masked, pass {pass}: strips differ from the full render");
    }
}


/// A raster shape is another instance's mask as it applies it (roadmap 4.15).
#[test]
fn raster_shapes_are_their_sources_masks() {
    use rawtisserie_pipeline::params::ShapeOp;
    let mut dev = developer();
    let mut p = EditParams::default_for(dev.metadata());
    let left = Shape::Gradient { anchor: [0.5, 0.5], angle: std::f32::consts::PI, feather: 0.2, opacity: 1.0 };
    p.shapes.insert("left".into(), left);
    let drawn = |shape: &str, op| DrawnShape { shape: shape.into(), op };
    let source = p.add(Exposure { ev: 1.0, black: 0.0 });
    p.modules[source].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union)], ..Mask::default() });
    let consumer = p.add(Exposure { ev: -0.5, black: 0.0 });
    let source_id = p.modules[source].id.clone();
    let raster = |invert| Shape::Raster { source: source_id.clone(), invert, opacity: 1.0 };

    // The same as the shapes it reads.
    p.modules[consumer].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union)], ..Mask::default() });
    let want = dev.render(&p, SIZE, Quality::Final);
    p.shapes.insert("r".into(), raster(false));
    p.modules[consumer].mask = Some(Mask { drawn: vec![drawn("r", ShapeOp::Union)], ..Mask::default() });
    assert!(dev.render(&p, SIZE, Quality::Final).data == want.data, "a raster shape is its source's mask");
    assert!(strips(&mut dev, &p, 3).iter_mut().flat_map(|s| s.render(&p, Quality::Final).data).eq(want.data.iter().copied()), "strips get its plane");
    // …as the source applies it: its invert too.
    p.modules[source].mask.as_mut().unwrap().invert = true;
    assert!(!dev.is_spatial_cached(&p, SIZE), "the source's mask is what the raster shape reads");
    dev.render(&p, SIZE, Quality::Final);
    p.modules[source].mask.as_mut().unwrap().invert = false;
    p.shapes.insert("r".into(), raster(true));
    let inverted_shape = dev.render(&p, SIZE, Quality::Final);
    p.shapes.insert("r".into(), raster(false));
    assert_ne!(inverted_shape.data, want.data);
    p.modules[source].enabled = false;
    let off = dev.render(&p, SIZE, Quality::Final);
    let plain = {
        let mut q = p.clone();
        q.modules[consumer].enabled = false;
        dev.render(&q, SIZE, Quality::Final)
    };
    assert!(off.data == plain.data, "a disabled source applies nowhere");
    p.modules[source].enabled = true;

    // A source without a mask applies everywhere.
    p.modules[source].mask = None;
    let everywhere = {
        let mut q = p.clone();
        q.modules[consumer].mask = None;
        dev.render(&q, SIZE, Quality::Final)
    };
    // (Blending in by 1 rounds a little differently from not blending.)
    let got = dev.render(&p, SIZE, Quality::Final);
    assert!(got.data.iter().zip(&everywhere.data).all(|(a, b)| a.abs_diff(*b) <= 1), "applies everywhere");
    p.modules[source].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union)], ..Mask::default() });

    // Combined with other shapes in their order, as drawn ones are.
    p.modules[consumer].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union), drawn("left", ShapeOp::Intersection)], ..Mask::default() });
    let squared = dev.render(&p, SIZE, Quality::Final);
    p.modules[consumer].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union), drawn("r", ShapeOp::Intersection)], ..Mask::default() });
    // (Drawn shapes combine on the sensor, before resampling: about the same.)
    let got = dev.render(&p, SIZE, Quality::Final);
    assert!(got.data.iter().zip(&squared.data).all(|(a, b)| a.abs_diff(*b) <= 1), "combined in order");

    // A spatial source, read by a point module.
    let diffuse = p.add(Diffuse::default());
    p.modules[diffuse].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union)], ..Mask::default() });
    let diffuse_id = p.modules[diffuse].id.clone();
    let consumer = p.modules.iter().position(|m| m.id == "exposure-3").unwrap();
    p.modules[consumer].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union)], ..Mask::default() });
    let want = dev.render(&p, SIZE, Quality::Final);
    p.shapes.insert("d".into(), Shape::Raster { source: diffuse_id.clone(), invert: false, opacity: 1.0 });
    p.modules[consumer].mask = Some(Mask { drawn: vec![drawn("d", ShapeOp::Union)], ..Mask::default() });
    assert!(dev.render(&p, SIZE, Quality::Final).data == want.data, "a spatial source's mask");
    // Even when the step does nothing.
    if let rawtisserie_pipeline::params::Module::Diffuse(d) = &mut p.modules[diffuse].module {
        *d = Diffuse { speed1: 0.0, speed2: 0.0, speed3: 0.0, speed4: 0.0, ..*d };
    }
    let idle = dev.render(&p, SIZE, Quality::Final);
    p.modules[consumer].mask = Some(Mask { drawn: vec![drawn("left", ShapeOp::Union)], ..Mask::default() });
    assert!(dev.render(&p, SIZE, Quality::Final).data == idle.data, "an idle step is still a source");

    // A source after the mask's instance isn't one: the mask applies nowhere.
    let first = p.modules.iter().position(|m| m.id == source_id).unwrap();
    p.shapes.insert("later".into(), Shape::Raster { source: "exposure-3".into(), invert: false, opacity: 1.0 });
    p.modules[first].mask = Some(Mask { drawn: vec![drawn("later", ShapeOp::Union)], ..Mask::default() });
    let without = {
        let mut q = p.clone();
        q.modules[first].enabled = false;
        dev.render(&q, SIZE, Quality::Final)
    };
    assert!(dev.render(&p, SIZE, Quality::Final).data == without.data);
}
