//! The web developer splits the point operations of a render across workers, each
//! holding a strip of the spatial image (`apps/web/src/develop/pointPool.ts`). The
//! strips must put together exactly what `Developer::render` gives.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`) and recipes.

use std::path::Path;

use rawtisserie_pipeline::params::{Blur, Exposure};
use rawtisserie_pipeline::pipeline::PointRenderer;
use rawtisserie_pipeline::{Developer, EditParams, Image, Quality, RenderSize};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    recipe: EditParams,
}

const SIZE: RenderSize = RenderSize { max_width: 900, max_height: 900 };

fn developer() -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws/sony-ilce-7m3.arw");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    Developer::from_bytes(&bytes).unwrap()
}

fn strips(dev: &mut Developer, params: &EditParams, n: usize) -> Vec<PointRenderer> {
    let as_shot = dev.photo().as_shot_illuminant;
    let img = dev.spatial_image(params, SIZE);
    let rows = img.height.div_ceil(n);
    (0..img.height)
        .step_by(rows)
        .map(|y0| {
            let y1 = (y0 + rows).min(img.height);
            let pixels = img.pixels[y0 * img.width..y1 * img.width].to_vec();
            PointRenderer::new(Image { width: img.width, height: y1 - y0, pixels }, as_shot)
        })
        .collect()
}

#[test]
fn strips_match_the_full_render() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/recipes");
    let mut dev = developer();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let case: Case = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
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
