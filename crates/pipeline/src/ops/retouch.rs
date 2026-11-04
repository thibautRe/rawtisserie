//! Spot removal (roadmap 4.4): heal, clone, fill and blur inside drawn shapes, on the
//! base image (sensor frame), before lens correction and the rest of the geometry.
//!
//! Follows Ansel's `src/iop/retouch.c` and `src/pixel/heal.c` (upstream commit
//! 11fe9d5, GPL-3.0-or-later). Each spot rasterises its shape over the shape's bounding
//! box and blends the result in with the shape's alpha times the spot's opacity, in
//! list order: later spots see what earlier ones did.
//!
//! * **Clone** copies the pixels at the source offset (whole pixels, as Ansel does).
//! * **Heal** copies them too, then adds a smooth correction so that they meet the
//!   target's surroundings: the difference between target and source is fixed outside
//!   the shape and solved for inside it with ΔI = 0 (Laplace), by red/black Gauss-Seidel
//!   with over-relaxation. The difference is taken between square roots (Ansel's "sqrt"
//!   heal algorithm, its default), so that the source's noise takes the amplitude it
//!   would have at the target's level.
//! * **Fill** paints a colour; **blur** is a Gaussian blur of what is there.
//!
//! Deviations from Ansel:
//! * no wavelet decomposition (Ansel can retouch only some scales); no bilateral blur;
//! * the Laplace solve starts from a coarse-to-fine estimate (the shape at half
//!   resolution, recursively) rather than from the plain difference, so it converges
//!   in far fewer iterations; the stopping criterion is Ansel's;
//! * a source outside the image reads its edge pixels (Ansel shrinks the spot).
//!
//! Region renders develop a patch of the base: [`needed`] says which pixels a patch
//! must hold so that the spots touching an area come out as in the whole image, and
//! [`apply`] skips the spots that read outside the pixels it has.

use std::hash::{Hash, Hasher};

use serde::Serialize;

use super::filters;
use crate::image::{Image, Region, Rgb};
use crate::params::{EditParams, Retouch, Shape, Spot, SpotMode};
use crate::shapes::ShapeMask;

/// A spot with its shape, ready to apply.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Stamp {
    pub spot: Spot,
    pub shape: Shape,
}

/// The stamps of the recipe's enabled retouch instances, in order.
pub fn stamps(params: &EditParams) -> Vec<Stamp> {
    params
        .all::<Retouch>()
        .flat_map(|r| &r.spots)
        .filter(|s| s.opacity > 0.0)
        .filter_map(|s| Some(Stamp { spot: s.clone(), shape: params.shapes.get(&s.shape)?.clone() }))
        .collect()
}

/// Identifies a list of stamps for caches: 0 without any.
pub fn key(stamps: &[Stamp]) -> u64 {
    if stamps.is_empty() {
        return 0;
    }
    let mut h = std::hash::DefaultHasher::new();
    serde_json::to_string(stamps).expect("stamps serialise").hash(&mut h);
    h.finish() | 1
}

/// What a stamp touches in a `frame`-sized base.
struct Plan {
    /// The shape's bounds: the only pixels it changes.
    target: Region,
    /// Every pixel it reads (the target included).
    reads: Region,
    /// Source offset in pixels (heal and clone).
    offset: (i64, i64),
}

/// `scale`: base pixels per full-resolution pixel.
fn plan(stamp: &Stamp, frame: (usize, usize), scale: f32) -> Option<Plan> {
    let target = stamp.shape.bounds(frame)?;
    let (w, h) = frame;
    let offset = ((stamp.spot.source[0] * w as f32).round() as i64, (stamp.spot.source[1] * h as f32).round() as i64);
    let reads = match stamp.spot.mode {
        SpotMode::Heal | SpotMode::Clone => union(target, shifted(target, offset, frame)),
        SpotMode::Fill => target,
        SpotMode::Blur => target.padded(filters::reach(blur_sigma(&stamp.spot, scale)), w, h),
    };
    Some(Plan { target, reads, offset })
}

fn blur_sigma(spot: &Spot, scale: f32) -> f32 {
    spot.radius.max(0.0) * scale
}

/// The pixels that `r` moved by `offset` reads, with coordinates clamped to the frame.
fn shifted(r: Region, (dx, dy): (i64, i64), (w, h): (usize, usize)) -> Region {
    let clamp = |v: i64, len: usize| v.clamp(0, len as i64 - 1) as usize;
    let (x0, x1) = (clamp(r.x as i64 + dx, w), clamp(r.right() as i64 - 1 + dx, w));
    let (y0, y1) = (clamp(r.y as i64 + dy, h), clamp(r.bottom() as i64 - 1 + dy, h));
    Region { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

fn union(a: Region, b: Region) -> Region {
    let (x, y) = (a.x.min(b.x), a.y.min(b.y));
    Region { x, y, width: a.right().max(b.right()) - x, height: a.bottom().max(b.bottom()) - y }
}

fn intersects(a: &Region, b: &Region) -> bool {
    a.x < b.right() && b.x < a.right() && a.y < b.bottom() && b.y < a.bottom()
}

/// The pixels of a `frame`-sized base needed to retouch `area` as in the whole image:
/// `area`, plus everything read by the spots that change it, and so on for the spots
/// that change those pixels.
pub fn needed(stamps: &[Stamp], frame: (usize, usize), scale: f32, area: Region) -> Region {
    let plans: Vec<Plan> = stamps.iter().filter_map(|s| plan(s, frame, scale)).collect();
    let mut need = area;
    loop {
        let grown = plans.iter().filter(|p| intersects(&p.target, &need)).fold(need, |r, p| union(r, p.reads));
        if grown == need {
            return need;
        }
        need = grown;
    }
}

/// The pixels of a region (frame coordinates) before a stamp changed them.
#[derive(Clone, Debug)]
pub struct Saved {
    region: Region,
    pixels: Image,
}

/// Apply the stamps to `img`, in place. `img` holds pixels `at` of a `frame`-sized
/// base; spatial parameters are at `scale` (base pixels per full-resolution pixel).
/// Stamps that read pixels outside `at` are skipped (see [`needed`]). Returns what they
/// overwrote, for [`restore`].
pub fn apply(img: &mut Image, at: Region, frame: (usize, usize), stamps: &[Stamp], scale: f32) -> Vec<Saved> {
    debug_assert_eq!((img.width, img.height), (at.width, at.height));
    let mut saved = Vec::new();
    for stamp in stamps {
        let Some(plan) = plan(stamp, frame, scale) else { continue };
        if !at.contains(&plan.reads) {
            continue;
        }
        let Some(mask) = stamp.shape.rasterize(frame) else { continue };
        let opacity = stamp.spot.opacity.clamp(0.0, 1.0);
        let view = View { at, frame };
        let t = plan.target;
        saved.push(Saved { region: t, pixels: img.crop(Region { x: t.x - at.x, y: t.y - at.y, ..t }) });
        match stamp.spot.mode {
            SpotMode::Clone => {
                let src = view.read_shifted(img, plan.target, plan.offset);
                view.blend(img, &mask, opacity, |i, _| src[i]);
            }
            SpotMode::Heal => {
                let healed = heal(&view, img, &mask, plan.offset);
                view.blend(img, &mask, opacity, |i, _| healed[i]);
            }
            SpotMode::Fill => {
                let color = stamp.spot.color;
                view.blend(img, &mask, opacity, |_, _| color);
            }
            SpotMode::Blur => {
                let sigma = blur_sigma(&stamp.spot, scale);
                if !filters::blur_active(sigma) {
                    continue;
                }
                let r = plan.reads;
                let mut sub = img.crop(Region { x: r.x - at.x, y: r.y - at.y, ..r });
                filters::blur(&mut sub, sigma);
                view.blend(img, &mask, opacity, |i, _| {
                    let (x, y) = (t.x + i % t.width, t.y + i / t.width);
                    sub.get(x - r.x, y - r.y)
                });
            }
        }
    }
    saved
}

/// Undo [`apply`]: put back what it overwrote (in reverse order, as spots may overlap).
pub fn restore(img: &mut Image, at: Region, saved: Vec<Saved>) {
    for s in saved.into_iter().rev() {
        let r = s.region;
        for y in 0..r.height {
            let row = (r.y + y - at.y) * img.width + (r.x - at.x);
            img.pixels[row..row + r.width].copy_from_slice(&s.pixels.pixels[y * r.width..(y + 1) * r.width]);
        }
    }
}

/// An image holding pixels `at` of a `frame`-sized base.
struct View {
    at: Region,
    frame: (usize, usize),
}

impl View {
    #[inline]
    fn get(&self, img: &Image, x: usize, y: usize) -> Rgb {
        img.get(x - self.at.x, y - self.at.y)
    }

    /// The pixels of `r` (row-major) as read `offset` away, clamped to the frame.
    fn read_shifted(&self, img: &Image, r: Region, (dx, dy): (i64, i64)) -> Vec<Rgb> {
        let (w, h) = self.frame;
        let mut out = Vec::with_capacity(r.width * r.height);
        for y in r.y..r.bottom() {
            let sy = (y as i64 + dy).clamp(0, h as i64 - 1) as usize;
            for x in r.x..r.right() {
                let sx = (x as i64 + dx).clamp(0, w as i64 - 1) as usize;
                out.push(self.get(img, sx, sy));
            }
        }
        out
    }

    /// Mix `value(i, current)` into the pixels of the mask's region (index `i`,
    /// row-major) by the mask's alpha times `opacity`.
    fn blend(&self, img: &mut Image, mask: &ShapeMask, opacity: f32, mut value: impl FnMut(usize, Rgb) -> Rgb) {
        let r = mask.region;
        for (i, &alpha) in mask.alpha.iter().enumerate() {
            let a = alpha * opacity;
            if a <= 0.0 {
                continue;
            }
            let (x, y) = (r.x + i % r.width - self.at.x, r.y + i / r.width - self.at.y);
            let px = &mut img.pixels[y * img.width + x];
            let v = value(i, *px);
            for c in 0..3 {
                px[c] += a * (v[c] - px[c]);
            }
        }
    }
}

/// Offset under the square root (Ansel's `DT_HEAL_SQRT_OFFSET`): it keeps the transform
/// differentiable at 0 and stands in for the noise floor.
const SQRT_OFFSET: f32 = 1e-3;

#[inline]
fn encode(v: f32) -> f32 {
    (v.max(0.0) + SQRT_OFFSET).sqrt()
}

/// Inverse of [`encode`] applied to the source plus a correction. A negative source
/// keeps its negative part, which the square root can't carry.
#[inline]
fn decode(src: f32, correction: f32) -> f32 {
    let root = (encode(src) + correction).max(0.0);
    root * root - SQRT_OFFSET + src.min(0.0)
}

/// The healed pixels of the mask's region: the source, corrected so that it meets the
/// target where the mask ends.
fn heal(view: &View, img: &Image, mask: &ShapeMask, offset: (i64, i64)) -> Vec<Rgb> {
    let r = mask.region;
    let src = view.read_shifted(img, r, offset);
    let dst = view.read_shifted(img, r, (0, 0));
    let mut diff: Vec<Rgb> = dst.iter().zip(&src).map(|(d, s)| [0, 1, 2].map(|c| encode(d[c]) - encode(s[c]))).collect();
    let fixed: Vec<bool> = mask.alpha.iter().map(|&a| a <= 0.0).collect();
    solve_laplace(&mut diff, &fixed, r.width, r.height);
    src.iter().zip(&diff).map(|(s, d)| [0, 1, 2].map(|c| decode(s[c], d[c]))).collect()
}

/// Ansel's cap on relaxation iterations (its default `max_heal_iter`).
const MAX_ITERATIONS: usize = 2000;
/// Ansel's convergence threshold (for values whose white is 1).
const EPSILON: f32 = 0.1 / 255.0;
/// Below this size (either side), a level is solved without a coarser estimate.
const COARSEST: usize = 8;
/// Over-relaxation above a coarser estimate.
const REFINE_OMEGA: f32 = 1.85;

/// Solve ΔV = 0 for the pixels that aren't `fixed`, the others being the boundary
/// condition (and the edges of the `w × h` box reflecting). In place.
fn solve_laplace(v: &mut [Rgb], fixed: &[bool], w: usize, h: usize) {
    let unknown = fixed.iter().filter(|f| !**f).count();
    if unknown == 0 {
        return;
    }
    if w > COARSEST && h > COARSEST {
        // Half resolution: a pixel is fixed if any of its four is, to the mean of those.
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        let mut cv = vec![[0.0f32; 3]; cw * ch];
        let mut cfixed = vec![false; cw * ch];
        for cy in 0..ch {
            for cx in 0..cw {
                let (mut sum, mut n, mut all, mut m) = ([0.0f32; 3], 0, [0.0f32; 3], 0);
                for y in 2 * cy..(2 * cy + 2).min(h) {
                    for x in 2 * cx..(2 * cx + 2).min(w) {
                        let i = y * w + x;
                        for c in 0..3 {
                            all[c] += v[i][c];
                        }
                        m += 1;
                        if fixed[i] {
                            for c in 0..3 {
                                sum[c] += v[i][c];
                            }
                            n += 1;
                        }
                    }
                }
                let k = cy * cw + cx;
                cfixed[k] = n > 0;
                cv[k] = if n > 0 { sum.map(|s| s / n as f32) } else { all.map(|s| s / m as f32) };
            }
        }
        solve_laplace(&mut cv, &cfixed, cw, ch);
        // Bilinear: fine pixel x is at (x - 0.5) / 2 on the coarse grid.
        for y in 0..h {
            for x in 0..w {
                if fixed[y * w + x] {
                    continue;
                }
                let (fx, fy) = (((x as f32 - 0.5) / 2.0).clamp(0.0, (cw - 1) as f32), ((y as f32 - 0.5) / 2.0).clamp(0.0, (ch - 1) as f32));
                let (x0, y0) = (fx as usize, fy as usize);
                let (x1, y1) = ((x0 + 1).min(cw - 1), (y0 + 1).min(ch - 1));
                let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
                let (a, b, c, d) = (cv[y0 * cw + x0], cv[y0 * cw + x1], cv[y1 * cw + x0], cv[y1 * cw + x1]);
                v[y * w + x] = [0, 1, 2].map(|k| {
                    let top = a[k] + (b[k] - a[k]) * tx;
                    let bottom = c[k] + (d[k] - c[k]) * tx;
                    top + (bottom - top) * ty
                });
            }
        }
    }
    relax(v, fixed, w, h, unknown);
}

/// Red/black Gauss-Seidel with over-relaxation, as Ansel's `_heal_laplace_loop`, but
/// stopping on the mean change rather than the total (see the module docs).
fn relax(v: &mut [Rgb], fixed: &[bool], w: usize, h: usize, unknown: usize) {
    let coarsest = w <= COARSEST || h <= COARSEST;
    // Ansel's empirically optimal factor where the solve starts from scratch; above a
    // coarser estimate, less over-relaxation smooths the error it leaves faster.
    let omega = if coarsest { 2.0 - 1.0 / (0.1575 * (unknown as f32).sqrt() + 0.8) } else { REFINE_OMEGA };
    let exit = (EPSILON * omega / 4.0).powi(2) * unknown as f32 / 16.0;
    for _ in 0..MAX_ITERATIONS {
        let mut err = 0.0f32;
        for parity in [1, 0] {
            for y in 0..h {
                let start = (y + parity) % 2;
                for x in (start..w).step_by(2) {
                    let i = y * w + x;
                    if fixed[i] {
                        continue;
                    }
                    let mut sum = [0.0f32; 3];
                    let mut n = 0.0f32;
                    let mut add = |j: usize| {
                        for c in 0..3 {
                            sum[c] += v[j][c];
                        }
                        n += 1.0;
                    };
                    if x > 0 {
                        add(i - 1);
                    }
                    if x + 1 < w {
                        add(i + 1);
                    }
                    if y > 0 {
                        add(i - w);
                    }
                    if y + 1 < h {
                        add(i + w);
                    }
                    if n == 0.0 {
                        continue;
                    }
                    for c in 0..3 {
                        let delta = omega * (sum[c] / n - v[i][c]);
                        v[i][c] += delta;
                        err += delta * delta;
                    }
                }
            }
        }
        if err < exit {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: (usize, usize) = (120, 80);

    /// A horizontal ramp (brighter to the right) with a dark dot at (40, 40).
    fn image() -> Image {
        let mut img = Image::new(FRAME.0, FRAME.1);
        for y in 0..FRAME.1 {
            for x in 0..FRAME.0 {
                let v = 0.1 + 0.002 * x as f32;
                let dot = (x as f32 - 40.0).hypot(y as f32 - 40.0) < 4.0;
                img.pixels[y * FRAME.0 + x] = if dot { [0.01; 3] } else { [v, v * 0.9, v * 0.8] };
            }
        }
        img
    }

    fn stamp(mode: SpotMode, source: [f32; 2]) -> Stamp {
        // A circle of 8 px radius (0.1 × 80) with a 2.4 px feather, around the dot.
        Stamp {
            spot: Spot { shape: "s1".into(), mode, source, opacity: 1.0, color: [0.5, 0.25, 0.125], radius: 3.0 },
            shape: Shape::Ellipse { center: [40.0 / 120.0, 0.5], radii: [0.1, 0.1], rotation: 0.0, feather: 0.03, opacity: 1.0 },
        }
    }

    fn whole(stamps: &[Stamp]) -> Image {
        let mut img = image();
        apply(&mut img, Region::full(FRAME.0, FRAME.1), FRAME, stamps, 1.0);
        img
    }

    #[test]
    fn heal_removes_the_dot_and_matches_the_surroundings() {
        // The source, 30 px to the right, is brighter: healing brings it down to the target's level.
        let out = whole(&[stamp(SpotMode::Heal, [30.0 / 120.0, 0.0])]);
        let expected = image().get(40, 20); // outside the shape
        let at = out.get(40, 40);
        let ramp = 0.1 + 0.002 * 40.0;
        assert!((at[0] - ramp).abs() < 0.01, "{at:?} vs {ramp}");
        assert!((at[1] / at[0] - 0.9).abs() < 0.02);
        // Outside the shape, nothing changes.
        assert_eq!(out.get(60, 40), image().get(60, 40));
        assert_eq!(out.get(40, 20), expected);
    }

    #[test]
    fn clone_copies_the_source() {
        let out = whole(&[stamp(SpotMode::Clone, [30.0 / 120.0, 0.0])]);
        assert_eq!(out.get(40, 40), image().get(70, 40));
    }

    #[test]
    fn fill_and_blur() {
        let filled = whole(&[stamp(SpotMode::Fill, [0.0, 0.0])]);
        assert_eq!(filled.get(40, 40), [0.5, 0.25, 0.125]);
        let blurred = whole(&[stamp(SpotMode::Blur, [0.0, 0.0])]);
        let (before, after) = (image().get(40, 40)[0], blurred.get(40, 40)[0]);
        assert!(after > before + 0.02, "{before} → {after}");
    }

    #[test]
    fn opacity_mixes_with_the_original() {
        let mut s = stamp(SpotMode::Fill, [0.0, 0.0]);
        s.spot.opacity = 0.5;
        let out = whole(&[s]);
        assert!((out.get(40, 40)[0] - (0.01 + 0.5) / 2.0).abs() < 1e-6);
    }

    #[test]
    fn patches_give_the_same_pixels() {
        // Two spots, the second healing from where the first one cloned to.
        let mut second = stamp(SpotMode::Heal, [-0.1, 0.0]);
        second.shape = second.shape.translated(0.15, 0.1);
        let stamps = [stamp(SpotMode::Clone, [30.0 / 120.0, 0.0]), second];
        let expected = whole(&stamps);
        let area = Region { x: 55, y: 45, width: 10, height: 10 };
        let at = needed(&stamps, FRAME, 1.0, area);
        assert!(at.contains(&area) && at != area);
        let mut img = image().crop(at);
        apply(&mut img, at, FRAME, &stamps, 1.0);
        for y in area.y..area.bottom() {
            for x in area.x..area.right() {
                assert_eq!(img.get(x - at.x, y - at.y), expected.get(x, y), "({x}, {y})");
            }
        }
    }

    #[test]
    fn spots_reading_outside_a_patch_are_skipped() {
        let stamps = [stamp(SpotMode::Clone, [30.0 / 120.0, 0.0])];
        let at = Region { x: 20, y: 20, width: 40, height: 40 };
        let mut img = image().crop(at);
        assert!(apply(&mut img, at, FRAME, &stamps, 1.0).is_empty());
    }

    #[test]
    fn the_laplace_solve_converges_to_a_plane() {
        // Boundary values of a plane: the harmonic fill is that plane.
        let (w, h): (usize, usize) = (40, 30);
        let plane = |x: usize, y: usize| 0.3 + 0.01 * x as f32 - 0.005 * y as f32;
        let fixed: Vec<bool> = (0..w * h).map(|i| (i % w).abs_diff(20) > 12 || (i / w).abs_diff(15) > 9).collect();
        let mut v: Vec<Rgb> = (0..w * h).map(|i| if fixed[i] { [plane(i % w, i / w); 3] } else { [0.0; 3] }).collect();
        solve_laplace(&mut v, &fixed, w, h);
        let worst = (0..w * h).map(|i| (v[i][0] - plane(i % w, i / w)).abs()).fold(0.0, f32::max);
        assert!(worst < 2e-3, "{worst}");
    }

    #[test]
    fn restore_undoes_apply() {
        let mut overlapping = stamp(SpotMode::Fill, [0.0, 0.0]);
        overlapping.shape = overlapping.shape.translated(0.05, 0.0);
        let stamps = [stamp(SpotMode::Heal, [0.25, 0.0]), overlapping];
        let mut img = image();
        let at = Region::full(FRAME.0, FRAME.1);
        let saved = apply(&mut img, at, FRAME, &stamps, 1.0);
        assert_eq!(saved.len(), 2);
        restore(&mut img, at, saved);
        assert_eq!(img.pixels, image().pixels);
    }

    #[test]
    fn stamps_come_from_every_enabled_instance() {
        let json = r#"{"version": 6, "modules": [
            {"kind": "retouch", "params": {"spots": [{"shape": "a"}, {"shape": "b"}]}},
            {"kind": "retouch", "label": "skin", "params": {"spots": [{"shape": "c", "mode": "clone"}]}},
            {"kind": "retouch", "enabled": false, "params": {"spots": [{"shape": "d"}]}}
        ], "shapes": {
            "a": {"type": "ellipse", "center": [0.1, 0.1], "radii": [0.01, 0.01]},
            "b": {"type": "ellipse", "center": [0.2, 0.1], "radii": [0.01, 0.01]},
            "c": {"type": "ellipse", "center": [0.3, 0.1], "radii": [0.01, 0.01]},
            "d": {"type": "ellipse", "center": [0.4, 0.1], "radii": [0.01, 0.01]}
        }}"#;
        let params = EditParams::from_json(json).unwrap();
        assert_eq!(params.modules.len(), 3);
        // The disabled instance keeps its shape, but doesn't retouch.
        assert_eq!(params.shapes.len(), 4);
        let shapes: Vec<String> = stamps(&params).into_iter().map(|s| s.spot.shape).collect();
        assert_eq!(shapes, ["a", "b", "c"]);
    }

    #[test]
    fn keys_tell_stamps_apart() {
        let a = [stamp(SpotMode::Heal, [0.1, 0.0])];
        let b = [stamp(SpotMode::Heal, [0.1, 0.01])];
        assert_eq!(key(&[]), 0);
        assert_ne!(key(&a), 0);
        assert_ne!(key(&a), key(&b));
        assert_eq!(key(&a), key(&a.clone()));
    }
}
