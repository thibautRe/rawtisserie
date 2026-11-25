//! Measure where photos are in focus (roadmap 8.9) and draw it over them, in the sensor
//! frame, to check the measure:
//!
//! ```sh
//! cargo run --release --example focus -- out-dir photo.ARW…
//! ```
//!
//! Each photo gets `out-dir/<name>.jpg`: sharp cells tinted green (stronger when
//! sharper), cells without detail hatched grey, the focus area outlined in red with a
//! cross at its centre.

use std::path::Path;
use std::time::Instant;

use rawtisserie_pipeline::focus::{self, NO_DETAIL};
use rawtisserie_pipeline::{Rgba8, decode, demosaic, encode};

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
        let known = map.cells.iter().filter(|&&c| c != NO_DETAIL).count();
        let mut hist = [0usize; 5];
        for &c in map.cells.iter().filter(|&&c| c != NO_DETAIL) {
            hist[(c as usize * 5 / 255).min(4)] += 1;
        }
        eprintln!(
            "{path}: {ms} ms, {}×{} cells, {known} with detail, by fifth {hist:?}, sharpness {:.2}, area {:?}",
            map.cols, map.rows, map.sharpness, map.area
        );

        let factor = (photo.width.max(photo.height) / 1600).max(2);
        let base = demosaic::develop_base(&photo, factor);
        let (w, h) = (base.width, base.height);
        let mut img = Rgba8 { width: w, height: h, data: vec![255; w * h * 4] };
        let peak = {
            let mut l: Vec<f32> = base.pixels.iter().map(|p| p[1]).collect();
            let i = l.len() * 99 / 100;
            *l.select_nth_unstable_by(i, |a, b| a.total_cmp(b)).1
        };
        for y in 0..h {
            for x in 0..w {
                let p = base.get(x, y);
                let c = map.cells[(y * map.rows / h) * map.cols + x * map.cols / w];
                let rgb: [f32; 3] = std::array::from_fn(|i| (p[i] / peak).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0);
                let rgb = if c == NO_DETAIL {
                    let hatch = (x + y) % 12 < 2;
                    if hatch { [128.0; 3] } else { rgb }
                } else {
                    let a = c as f32 / 254.0 * 0.6;
                    [rgb[0] * (1.0 - a), rgb[1] * (1.0 - a) + 255.0 * a, rgb[2] * (1.0 - a)]
                };
                let o = (y * w + x) * 4;
                for i in 0..3 {
                    img.data[o + i] = rgb[i] as u8;
                }
            }
        }
        if let Some(a) = &map.area {
            let (x0, y0) = ((a.x * w as f32) as usize, (a.y * h as f32) as usize);
            let (x1, y1) = (
                (((a.x + a.width) * w as f32) as usize).min(w - 1),
                (((a.y + a.height) * h as f32) as usize).min(h - 1),
            );
            let mut put = |x: usize, y: usize| {
                let o = (y * w + x) * 4;
                img.data[o..o + 3].copy_from_slice(&[255, 0, 0]);
            };
            for t in 0..3 {
                for x in x0..=x1 {
                    put(x, (y0 + t).min(h - 1));
                    put(x, y1.saturating_sub(t));
                }
                for y in y0..=y1 {
                    put((x0 + t).min(w - 1), y);
                    put(x1.saturating_sub(t), y);
                }
            }
            let (cx, cy) = ((a.cx * w as f32) as usize, (a.cy * h as f32) as usize);
            for d in 0..20 {
                for t in 0..3 {
                    put((cx + d).saturating_sub(10).min(w - 1), (cy + t).saturating_sub(1).min(h - 1));
                    put((cx + t).saturating_sub(1).min(w - 1), (cy + d).saturating_sub(10).min(h - 1));
                }
            }
        }
        let name = Path::new(path).file_stem().unwrap().to_string_lossy().to_string();
        // FOCUS_CROPS="x,y;x,y": 100 % crops around those points (normalised), to compare.
        for (i, point) in std::env::var("FOCUS_CROPS").unwrap_or_default().split(';').filter(|s| !s.is_empty()).enumerate() {
            let [x, y] = <[f32; 2]>::try_from(point.split(',').map(|v| v.parse().unwrap()).collect::<Vec<f32>>()).unwrap();
            let size = 400;
            let rx = ((x * photo.width as f32) as usize).saturating_sub(size / 2).min(photo.width - size);
            let ry = ((y * photo.height as f32) as usize).saturating_sub(size / 2).min(photo.height - size);
            let crop = demosaic::develop_base_region(&photo, 1, rawtisserie_pipeline::Region { x: rx, y: ry, width: size, height: size });
            let mut c = Rgba8 { width: size, height: size, data: vec![255; size * size * 4] };
            for (j, p) in crop.pixels.iter().enumerate() {
                for k in 0..3 {
                    c.data[j * 4 + k] = ((p[k] / peak).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0) as u8;
                }
            }
            std::fs::write(out.join(format!("{name}-crop{i}.jpg")), encode::jpeg(&c, 90)?)?;
        }
        std::fs::write(out.join(format!("{name}.jpg")), encode::jpeg(&img, 85)?)?;
    }
    Ok(())
}
