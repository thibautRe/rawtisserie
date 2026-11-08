//! Render timings for typical interactions:
//! `cargo run --release --example bench -- photo.ARW [size] [lut.cube|hald.png]`
//! (a synthetic 65³ LUT without one)

use std::time::Instant;

use rawtisserie_pipeline::params::{
    BlendMode, ColorBalance, ColorCalibration, ColorPrimaries, ContrastEqualizer, DrawnShape, EditParams, Exposure, Filmic, Geometry, Glow, Illuminant, Mask, Module, Shape, Sharpen, ToneCurve,
};
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
    p.get_mut::<ColorBalance>().chroma[0] = 0.2;
    p.get_mut::<ColorBalance>().vibrance = 0.2;
    p.get_mut::<ColorBalance>().brilliance[1] = 0.3;
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

    // Colour balance: drag the saturation (the dt UCS path), then a range's mixer alone.
    for i in 0..3 {
        p.get_mut::<ColorBalance>().saturation[1] = 0.1 * (i + 1) as f32;
        time("balance saturation drag", &mut dev, &p);
    }
    let graded = p.get_mut::<ColorBalance>().clone();
    *p.get_mut::<ColorBalance>() = ColorBalance::default();
    for i in 0..3 {
        p.get_mut::<ColorBalance>().highlights.temperature = 5000.0 - 200.0 * i as f32;
        time("balance mixer drag (mixer only)", &mut dev, &p);
    }
    *p.get_mut::<ColorBalance>() = ColorBalance { highlights: p.get_mut::<ColorBalance>().highlights.clone(), ..graded };
    time("balance, mixer and grading", &mut dev, &p);

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

    // Tone curve: drag a node (a point module, at full size), then each mode.
    for i in 0..3 {
        p.get_mut::<ToneCurve>().rgb[5] = 0.1 * (i + 1) as f32;
        time("tone curve drag", &mut dev, &p);
    }
    p.get_mut::<ToneCurve>().preserve_colors = rawtisserie_pipeline::params::RgbNorm::None;
    time("tone curve per channel", &mut dev, &p);
    p.get_mut::<ToneCurve>().channels = rawtisserie_pipeline::params::CurveChannels::Independent;
    p.get_mut::<ToneCurve>().red[6] = 0.2;
    time("tone curve independent", &mut dev, &p);
    p.get_mut::<ToneCurve>().channels = rawtisserie_pipeline::params::CurveChannels::Linked;
    p.get_mut::<ToneCurve>().preserve_colors = rawtisserie_pipeline::params::RgbNorm::Luminance;
    p.get_mut::<Exposure>().ev += 0.1;
    time("exposure slider with tone curve", &mut dev, &p);

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

    // Glow: drag the strength at draft size, release; then a low threshold (mist), with
    // most of the image above it.
    let glow = p.add(Glow::default());
    for i in 0..3 {
        if let Module::Glow(g) = &mut p.modules[glow].module {
            g.strength = 1.0 + 0.2 * i as f32;
        }
        let t = Instant::now();
        let img = dev.render(&p, draft, Quality::Interactive);
        println!("{:<34} {:>7.1} ms  ({}×{})", "glow drag (draft)", t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }
    time("glow release (full)", &mut dev, &p);
    if let Module::Glow(g) = &mut p.modules[glow].module {
        g.threshold = -1.0;
    }
    time("glow, low threshold (full)", &mut dev, &p);
    p.modules[glow].enabled = false;

    // A creative LUT after filmic: on filmic's 3D table, then while filmic is dragged.
    let lut = match args.get(3) {
        Some(path) => std::fs::read(path)?,
        None => {
            let n = 65;
            let mut cube = format!("LUT_3D_SIZE {n}\n");
            let node = |i: usize| i as f32 / (n - 1) as f32;
            for b in 0..n {
                for g in 0..n {
                    for r in 0..n {
                        let [r, g, b] = [node(r), node(g), node(b)];
                        cube += &format!("{} {} {}\n", r.powf(1.2), g, (0.8 * b + 0.2 * r).sqrt());
                    }
                }
            }
            cube.into_bytes()
        }
    };
    let t = Instant::now();
    let id = dev.luts_mut().load(&lut)?;
    println!("{:<34} {:>7.1} ms", "LUT loaded", t.elapsed().as_secs_f64() * 1e3);
    let l = p.add(rawtisserie_pipeline::params::Lut { lut: Some(rawtisserie_pipeline::params::LutRef { id, name: String::new() }), ..Default::default() });
    time("LUT added", &mut dev, &p);
    for _ in 0..2 {
        p.get_mut::<Exposure>().ev += 0.1;
        time("exposure slider with LUT", &mut dev, &p);
    }
    p.get_mut::<Filmic>().contrast += 0.05;
    time("filmic slider with LUT (exact)", &mut dev, &p);
    // At half opacity in soft light: still baked into filmic's table…
    p.modules[l].mask = Some(Mask { opacity: 0.5, blend: BlendMode::SoftLight, ..Mask::default() });
    time("LUT blended", &mut dev, &p);
    p.get_mut::<Exposure>().ev += 0.1;
    time("exposure slider with LUT blended", &mut dev, &p);
    // …but not with a luminance range: then it runs per pixel.
    p.modules[l].mask.as_mut().unwrap().luminance = Some([-1.0, 0.0, 8.0, 10.0]);
    time("LUT with a range", &mut dev, &p);
    p.get_mut::<Exposure>().ev += 0.1;
    time("exposure slider with LUT range", &mut dev, &p);
    p.modules.remove(l);

    let overlays = Overlays { display: Some(DisplayClipping::default()), sensor: true, stripes: 0.0, ..Default::default() };
    for label in ["clipping indicators (first)", "clipping indicators"] {
        let t = Instant::now();
        let img = dev.render_with_overlays(&p, fit, Quality::Interactive, &overlays);
        println!("{label:<34} {:>7.1} ms  ({}×{})", t.elapsed().as_secs_f64() * 1e3, img.width, img.height);
    }

    // Masks: a gradient with an edge-aware feather and a luminance range on a second
    // exposure, then a saturation boost through an ellipse.
    p.shapes.insert("sky".into(), Shape::Gradient { anchor: [0.5, 0.4], angle: -1.57, feather: 0.2, opacity: 1.0 });
    p.shapes.insert("spot".into(), Shape::Ellipse { center: [0.5, 0.55], radii: [0.2, 0.15], rotation: 0.0, feather: 0.03, opacity: 1.0 });
    let sky = p.add(Exposure { ev: -1.0, black: 0.0 });
    p.modules[sky].mask = Some(Mask { drawn: vec![DrawnShape { shape: "sky".into(), ..Default::default() }], luminance: Some([-1.0, 0.0, 8.0, 10.0]), feather: 40.0, ..Mask::default() });
    time("mask added (drawn, guided)", &mut dev, &p);
    for _ in 0..3 {
        if let rawtisserie_pipeline::params::Module::Exposure(e) = &mut p.modules[sky].module {
            e.ev -= 0.1;
        }
        time("masked exposure slider", &mut dev, &p);
    }
    for _ in 0..2 {
        p.modules[sky].mask.as_mut().unwrap().luminance.as_mut().unwrap()[1] += 0.1;
        time("mask range slider", &mut dev, &p);
    }
    p.modules[sky].mask.as_mut().unwrap().blend = BlendMode::SoftLight;
    for _ in 0..2 {
        if let rawtisserie_pipeline::params::Module::Exposure(e) = &mut p.modules[sky].module {
            e.ev -= 0.1;
        }
        time("masked exposure slider, soft light", &mut dev, &p);
    }
    p.modules[sky].mask.as_mut().unwrap().blend = BlendMode::Normal;
    let i = p.add(ColorBalance { chroma: [0.5, 0.0, 0.0, 0.0], ..Default::default() });
    p.modules[i].mask = Some(Mask { drawn: vec![DrawnShape { shape: "spot".into(), ..Default::default() }], ..Mask::default() });
    time("second mask added", &mut dev, &p);
    p.get_mut::<Exposure>().ev += 0.1;
    time("exposure slider with 2 masks", &mut dev, &p);
    for _ in 0..2 {
        if let Some(Shape::Ellipse { center, .. }) = p.shapes.get_mut("spot") {
            center[0] += 0.01;
        }
        time("mask shape moved", &mut dev, &p);
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
