//! Render timings for typical interactions:
//! `cargo run --release --example bench -- photo.ARW [size]`

use std::time::Instant;

use rawtisserie_pipeline::params::{Color, ColorPrimaries, ContrastEqualizer, EditParams, Exposure, Filmic, Geometry, ShadowsHighlights, Sharpen, WhiteBalance};
use rawtisserie_pipeline::ops::clipping::{DisplayClipping, Overlays};
use rawtisserie_pipeline::{Developer, Quality, RenderSize};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let size: u32 = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(2400);
    let mut dev = Developer::from_bytes(&std::fs::read(&args[1])?)?;
    let fit = RenderSize::fit(size, size);

    // What a new import of this file starts with (lens correction when available).
    let mut p = EditParams::default_for(dev.metadata());
    p.get_mut::<WhiteBalance>().warmth = 0.2;
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
    Ok(())
}
