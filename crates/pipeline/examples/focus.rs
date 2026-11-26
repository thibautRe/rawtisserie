//! Measure where photos are in focus (roadmap 8.9) and draw it over them, in the sensor
//! frame, as the app does: each edge in one colour, more opaque the sharper it is.
//!
//! ```sh
//! FOCUS_CROPS="0.7,0.4;0.2,0.8" cargo run --release --example focus -- out-dir photo.ARW…
//! ```
//!
//! Each photo gets `out-dir/<name>.jpg` (the whole photo, dimmed and grey, under its
//! edges) and for each point of `FOCUS_CROPS` (normalised) a 100 % crop with and without
//! them, `<name>-crop<i>.jpg` and `<name>-crop<i>-focus.jpg`.

use std::path::Path;
use std::time::Instant;

use rawtisserie_pipeline::focus::{self, FocusMap};
use rawtisserie_pipeline::{Rgba8, decode, demosaic, encode};

/// The app's tint and opacity curve (`apps/web/src/lib/focusOverlay.ts`).
const TINT: [f32; 3] = [90.0, 255.0, 120.0];
const OPAQUE: f32 = 0.5;

fn alpha(sigma: f32) -> f32 {
    (1.0 - (sigma - OPAQUE) / (focus::MAX_BLUR - OPAQUE)).clamp(0.0, 1.0).powi(3)
}

/// `grey` under the sharpest edge of the map's cell at `(u, v)` (normalised).
fn over(map: &FocusMap, grey: f32, u: f32, v: f32) -> [f32; 3] {
    let col = ((u * map.cols as f32) as usize).min(map.cols - 1);
    let row = ((v * map.rows as f32) as usize).min(map.rows - 1);
    let a = map.blur(col, row).map_or(0.0, alpha);
    std::array::from_fn(|k| grey * (1.0 - a) + TINT[k] * a)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: focus <out-dir> <photo>…");
        std::process::exit(2);
    }
    let out = Path::new(&args[1]);
    std::fs::create_dir_all(out)?;
    for path in &args[2..] {
        let photo = decode::decode(&std::fs::read(path)?)?;
        let t = Instant::now();
        let map = focus::measure(&photo);
        let ms = t.elapsed().as_millis();
        let json = serde_json::to_string(&map)?;
        let edges = map.cells.iter().filter(|&&c| c != focus::NO_EDGE).count();
        eprintln!(
            "{path}: {ms} ms, {}×{} cells, {:.1} % with an edge, {} kB as JSON",
            map.cols,
            map.rows,
            edges as f32 * 100.0 / map.cells.len() as f32,
            json.len() / 1000
        );

        let factor = (photo.width.max(photo.height) / 2000).max(2);
        let base = demosaic::develop_base(&photo, factor);
        let (w, h) = (base.width, base.height);
        let peak = {
            let mut l: Vec<f32> = base.pixels.iter().map(|p| p[1]).collect();
            let i = l.len() * 99 / 100;
            *l.select_nth_unstable_by(i, |a, b| a.total_cmp(b)).1
        };
        let grey = |p: [f32; 3]| ((0.25 * p[0] + 0.5 * p[1] + 0.25 * p[2]) / peak).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0;
        let mut img = Rgba8 { width: w, height: h, data: vec![255; w * h * 4] };
        for (i, p) in base.pixels.iter().enumerate() {
            let c = over(&map, grey(*p) * 0.5, (i % w) as f32 / w as f32, (i / w) as f32 / h as f32);
            for k in 0..3 {
                img.data[i * 4 + k] = c[k] as u8;
            }
        }
        let name = Path::new(path).file_stem().unwrap().to_string_lossy().to_string();
        std::fs::write(out.join(format!("{name}.jpg")), encode::jpeg(&img, 88)?)?;

        for (i, point) in std::env::var("FOCUS_CROPS").unwrap_or_default().split(';').filter(|s| !s.is_empty()).enumerate() {
            let [x, y] = <[f32; 2]>::try_from(point.split(',').map(|v| v.parse().unwrap()).collect::<Vec<f32>>()).unwrap();
            let size = 500;
            let rx = ((x * photo.width as f32) as usize).saturating_sub(size / 2).min(photo.width - size);
            let ry = ((y * photo.height as f32) as usize).saturating_sub(size / 2).min(photo.height - size);
            let crop = demosaic::develop_base_region(&photo, 1, rawtisserie_pipeline::Region { x: rx, y: ry, width: size, height: size });
            let mut plain = Rgba8 { width: size, height: size, data: vec![255; size * size * 4] };
            let mut marked = plain.clone();
            for (j, p) in crop.pixels.iter().enumerate() {
                let (u, v) = ((rx + j % size) as f32 / photo.width as f32, (ry + j / size) as f32 / photo.height as f32);
                let c = over(&map, grey(*p) * 0.5, u, v);
                for k in 0..3 {
                    plain.data[j * 4 + k] = ((p[k] / peak).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0) as u8;
                    marked.data[j * 4 + k] = c[k] as u8;
                }
            }
            std::fs::write(out.join(format!("{name}-crop{i}.jpg")), encode::jpeg(&plain, 90)?)?;
            std::fs::write(out.join(format!("{name}-crop{i}-focus.jpg")), encode::jpeg(&marked, 90)?)?;
        }
    }
    Ok(())
}
