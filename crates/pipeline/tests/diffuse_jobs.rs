//! The browser diffuses each channel of a diffuse step on its own worker
//! (`Developer::next_diffuse_job` / `provide_diffuse`): the render must be the same as
//! when the developer diffuses them itself.
//!
//! Uses the golden RAWs (`./scripts/fetch-golden-raws.sh`).

use std::path::Path;

use rawtisserie_pipeline::ops::diffuse::DiffuseOp;
use rawtisserie_pipeline::params::{ContrastEqualizer, Diffuse, DrawnShape, Mask, Shape};
use rawtisserie_pipeline::{Developer, EditParams, Quality, Region, RenderSize};

fn developer() -> Developer {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/raws/sony-ilce-7m3.arw");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e} (run ./scripts/fetch-golden-raws.sh)", path.display()));
    Developer::from_bytes(&bytes).unwrap()
}

/// Render through jobs, diffusing the planes apart (last first, as workers might).
fn render_with_jobs(dev: &mut Developer, p: &EditParams, size: RenderSize) -> (Vec<u8>, usize) {
    let mut jobs = 0;
    while let Some(mut job) = dev.next_diffuse_job(p, size) {
        jobs += 1;
        let op = DiffuseOp::new(&job.params, job.scale);
        for plane in job.planes.planes.iter_mut().rev() {
            op.diffuse_plane(plane, job.planes.mask.as_deref(), job.width, job.height);
        }
        dev.provide_diffuse(job.key, job.width, job.height, &job.planes.planes);
        assert!(jobs < 10, "jobs never run out");
    }
    (dev.render(p, size, Quality::Final).data, jobs)
}

#[test]
fn diffusing_channels_elsewhere_gives_the_same_render() {
    let mut p = EditParams::default_for(developer().metadata());
    p.add(Diffuse { iterations: 3.0, radius: 8.0, ..Diffuse::default() });
    let masked = p.add(Diffuse { iterations: 2.0, radius: 32.0, speed1: 0.5, speed2: 0.5, speed3: 0.5, speed4: 0.5, luminance_threshold: 0.8, ..Diffuse::default() });
    p.shapes.insert("half".into(), Shape::Gradient { anchor: [0.5, 0.5], angle: 0.0, feather: 0.1, opacity: 1.0 });
    p.modules[masked].mask = Some(Mask { drawn: vec![DrawnShape { shape: "half".into(), ..Default::default() }], feather: 10.0, ..Default::default() });
    p.get_mut::<ContrastEqualizer>().luma = [0.7, 0.6, 0.55, 0.5, 0.65, 0.7];

    for (name, size) in [
        ("fit", RenderSize::fit(900, 900)),
        ("region", RenderSize::fit(1500, 1500).with_region(Region { x: 300, y: 200, width: 400, height: 300 })),
    ] {
        let want = developer().render(&p, size, Quality::Final).data;
        let mut dev = developer();
        let (got, jobs) = render_with_jobs(&mut dev, &p, size);
        assert_eq!(jobs, 2, "{name}: one job per diffuse step");
        assert!(got == want, "{name}: differs from the developer's own render");
        // Cached now: nothing left to do.
        assert!(dev.next_diffuse_job(&p, size).is_none(), "{name}");
    }
}

#[test]
fn no_jobs_without_diffuse() {
    let mut dev = developer();
    let p = EditParams::default_for(dev.metadata());
    assert!(dev.next_diffuse_job(&p, RenderSize::fit(600, 600)).is_none());
}
