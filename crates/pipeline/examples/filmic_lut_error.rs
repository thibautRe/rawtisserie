//! How far is filmic's 3D LUT from the exact computation, in 8-bit sRGB levels?
//! `cargo run --release --example filmic_lut_error -- photo.ARW...`

use std::time::Instant;

use rawtisserie_pipeline::ops::point::PointOps;
use rawtisserie_pipeline::params::EditParams;
use rawtisserie_pipeline::{Developer, RenderSize};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for path in std::env::args().skip(1) {
        let mut dev = Developer::from_bytes(&std::fs::read(&path)?)?;
        let params = EditParams::default();
        // Bypass point ops: render once to get the cached spatial stages, then compare.
        let img = dev.spatial_image(&params, RenderSize::fit(1600, 1600)).clone();
        let t = Instant::now();
        let exact = PointOps::with_filmic_lut(&params, None).render(&img);
        println!("{path}\n  exact     {:>6.1} ms", t.elapsed().as_secs_f64() * 1e3);
        for size in [17, 33, 49, 65] {
            let t = Instant::now();
            let ops = PointOps::with_filmic_lut(&params, Some(size));
            let built = t.elapsed();
            let t = Instant::now();
            let out = ops.render(&img);
            let ms = t.elapsed();
            let mut diffs: Vec<u8> = exact.data.iter().zip(&out.data).map(|(a, b)| a.abs_diff(*b)).collect();
            diffs.sort_unstable();
            let mean = diffs.iter().map(|&d| d as f64).sum::<f64>() / diffs.len() as f64;
            let p999 = diffs[diffs.len() * 999 / 1000];
            println!(
                "  LUT {size:>2}³  build {:>5.1} ms, render {:>6.1} ms | Δ mean {mean:.3}, 99.9% ≤ {p999}, max {}",
                built.as_secs_f64() * 1e3,
                ms.as_secs_f64() * 1e3,
                diffs.last().unwrap()
            );
        }
    }
    Ok(())
}
