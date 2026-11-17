//! Raw denoise (roadmap 3.5) on a RAW file, natively and on every core:
//! `cargo run --release --example denoise -- photo.ARW model.anselnn out-prefix [strength] [full]`
//!
//! Denoises the grid tiles under a 1200×800 crop at the centre (or every tile with
//! `full`) and writes `out-prefix-before.jpg` and `out-prefix-after.jpg`: that crop at
//! 100 %, with a new import's recipe.

use std::time::Instant;

use rawtisserie_pipeline::denoise::{self, Conditioning};
use rawtisserie_pipeline::nn::Model;
use rawtisserie_pipeline::{decode, encode, Developer, EditParams, Quality, Region, RenderSize};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: denoise <raw> <model.anselnn> <out-prefix> [strength] [full]");
        std::process::exit(2);
    }
    let photo = decode::decode(&std::fs::read(&args[1])?)?;
    let model = Model::from_bytes(&std::fs::read(&args[2])?)?;
    let strength: f32 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(denoise::DEFAULT_STRENGTH);
    let full = args.get(5).is_some_and(|a| a == "full");
    let meta = &photo.metadata;
    let profile = denoise::noise_profile(meta.make.as_deref(), meta.model.as_deref(), meta.iso);
    eprintln!("{:?} {:?} ISO {:?}: profile {}", meta.make, meta.model, meta.iso, if profile.matched { "matched" } else { "generic" });

    let (w, h) = (photo.width, photo.height);
    let crop = Region { x: w / 2 - 600, y: h / 2 - 400, width: 1200, height: 800 };
    let todo = if full { denoise::tiles(w, h) } else { denoise::tiles_in(w, h, Region { x: crop.x - 8, y: crop.y - 8, width: crop.width + 16, height: crop.height + 16 }) };
    let conditioning = Conditioning::default();
    let t = Instant::now();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let done = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..std::thread::available_parallelism().map_or(4, |n| n.get()) {
            s.spawn(|| {
                while let Some(&tile) = todo.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) {
                    let out = denoise::denoise_tile(&model, &photo, &profile, &conditioning, tile).expect("a mosaic");
                    done.lock().unwrap().push((tile, out));
                }
            });
        }
    });
    let secs = t.elapsed().as_secs_f64();
    let mp = todo.iter().map(|t| t.width * t.height).sum::<usize>() as f64 / 1e6;
    eprintln!("{} tiles ({mp:.1} MP) in {secs:.1} s", todo.len());

    let mut samples: Vec<f32> = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| photo.sample_unclamped(x, y, 0)).collect();
    for (tile, out) in done.into_inner()? {
        for y in 0..tile.height {
            for x in 0..tile.width {
                let i = (tile.y + y) * w + tile.x + x;
                samples[i] = denoise::blend(samples[i], out[y * tile.width + x], strength);
            }
        }
    }
    let denoised = photo.with_denoised(samples);

    // The crop is in sensor coordinates; renders are oriented. Only unrotated photos here.
    let params = EditParams::default_for(&photo.metadata);
    let size = RenderSize::fit(w as u32, h as u32).with_region(crop);
    for (name, p) in [("before", photo), ("after", denoised)] {
        let mut dev = Developer::new(p);
        let img = dev.render(&params, size, Quality::Final);
        std::fs::write(format!("{}-{name}.jpg", args[3]), encode::jpeg(&img, 92)?)?;
    }
    Ok(())
}
