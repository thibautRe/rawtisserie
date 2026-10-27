//! Golden-image tests: render reference RAWs with a few recipes and compare the result
//! with the expected PNGs in `tests/golden/expected`, in CIEDE2000.
//!
//! ```sh
//! ./scripts/fetch-golden-raws.sh                                # once
//! cargo test --release -p rawtisserie-pipeline --test golden
//! GOLDEN_UPDATE=1 cargo test --release -p rawtisserie-pipeline --test golden   # accept changes
//! ```
//!
//! Every RAW in `golden/raws.txt` is rendered with every recipe in `golden/recipes`.
//! Each render starts from an empty cache, so the result doesn't depend on the order.
//! On failure the actual render and a ΔE heatmap are written next to the test binary
//! (the paths are printed). A change that moves these images must say why.

use std::fmt::Write as _;
use std::io::Cursor;
use std::path::Path;

use rawtisserie_pipeline::{Developer, EditParams, Quality, RenderSize, Rgba8};
use serde::Deserialize;

/// Mean ΔE00 above this fails: a global shift of about a third of a level.
const MAX_MEAN: f64 = 0.15;
/// The 99.9th percentile ΔE00 above this fails: more than scattered rounding flips.
const MAX_P999: f64 = 1.0;

#[derive(Deserialize)]
struct Case {
    /// Fit in a `size`×`size` box; 0 is full size.
    size: u32,
    recipe: EditParams,
}

#[test]
fn golden_images() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let update = std::env::var_os("GOLDEN_UPDATE").is_some();
    let out_dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("golden");
    std::fs::create_dir_all(&out_dir).unwrap();

    let raws: Vec<String> = std::fs::read_to_string(root.join("raws.txt"))
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| l.split_whitespace().nth(1).expect("<sha256> <name> <url>").to_string())
        .collect();
    let missing: Vec<&String> = raws.iter().filter(|name| !root.join("raws").join(name).exists()).collect();
    assert!(missing.is_empty(), "missing reference RAWs {missing:?}: run ./scripts/fetch-golden-raws.sh");

    let mut recipes: Vec<(String, Case)> = std::fs::read_dir(root.join("recipes"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let case = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            (name, case)
        })
        .collect();
    recipes.sort_by(|a, b| a.0.cmp(&b.0));

    let mut report = String::new();
    let mut failures = Vec::new();
    for raw in &raws {
        let mut dev = Developer::from_bytes(&std::fs::read(root.join("raws").join(raw)).unwrap())
            .unwrap_or_else(|e| panic!("{raw}: {e}"));
        let stem = Path::new(raw).file_stem().unwrap().to_string_lossy().into_owned();
        for (recipe, case) in &recipes {
            dev.release_cache();
            let img = dev.render(&case.recipe, RenderSize::fit(case.size, case.size), Quality::Final);
            let name = format!("{stem}.{recipe}");
            let expected_path = root.join("expected").join(format!("{name}.png"));
            if update {
                std::fs::write(&expected_path, encode_png(&rgb(&img), img.width, img.height)).unwrap();
                writeln!(report, "  {name:<32} written").unwrap();
                continue;
            }
            let Some((w, h, expected)) = std::fs::read(&expected_path).ok().map(|png| decode_png(&png)) else {
                failures.push(format!("{name}: no expected image (run with GOLDEN_UPDATE=1)"));
                continue;
            };
            if (w, h) != (img.width, img.height) {
                failures.push(format!("{name}: {}×{} instead of {w}×{h}", img.width, img.height));
                continue;
            }
            let diff = Diff::new(&expected, &rgb(&img));
            writeln!(report, "  {name:<32} ΔE00 mean {:.3}, 99.9% {:.2}, max {:.2}", diff.mean, diff.p999, diff.max).unwrap();
            if diff.mean > MAX_MEAN || diff.p999 > MAX_P999 {
                let actual = out_dir.join(format!("{name}.actual.png"));
                let heatmap = out_dir.join(format!("{name}.diff.png"));
                std::fs::write(&actual, encode_png(&rgb(&img), w, h)).unwrap();
                std::fs::write(&heatmap, encode_png(&diff.heatmap(), w, h)).unwrap();
                failures.push(format!(
                    "{name}: ΔE00 mean {:.3} (max {MAX_MEAN}), 99.9% {:.2} (max {MAX_P999})\n    {}\n    {}",
                    diff.mean,
                    diff.p999,
                    actual.display(),
                    heatmap.display()
                ));
            }
        }
    }
    println!("golden images:\n{report}");
    assert!(failures.is_empty(), "golden images differ:\n  {}", failures.join("\n  "));
}

fn rgb(img: &Rgba8) -> Vec<u8> {
    img.data.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect()
}

fn encode_png(rgb: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::High);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(rgb).unwrap();
    writer.finish().unwrap();
    out
}

/// Width, height and RGB data.
fn decode_png(png: &[u8]) -> (usize, usize, Vec<u8>) {
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!((info.color_type, info.bit_depth), (png::ColorType::Rgb, png::BitDepth::Eight));
    buf.truncate(info.buffer_size());
    (info.width as usize, info.height as usize, buf)
}

struct Diff {
    per_pixel: Vec<f32>,
    mean: f64,
    p999: f64,
    max: f64,
}

impl Diff {
    fn new(expected: &[u8], actual: &[u8]) -> Self {
        let to_linear: Vec<f64> = (0..256).map(|v| srgb_to_linear(v as f64 / 255.0)).collect();
        let lab = |p: &[u8]| lab([to_linear[p[0] as usize], to_linear[p[1] as usize], to_linear[p[2] as usize]]);
        let per_pixel: Vec<f32> = expected
            .chunks_exact(3)
            .zip(actual.chunks_exact(3))
            .map(|(e, a)| if e == a { 0.0 } else { delta_e_2000(lab(e), lab(a)) as f32 })
            .collect();
        let mut sorted = per_pixel.clone();
        sorted.sort_unstable_by(f32::total_cmp);
        Self {
            mean: sorted.iter().map(|&d| d as f64).sum::<f64>() / sorted.len() as f64,
            p999: sorted[(sorted.len() - 1) * 999 / 1000] as f64,
            max: *sorted.last().unwrap() as f64,
            per_pixel,
        }
    }

    /// Black where identical, through red (ΔE 1) to yellow (ΔE ≥ 5).
    fn heatmap(&self) -> Vec<u8> {
        self.per_pixel
            .iter()
            .flat_map(|&d| {
                let red = (d * 255.0).clamp(0.0, 255.0) as u8;
                let yellow = ((d - 1.0) / 4.0 * 255.0).clamp(0.0, 255.0) as u8;
                [red, yellow, 0]
            })
            .collect()
    }
}

fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

/// Linear sRGB → CIELAB (D65).
fn lab([r, g, b]: [f64; 3]) -> [f64; 3] {
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    let f = |t: f64| if t > 216.0 / 24389.0 { t.cbrt() } else { (24389.0 / 27.0 * t + 16.0) / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIEDE2000 (Sharma, Wu & Dalal 2005), with kL = kC = kH = 1.
fn delta_e_2000([l1, a1, b1]: [f64; 3], [l2, a2, b2]: [f64; 3]) -> f64 {
    let deg = |r: f64| r.to_degrees();
    let rad = |d: f64| d.to_radians();

    let c_bar = (a1.hypot(b1) + a2.hypot(b2)) / 2.0;
    let g = 0.5 * (1.0 - (c_bar.powi(7) / (c_bar.powi(7) + 25f64.powi(7))).sqrt());
    let (a1, a2) = (a1 * (1.0 + g), a2 * (1.0 + g));
    let (c1, c2) = (a1.hypot(b1), a2.hypot(b2));
    let hue = |b: f64, a: f64| if a == 0.0 && b == 0.0 { 0.0 } else { deg(b.atan2(a)).rem_euclid(360.0) };
    let (h1, h2) = (hue(b1, a1), hue(b2, a2));

    let dl = l2 - l1;
    let dc = c2 - c1;
    let dh = if c1 * c2 == 0.0 {
        0.0
    } else if (h2 - h1).abs() <= 180.0 {
        h2 - h1
    } else if h2 <= h1 {
        h2 - h1 + 360.0
    } else {
        h2 - h1 - 360.0
    };
    let dh_big = 2.0 * (c1 * c2).sqrt() * (rad(dh) / 2.0).sin();

    let l_bar = (l1 + l2) / 2.0;
    let c_bar = (c1 + c2) / 2.0;
    let h_bar = if c1 * c2 == 0.0 {
        h1 + h2
    } else if (h1 - h2).abs() <= 180.0 {
        (h1 + h2) / 2.0
    } else if h1 + h2 < 360.0 {
        (h1 + h2 + 360.0) / 2.0
    } else {
        (h1 + h2 - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * (rad(h_bar - 30.0)).cos() + 0.24 * (rad(2.0 * h_bar)).cos() + 0.32 * (rad(3.0 * h_bar + 6.0)).cos()
        - 0.20 * (rad(4.0 * h_bar - 63.0)).cos();
    let d_theta = 30.0 * (-((h_bar - 275.0) / 25.0).powi(2)).exp();
    let r_c = 2.0 * (c_bar.powi(7) / (c_bar.powi(7) + 25f64.powi(7))).sqrt();
    let s_l = 1.0 + 0.015 * (l_bar - 50.0).powi(2) / (20.0 + (l_bar - 50.0).powi(2)).sqrt();
    let s_c = 1.0 + 0.045 * c_bar;
    let s_h = 1.0 + 0.015 * c_bar * t;
    let r_t = -(rad(2.0 * d_theta)).sin() * r_c;

    ((dl / s_l).powi(2) + (dc / s_c).powi(2) + (dh_big / s_h).powi(2) + r_t * (dc / s_c) * (dh_big / s_h)).sqrt()
}

#[test]
fn delta_e_2000_matches_sharma_test_data() {
    // Pairs 1, 7, 17 and 25 of Sharma's table.
    let cases = [
        ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
        ([50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669),
        ([50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492),
        ([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644),
    ];
    for (a, b, expected) in cases {
        let d = delta_e_2000(a, b);
        assert!((d - expected).abs() < 1e-4, "{a:?} {b:?}: {d} instead of {expected}");
    }
}
