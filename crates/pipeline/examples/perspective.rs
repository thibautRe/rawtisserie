//! Perspective guides on a photo: detects the lines, fits the correction and writes
//! `<out>-lines.jpg` (the uncorrected image with the lines: selected ones in green for
//! verticals and blue for horizontals, the others in grey) and `<out>-fitted.jpg`.
//!
//! `cargo run --release --example perspective -- photo.ARW [vertical|horizontal|both] [out]`

use rawtisserie_pipeline::ops::lines::GuideLine;
use rawtisserie_pipeline::ops::perspective::FitMode;
use rawtisserie_pipeline::params::Geometry;
use rawtisserie_pipeline::{Developer, EditParams, Quality, RenderSize, Rgba8, encode};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: perspective photo.ARW [vertical|horizontal|both] [out]");
    let mode = match args.get(2).map(String::as_str) {
        Some("horizontal") => FitMode::Horizontal,
        Some("both") => FitMode::Both,
        _ => FitMode::Vertical,
    };
    let out = args.get(3).cloned().unwrap_or_else(|| "/tmp/perspective".into());
    let mut dev = Developer::from_bytes(&std::fs::read(path).expect("read")).expect("decode");
    let mut params = EditParams::default_for(dev.metadata());
    let size = RenderSize::fit(1600, 1600);

    let started = std::time::Instant::now();
    let segments = dev.detect_lines(&params, size);
    let detected = started.elapsed();
    let selected = segments.iter().filter(|s| s.selected).count();
    println!("{} lines ({selected} selected) in {detected:.0?}", segments.len());

    let mut img = dev.render(&params, size, Quality::Final);
    let mapping = dev.sensor_mapping(&params);
    let (w, h) = (img.width as f32, img.height as f32);
    for s in &segments {
        let color = match (s.selected, s.vertical) {
            (false, _) => [128, 128, 128],
            (true, true) => [40, 220, 60],
            (true, false) => [40, 120, 255],
        };
        let at = |p: (f32, f32)| {
            let (x, y) = mapping.from_sensor(p.0, p.1);
            (x * w, y * h)
        };
        draw_line(&mut img, at(s.a), at(s.b), color);
    }
    write(&img, &format!("{out}-lines.jpg"));

    let guides: Vec<GuideLine> = segments.iter().filter(|s| s.selected).map(|s| GuideLine { a: s.a, b: s.b, vertical: s.vertical }).collect();
    let Some(fit) = dev.fit_perspective(&params, &guides, mode) else {
        println!("nothing to fit");
        return;
    };
    println!("{fit:?}");
    let g: &mut Geometry = params.get_mut();
    (g.angle, g.vertical, g.horizontal, g.shear) = (fit.angle, fit.vertical, fit.horizontal, fit.shear);
    write(&dev.render(&params, size, Quality::Final), &format!("{out}-fitted.jpg"));
}

fn draw_line(img: &mut Rgba8, a: (f32, f32), b: (f32, f32), color: [u8; 3]) {
    let steps = (b.0 - a.0).abs().max((b.1 - a.1).abs()).ceil() as usize + 1;
    for i in 0..=steps {
        let t = i as f32 / steps as f32;
        let (x, y) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
        for (dx, dy) in [(0, 0), (1, 0), (0, 1)] {
            let (x, y) = (x as i64 + dx, y as i64 + dy);
            if x >= 0 && y >= 0 && (x as usize) < img.width && (y as usize) < img.height {
                let i = (y as usize * img.width + x as usize) * 4;
                img.data[i..i + 3].copy_from_slice(&color);
            }
        }
    }
}

fn write(img: &Rgba8, path: &str) {
    std::fs::write(path, encode::jpeg(img, 90).expect("encode")).expect("write");
    println!("wrote {path}");
}
