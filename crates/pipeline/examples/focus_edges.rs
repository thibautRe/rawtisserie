//! Prototype of focus areas by edge width (roadmap 8.9): measure how blurred each edge
//! of a photo is and draw it over the photo, coloured by the blur, in the sensor frame:
//!
//! ```sh
//! FOCUS_CROPS="0.7,0.4;0.2,0.8" cargo run --release --example focus_edges -- out-dir photo.ARW…
//! ```
//!
//! Each photo gets three styles over the whole photo, dimmed and grey: `<name>-peaking.jpg`
//! (only the sharp edges), `<name>-scale.jpg` (edges coloured by their blur, the widest
//! faded out) and `<name>-zones.jpg` (cells coloured by their sharper edges), and for each
//! point of `FOCUS_CROPS` a 100 % crop with and without the scale. `legend.jpg` is the
//! colour scale, 0 to 10 sensor pixels of σ.

use std::path::Path;
use std::time::Instant;

use rawtisserie_pipeline::focus::edges;
use rawtisserie_pipeline::{Rgba8, decode, demosaic, encode};

/// Sharpest edges for the peaking style, σ in sensor pixels.
const PEAKING: f32 = 1.0;
/// Zone size, in measure pixels.
const ZONE: usize = 24;
/// Edges this blurred (σ, sensor pixels) are fully shown in the scale style, none from `HIDE`.
const SHOW: f32 = 2.5;
const HIDE: f32 = 6.0;

/// `grey` with an edge of blur `sigma` (NaN: none) over it.
fn over(grey: f32, sigma: f32) -> [f32; 3] {
    if sigma.is_nan() {
        return [grey; 3];
    }
    let a = (1.0 - (sigma - SHOW) / (HIDE - SHOW)).clamp(0.0, 1.0);
    let c = colour(sigma);
    std::array::from_fn(|k| grey * (1.0 - a) + c[k] * a)
}

/// Colour stops by blur σ in sensor pixels.
const RAMP: [(f32, [f32; 3]); 5] = [
    (0.5, [90.0, 255.0, 120.0]),
    (1.25, [240.0, 250.0, 60.0]),
    (2.0, [255.0, 150.0, 0.0]),
    (3.5, [240.0, 40.0, 60.0]),
    (6.0, [150.0, 40.0, 220.0]),
];

fn colour(sigma: f32) -> [f32; 3] {
    if sigma <= RAMP[0].0 {
        return RAMP[0].1;
    }
    for p in RAMP.windows(2) {
        let ((a, ca), (b, cb)) = (p[0], p[1]);
        if sigma <= b {
            let t = (sigma - a) / (b - a);
            return std::array::from_fn(|i| ca[i] + (cb[i] - ca[i]) * t);
        }
    }
    RAMP[RAMP.len() - 1].1
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: focus_edges <out-dir> <photo>…");
        std::process::exit(2);
    }
    let out = Path::new(&args[1]);
    std::fs::create_dir_all(out)?;
    legend(out)?;
    for path in &args[2..] {
        let photo = decode::decode(&std::fs::read(path)?)?;
        let t = Instant::now();
        let m = edges::measure(&photo);
        let ms = t.elapsed().as_millis();
        let mut known: Vec<f32> = m.blur.iter().copied().filter(|b| !b.is_nan()).collect();
        known.sort_by(|a, b| a.total_cmp(b));
        let p = |q: f32| known.get(((known.len().max(1) - 1) as f32 * q) as usize).copied().unwrap_or(f32::NAN);
        eprintln!(
            "{path}: {ms} ms, {}×{}, {} edge pixels ({:.1} %), σ p5 {:.2} p25 {:.2} p50 {:.2} p75 {:.2} p95 {:.2}",
            m.width,
            m.height,
            known.len(),
            known.len() as f32 * 100.0 / (m.width * m.height) as f32,
            p(0.05),
            p(0.25),
            p(0.5),
            p(0.75),
            p(0.95)
        );

        let factor = (photo.width.max(photo.height) / 2000).max(2);
        let base = demosaic::develop_base(&photo, factor);
        let (w, h) = (base.width, base.height);
        let peak = {
            let mut l: Vec<f32> = base.pixels.iter().map(|p| p[1]).collect();
            let i = l.len() * 99 / 100;
            *l.select_nth_unstable_by(i, |a, b| a.total_cmp(b)).1
        };
        let grey = |p: [f32; 3]| (0.25 * p[0] + 0.5 * p[1] + 0.25 * p[2]) / peak;
        let dim: Vec<f32> = (0..w * h)
            .map(|i| grey(base.pixels[i]).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0 * 0.5)
            .collect();
        // Per display pixel: the sharpest edge among the measure's pixels it covers.
        let sharpest: Vec<f32> = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                let (x0, x1) = (x * m.width / w, ((x + 1) * m.width / w).max(x * m.width / w + 1));
                let (y0, y1) = (y * m.height / h, ((y + 1) * m.height / h).max(y * m.height / h + 1));
                let mut best = f32::NAN;
                for yy in y0..y1.min(m.height) {
                    for xx in x0..x1.min(m.width) {
                        let b = m.blur[yy * m.width + xx];
                        if !(b >= best) && !b.is_nan() {
                            best = b;
                        }
                    }
                }
                best
            })
            .collect();
        let name = Path::new(path).file_stem().unwrap().to_string_lossy().to_string();
        let save = |suffix: &str, px: &dyn Fn(usize) -> [f32; 3]| -> Result<(), Box<dyn std::error::Error>> {
            let mut img = Rgba8 { width: w, height: h, data: vec![255; w * h * 4] };
            for i in 0..w * h {
                let c = px(i);
                for k in 0..3 {
                    img.data[i * 4 + k] = c[k].clamp(0.0, 255.0) as u8;
                }
            }
            std::fs::write(out.join(format!("{name}-{suffix}.jpg")), encode::jpeg(&img, 88)?)?;
            Ok(())
        };
        // Peaking: only the sharp edges, one colour.
        save("peaking", &|i| if sharpest[i] <= PEAKING { [90.0, 255.0, 120.0] } else { [dim[i]; 3] })?;
        // Scale: every edge coloured by its blur, fading out as it gets wide.
        save("scale", &|i| over(dim[i], sharpest[i]))?;
        // Zones: cells of `ZONE` measure pixels, the first quartile of their edges' blur.
        let (cols, rows) = (m.width.div_ceil(ZONE), m.height.div_ceil(ZONE));
        let mut zones = vec![f32::NAN; cols * rows];
        let mut buf = Vec::new();
        for cy in 0..rows {
            for cx in 0..cols {
                buf.clear();
                for y in cy * ZONE..((cy + 1) * ZONE).min(m.height) {
                    for x in cx * ZONE..((cx + 1) * ZONE).min(m.width) {
                        let b = m.blur[y * m.width + x];
                        if !b.is_nan() {
                            buf.push(b);
                        }
                    }
                }
                if buf.len() >= ZONE / 2 {
                    buf.sort_by(|a, b| a.total_cmp(b));
                    zones[cy * cols + cx] = buf[(buf.len() - 1) / 4];
                }
            }
        }
        save("zones", &|i| {
            let (x, y) = (i % w, i / w);
            let z = zones[(y * rows / h) * cols + x * cols / w];
            if z.is_nan() {
                return [dim[i]; 3];
            }
            let c = colour(z);
            let a = 0.55;
            std::array::from_fn(|k| dim[i] * 2.0 * (1.0 - a) + c[k] * a)
        })?;

        let name = Path::new(path).file_stem().unwrap().to_string_lossy().to_string();
        for (i, point) in std::env::var("FOCUS_CROPS").unwrap_or_default().split(';').filter(|s| !s.is_empty()).enumerate() {
            let [x, y] = <[f32; 2]>::try_from(point.split(',').map(|v| v.parse().unwrap()).collect::<Vec<f32>>()).unwrap();
            let size = 500;
            let rx = ((x * photo.width as f32) as usize).saturating_sub(size / 2).min(photo.width - size);
            let ry = ((y * photo.height as f32) as usize).saturating_sub(size / 2).min(photo.height - size);
            let crop = demosaic::develop_base_region(&photo, 1, rawtisserie_pipeline::Region { x: rx, y: ry, width: size, height: size });
            let mut plain = Rgba8 { width: size, height: size, data: vec![255; size * size * 4] };
            let mut scaled = plain.clone();
            for (j, p) in crop.pixels.iter().enumerate() {
                let (px, py) = (rx + j % size, ry + j / size);
                let b = m.blur[((py / m.factor).min(m.height - 1)) * m.width + (px / m.factor).min(m.width - 1)];
                let c = over(grey(*p).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0 * 0.5, b);
                for k in 0..3 {
                    plain.data[j * 4 + k] = ((p[k] / peak).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0) as u8;
                    scaled.data[j * 4 + k] = c[k] as u8;
                }
            }
            std::fs::write(out.join(format!("{name}-crop{i}.jpg")), encode::jpeg(&plain, 90)?)?;
            std::fs::write(out.join(format!("{name}-crop{i}-edges.jpg")), encode::jpeg(&scaled, 90)?)?;
        }
    }
    Ok(())
}

/// The ramp, 0 to 10 sensor pixels of σ, with a tick every pixel.
fn legend(out: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let (w, h) = (600, 40);
    let mut img = Rgba8 { width: w, height: h, data: vec![255; w * h * 4] };
    for x in 0..w {
        let sigma = x as f32 / w as f32 * 10.0;
        let tick = (x * 10) % w < 10 * 2;
        for y in 0..h {
            let c = if tick && y > h - 10 { [255.0; 3] } else { colour(sigma) };
            let o = (y * w + x) * 4;
            for i in 0..3 {
                img.data[o + i] = c[i] as u8;
            }
        }
    }
    std::fs::write(out.join("legend.jpg"), encode::jpeg(&img, 90)?)?;
    Ok(())
}
