//! The denoising executor (`nn.rs`) against upstream's parity fixtures, made by
//! ansel-denoise's `scripts/make_fixture.py` from PyTorch (tolerance 2·10⁻⁴).
//!
//! Needs `./scripts/fetch-nn-fixtures.sh` once (into `tests/nn`: the fixtures and the
//! model the single-scale one was made with). Skipped without them.

use std::path::PathBuf;

use rawtisserie_pipeline::nn::{bin_planes, Model};

fn dir() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/nn");
    dir.join("rawdenoiseai-v1-full.anselnn").exists().then_some(dir)
}

fn floats(path: PathBuf) -> Vec<f32> {
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())).chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
}

#[test]
fn single_scale_matches_pytorch() {
    let Some(dir) = dir() else { return eprintln!("no fixtures (scripts/fetch-nn-fixtures.sh): skipped") };
    let model = Model::from_bytes(&std::fs::read(dir.join("rawdenoiseai-v1-full.anselnn")).unwrap()).unwrap();
    let n = 96;
    let input = floats(dir.join("fixtures/fixture-input.f32"));
    let expected = floats(dir.join("fixtures/fixture-expected.f32"));
    let out = model.forward(false, &input, n, n, true).unwrap();
    let max = out.iter().zip(&expected).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    eprintln!("max abs error {max:e}");
    assert!(max <= 2e-4, "max abs error {max}");
}

#[test]
fn binning_matches_pytorch() {
    let Some(dir) = dir() else { return eprintln!("no fixtures (scripts/fetch-nn-fixtures.sh): skipped") };
    let (n, bin) = (192, 4);
    let base = floats(dir.join("fixtures/ms/fixture-base-planes.f32"));
    let coarse = floats(dir.join("fixtures/ms/fixture-coarse-input.f32"));
    let cplane = (n / bin) * (n / bin);
    let (mut rgb, mut count) = (vec![0.0; 3 * cplane], vec![0.0; 3 * cplane]);
    bin_planes(&base, n, n, bin, &mut rgb, &mut count);
    let max = rgb.iter().zip(&coarse[..3 * cplane]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(max <= 1e-6, "max abs error {max}");
}
