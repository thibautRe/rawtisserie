//! Raw denoise spike (roadmap 3.5): time the `.anselnn` executor on a synthetic tile.
//! `cargo run --release --example denoise_bench -- [tile] model.anselnn…`

use std::time::Instant;

use rawtisserie_pipeline::nn::Model;

/// Synthetic fine-net input: a noisy Bayer mosaic, its one-hot planes, σ, and (for a
/// multiscale model) flat guide planes. The timing doesn't depend on the values.
fn planes(n: usize, channels: usize) -> Vec<f32> {
    let plane = n * n;
    let mut v = vec![0.0f32; channels * plane];
    let mut seed = 1u32;
    for y in 0..n {
        for x in 0..n {
            let i = y * n + x;
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let c = match (y % 2, x % 2) { (0, 0) => 0, (1, 1) => 2, _ => 1 };
            v[i] = 0.2 + 0.05 * (seed >> 8) as f32 / (1 << 24) as f32;
            v[(1 + c) * plane + i] = 1.0;
            v[4 * plane + i] = 0.02;
            for g in 5..channels {
                v[g * plane + i] = 0.2;
            }
        }
    }
    v
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let tile: usize = if args.first().is_some_and(|a| a.parse::<usize>().is_ok()) { args.remove(0).parse()? } else { 512 };
    for path in &args {
        let model = Model::from_bytes(&std::fs::read(path)?)?;
        let n = tile.div_ceil(model.alignment()) * model.alignment();
        let name = std::path::Path::new(path).file_name().unwrap().to_string_lossy().into_owned();
        let input = planes(n, model.in_channels());
        let t = Instant::now();
        model.forward(false, &input, n, n, false).ok_or("bad size")?;
        let fine = t.elapsed().as_secs_f64();
        let mut coarse = 0.0;
        if let Some(c) = model.coarse_config() {
            let cn = n / model.bin(false);
            let input = vec![0.1f32; c.in_channels * cn * cn];
            let t = Instant::now();
            model.forward(true, &input, cn, cn, false).ok_or("bad coarse size")?;
            coarse = t.elapsed().as_secs_f64();
        }
        let mp = (n * n) as f64 / 1e6;
        println!("{name:<36} {n}²: fine {:>7.0} ms, coarse {:>5.0} ms → {:>6.2} s/MP", fine * 1e3, coarse * 1e3, (fine + coarse) / mp);
    }
    Ok(())
}
