//! Raw denoise in the developer (roadmap 3.5): tiles computed beside renders, the
//! denoised photo taking the original's place, kept as a file and reopened.
//!
//! Uses a golden RAW (`./scripts/fetch-golden-raws.sh`) and the smallest model
//! (`./scripts/fetch-nn-fixtures.sh`); skipped without the model.

use std::path::{Path, PathBuf};

use rawtisserie_pipeline::denoise;
use rawtisserie_pipeline::nn::Model;
use rawtisserie_pipeline::params::{DenoiseModel, DenoiseSize, DenoiseVariant, RawDenoise};
use rawtisserie_pipeline::pipeline::DenoiseStatus;
use rawtisserie_pipeline::{Developer, EditParams, Quality, Region, RenderSize, Rgba8};

const MODEL: &str = "denoise-quarter-single-v1";

fn model_path() -> Option<PathBuf> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/nn/{MODEL}.anselnn"));
    path.exists().then_some(path)
}

fn raw() -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws/sony-ilce-7m3.arw");
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()))
}

fn recipe(dev: &Developer, strength: f32) -> EditParams {
    let mut p = EditParams::default_for(dev.metadata());
    p.add(RawDenoise { strength, model: DenoiseModel { version: 1, size: DenoiseSize::Quarter, variant: DenoiseVariant::Single }, ..RawDenoise::default() });
    p
}

/// Every pending tile, run on all cores (as the browser's pool would), handed back.
fn denoise_all(dev: &mut Developer, params: &EditParams, model: &Model) {
    let mut jobs = Vec::new();
    while let Some(job) = dev.next_denoise_tile(params, Some((0.5, 0.5))) {
        jobs.push(job);
    }
    let results = std::sync::Mutex::new(Vec::new());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let jobs: Vec<_> = jobs.into_iter().map(|j| (j.key, j.input)).collect();
    std::thread::scope(|s| {
        for _ in 0..std::thread::available_parallelism().map_or(4, |n| n.get()) {
            s.spawn(|| {
                while let Some((key, input)) = jobs.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) {
                    let out = denoise::run_tile(model, input.clone());
                    results.lock().unwrap().push((*key, input.core, out));
                }
            });
        }
    });
    for (key, core, out) in results.into_inner().unwrap() {
        dev.provide_denoise_tile(key, core, out);
    }
}

/// Mean absolute difference per channel value.
fn diff(a: &Rgba8, b: &Rgba8) -> f64 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    a.data.iter().zip(&b.data).map(|(x, y)| (*x as f64 - *y as f64).abs()).sum::<f64>() / a.data.len() as f64
}

#[test]
fn denoised_photo_replaces_the_original_once_every_tile_is_in() {
    let Some(path) = model_path() else { return eprintln!("no model (scripts/fetch-nn-fixtures.sh): skipped") };
    let bytes = std::fs::read(path).unwrap();
    let model = Model::from_bytes(&bytes).unwrap();
    let mut dev = Developer::from_bytes(&raw()).unwrap();
    let params = recipe(&dev, 1.0);
    let (w, h) = (dev.photo().width as u32, dev.photo().height as u32);
    // 100 %, a region in the middle (the photo isn't rotated).
    let size = RenderSize::fit(w, h).with_region(Region { x: w as usize / 2, y: h as usize / 2, width: 400, height: 300 });

    assert_eq!(dev.denoise_status(&params), DenoiseStatus::NeedsModel(MODEL.into()));
    let plain = dev.render(&EditParams::default_for(dev.metadata()), size, Quality::Final);
    dev.load_denoise_model(MODEL, &bytes).unwrap();
    let total = denoise::tiles(w as usize, h as usize).len();
    assert_eq!(dev.denoise_status(&params), DenoiseStatus::Pending { done: 0, total });
    // Pending: renders read the original.
    assert_eq!(diff(&dev.render(&params, size, Quality::Final), &plain), 0.0);

    denoise_all(&mut dev, &params, &model);
    assert_eq!(dev.denoise_status(&params), DenoiseStatus::Ready);
    let denoised = dev.render(&params, size, Quality::Final);
    let moved = diff(&denoised, &plain);
    assert!(moved > 0.05, "denoising changed the render by {moved}");

    // Strength blends again, without recomputing tiles.
    let half = recipe(&dev, 0.5);
    assert_eq!(dev.denoise_status(&half), DenoiseStatus::Ready);
    let between = diff(&dev.render(&half, size, Quality::Final), &plain);
    assert!(between > 0.0 && between < moved, "{between} vs {moved}");
    // Turned off: the original again.
    assert_eq!(diff(&dev.render(&EditParams::default_for(dev.metadata()), size, Quality::Final), &plain), 0.0);

    // Kept as a file and reopened without the RAW file: the same render (16-bit floats).
    dev.render(&params, size, Quality::Final);
    let file = dev.denoised_file(&params).unwrap();
    let (key, mut reopened) = Developer::from_denoised_file(&file).unwrap();
    assert!(key.starts_with(MODEL), "{key}");
    assert!(!reopened.has_original());
    assert_eq!(reopened.denoise_status(&params), DenoiseStatus::Ready);
    let again = reopened.render(&params, size, Quality::Final);
    let d = diff(&again, &denoised);
    assert!(d < 0.05, "reopened render differs by {d}");
    assert_eq!(reopened.metadata(), dev.metadata());

    // Other settings need the original; with it, the tiles are computed again.
    assert_eq!(reopened.denoise_status(&half), DenoiseStatus::NeedsOriginal);
    reopened.set_original(&raw()).unwrap();
    reopened.load_denoise_model(MODEL, &bytes).unwrap();
    assert_eq!(reopened.denoise_status(&half), DenoiseStatus::Pending { done: 0, total });
}
