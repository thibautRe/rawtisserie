//! Render timings for typical interactions:
//! `cargo run --release --example bench -- photo.ARW [size]`

use std::time::Instant;

use rawtisserie_pipeline::params::{Color, ColorCalibration, ColorPrimaries, ContrastEqualizer, EditParams, Exposure, Filmic, Geometry, Illuminant, ShadowsHighlights, Sharpen};
use rawtisserie_pipeline::ops::clipping::{DisplayClipping, Overlays};
use rawtisserie_pipeline::{Developer, Quality, Region, RenderSize};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let size: u32 = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(2400);
    let mut dev = Developer::from_bytes(&std::fs::read(&args[1])?)?;
    let fit = RenderSize::fit(size, size);

    // What a new import of this file starts with (lens correction when available).
    let mut p = EditParams::default_for(dev.metadata());
    p.get_mut::<ColorCalibration>().colorfulness = [0.1; 3];
    p.get_mut::<Color>().saturation = 0.2;
    p.get_mut::<Color>().vibrance = 0.2;
    p.get_mut::<ShadowsHighlights>().shadows = 0.3;
    p.get_mut::<Sharpen>().amount = 0.5;

    let time = |label: &str, dev: &mut Developer, p: &EditParams| {
        let t = Instant::now();
        let img = dev.render(p, fit, Quality::Interactive);
        println!("{label:<34} {:>7.1} ms  ({}×{})", t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    };

    time("cold (decode excluded)", &mut dev, &p);
    for i in 0..3 {
        p.get_mut::<Exposure>().ev += 0.1;
        p.get_mut::<Filmic>().contrast += 0.05 * i as f32;
        time("exposure/tone slider", &mut dev, &p);
    }
    p.get_mut::<Sharpen>().amount += 0.1;
    time("sharpen slider", &mut dev, &p);
    p.get_mut::<Geometry>().angle += 0.5;
    time("straighten slider", &mut dev, &p);
    p.get_mut::<Exposure>().ev += 0.1;
    time("exposure slider again", &mut dev, &p);

    // Interactive: drag at half resolution, release at full.
    let draft = RenderSize::fit(size / 2, size / 2);
    for i in 0..3 {
        p.get_mut::<Exposure>().ev += 0.1;
        let t = Instant::now();
        let img = dev.render(&p, draft, Quality::Interactive);
        println!("{:<34} {:>7.1} ms  ({}×{})", if i == 0 { "drag (draft, first)" } else { "drag (draft)" }, t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }
    time("release (full, cached)", &mut dev, &p);

    // Colour calibration: drag the temperature.
    p.get_mut::<ColorCalibration>().illuminant = Illuminant::Daylight;
    for _ in 0..3 {
        p.get_mut::<ColorCalibration>().temperature += 100.0;
        let t = Instant::now();
        let img = dev.render(&p, draft, Quality::Interactive);
        println!("{:<34} {:>7.1} ms  ({}×{})", "temperature drag (draft)", t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }

    // Colour primaries: drag a slider, release, then other sliders.
    for i in 0..3 {
        p.get_mut::<ColorPrimaries>().red.hue += 5.0;
        let t = Instant::now();
        let img = dev.render(&p, draft, Quality::Interactive);
        println!("{:<34} {:>7.1} ms  ({}×{})", if i == 0 { "primaries drag (draft, first)" } else { "primaries drag (draft)" }, t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }
    time("primaries release", &mut dev, &p);
    p.get_mut::<Exposure>().ev += 0.1;
    time("exposure slider with primaries", &mut dev, &p);

    // Contrast equalizer: drag a curve node at draft size, release.
    for i in 0..3 {
        p.get_mut::<ContrastEqualizer>().luma[3] = 0.6 + 0.02 * i as f32;
        let t = Instant::now();
        let img = dev.render(&p, draft, Quality::Interactive);
        println!("{:<34} {:>7.1} ms  ({}×{})", "equalizer drag (draft)", t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }
    time("equalizer release (full)", &mut dev, &p);
    p.get_mut::<Exposure>().ev += 0.1;
    time("exposure slider with equalizer", &mut dev, &p);

    let overlays = Overlays { display: Some(DisplayClipping::default()), sensor: true, stripes: 0.0 };
    for label in ["clipping indicators (first)", "clipping indicators"] {
        let t = Instant::now();
        let img = dev.render_with_overlays(&p, fit, Quality::Interactive, &overlays);
        println!("{label:<34} {:>7.1} ms  ({}×{})", t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }

    // Zoomed in: a 1300×900 view at 70 % and 100 %, panned a little then a lot.
    let (full_w, full_h, _) = dev.output_size(&p, RenderSize::FULL);
    for zoom in [0.7f32, 1.0] {
        let (w, h) = ((full_w as f32 * zoom).round() as u32, (full_h as f32 * zoom).round() as u32);
        let at = |x: usize, y: usize| RenderSize::fit(w, h).with_region(Region { x, y, width: 1300, height: 900 });
        let (cx, cy) = (w as usize / 2 - 650, h as usize / 2 - 450);
        let pct = (zoom * 100.0).round();
        for (label, size) in [("first", at(cx, cy)), ("pan 100 px", at(cx + 100, cy)), ("pan 1000 px", at(cx + 1000, cy))] {
            let t = Instant::now();
            dev.spatial_image(&p, size);
            let spatial = t.elapsed().as_secs_f64() * 1e3;
            let img = dev.render(&p, size, Quality::Interactive);
            let total = t.elapsed().as_secs_f64() * 1e3;
            println!("{:<34} {total:>7.1} ms  ({}×{}, spatial {spatial:.1} ms)", format!("zoom {pct} %, {label}"), img.width, img.height);
        }
        p.get_mut::<Exposure>().ev += 0.1;
        let t = Instant::now();
        let img = dev.render(&p, at(cx + 1000, cy), Quality::Interactive);
        println!("{:<34} {:>7.1} ms  ({}×{})", format!("zoom {pct} %, exposure slider"), t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }
    Ok(())
}
