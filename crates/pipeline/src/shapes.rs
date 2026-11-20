//! Drawn shapes (roadmap 4.3), shared by retouch spots and, later, masks: defined once
//! in the recipe (`EditParams::shapes`) and referenced by id. darktable calls them
//! "forms".
//!
//! Shapes live in **normalised sensor coordinates**: `(0, 0)` is the top-left corner of
//! the base image (after the raw crop, before lens correction, orientation, straighten
//! and crop) and `(1, 1)` its bottom-right corner. They stay on the image content when the
//! crop, rotation or lens correction changes, and a dust spot is at the same place in
//! every photo of a shoot. Lengths (radii, feather) are fractions of the frame's shorter
//! side, so circles stay round; angles are in radians, clockwise (y points down).
//!
//! A shape rasterises to an alpha mask over its bounding box, 0 … 1: 1 inside, falling
//! smoothly to 0 across the feather, outside the edge, times the shape's opacity. The
//! TypeScript mirror (types, outlines and hit tests for the editor) is
//! `packages/pipeline/src/shapes.ts`.
//!
//! A raster shape ([`Shape::Raster`], roadmap 4.15) is the exception: it isn't drawn but
//! is another instance's mask, as that instance applies it, in the output frame. It has
//! no place on the sensor (no bounds, nothing to rasterise here): masks combine it with
//! their other shapes (`crate::ops::mask`), and retouch spots can't use it.

use serde::{Deserialize, Serialize};

use crate::image::Region;

/// A drawn shape, in normalised sensor coordinates (see the module docs).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Shape {
    /// An ellipse (a circle when both radii are equal).
    Ellipse {
        center: [f32; 2],
        /// Along the ellipse's own axes, before rotation.
        radii: [f32; 2],
        #[serde(default)]
        rotation: f32,
        #[serde(default)]
        feather: f32,
        #[serde(default = "one")]
        opacity: f32,
    },
    /// A linear gradient: 0 behind the line through `anchor`, 1 ahead of it (in the
    /// direction of `angle`), over a transition `feather` wide centred on the line.
    Gradient {
        anchor: [f32; 2],
        #[serde(default)]
        angle: f32,
        #[serde(default)]
        feather: f32,
        #[serde(default = "one")]
        opacity: f32,
    },
    /// A closed path of cubic Bézier segments. Each node is `[x, y, in_x, in_y, out_x,
    /// out_y]`: its position and its two control points (absolute; equal to the
    /// position for a corner).
    Path {
        points: Vec<[f32; 6]>,
        #[serde(default)]
        feather: f32,
        #[serde(default = "one")]
        opacity: f32,
    },
    /// A brush stroke: `[x, y, radius, hardness]` per point, joined by segments whose
    /// radius and hardness are interpolated. Hardness is the solid share of the radius
    /// (1 = a hard edge); it stands in for the other shapes' feather.
    Brush {
        points: Vec<[f32; 4]>,
        #[serde(default = "one")]
        opacity: f32,
    },
    /// The mask of instance `source` as it applies it (after its own invert and
    /// opacity), darktable's raster mask: 0 where the source applies nowhere (disabled,
    /// missing, or not before the mask's instance in the pipeline), 1 everywhere if it
    /// has no mask. Inverted if asked, then times the opacity.
    Raster {
        source: String,
        #[serde(default)]
        invert: bool,
        #[serde(default = "one")]
        opacity: f32,
    },
}

fn one() -> f32 {
    1.0
}

/// A shape's alpha over a region of the frame.
#[derive(Clone, Debug)]
pub struct ShapeMask {
    pub region: Region,
    /// Row-major over `region`, 0 … 1.
    pub alpha: Vec<f32>,
}

impl ShapeMask {
    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.alpha[(y - self.region.y) * self.region.width + (x - self.region.x)]
    }
}

/// Smooth falloff from 1 (`t ≤ 0`) to 0 (`t ≥ 1`).
#[inline]
fn falloff(t: f32) -> f32 {
    if t <= 0.0 {
        1.0
    } else if t >= 1.0 {
        0.0
    } else {
        let s = 1.0 - t;
        s * s * (3.0 - 2.0 * s)
    }
}

/// Pixel-space geometry of a `width × height` frame: positions scale by the frame's
/// size, lengths by its shorter side. Pixel `(i, j)` covers `[i, i+1) × [j, j+1)`.
#[derive(Clone, Copy)]
struct Frame {
    w: f32,
    h: f32,
    unit: f32,
}

impl Frame {
    fn new((w, h): (usize, usize)) -> Self {
        Self { w: w as f32, h: h as f32, unit: w.min(h) as f32 }
    }

    fn point(&self, p: [f32; 2]) -> (f32, f32) {
        (p[0] * self.w, p[1] * self.h)
    }

    /// The pixels touched by `[x0, x1] × [y0, y1]` (pixel coordinates), with a pixel
    /// of margin, clipped to the frame; `None` if that is empty.
    fn region(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> Option<Region> {
        let (fw, fh) = (self.w as i64, self.h as i64);
        let lo = |v: f32, max: i64| ((v.floor() as i64) - 1).clamp(0, max);
        let hi = |v: f32, max: i64| ((v.ceil() as i64) + 1).clamp(0, max);
        if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
            return None;
        }
        let (rx0, rx1, ry0, ry1) = (lo(x0, fw), hi(x1, fw), lo(y0, fh), hi(y1, fh));
        (rx1 > rx0 && ry1 > ry0).then(|| Region { x: rx0 as usize, y: ry0 as usize, width: (rx1 - rx0) as usize, height: (ry1 - ry0) as usize })
    }
}

impl Shape {
    pub fn opacity(&self) -> f32 {
        match self {
            Shape::Ellipse { opacity, .. }
            | Shape::Gradient { opacity, .. }
            | Shape::Path { opacity, .. }
            | Shape::Brush { opacity, .. }
            | Shape::Raster { opacity, .. } => opacity.clamp(0.0, 1.0),
        }
    }

    /// Whether it's another instance's mask rather than drawn (see [`Shape::Raster`]).
    pub fn is_raster(&self) -> bool {
        matches!(self, Shape::Raster { .. })
    }

    /// A raster shape's alpha where its source's mask is `m`.
    #[inline]
    pub fn raster_alpha(invert: bool, opacity: f32, m: f32) -> f32 {
        (if invert { 1.0 - m } else { m }) * opacity.clamp(0.0, 1.0)
    }

    /// The pixels of a `frame`-sized image where the shape's alpha may be non-zero (with a
    /// pixel of margin), or `None` if there are none.
    pub fn bounds(&self, frame: (usize, usize)) -> Option<Region> {
        let f = Frame::new(frame);
        if self.opacity() <= 0.0 {
            return None;
        }
        match self {
            Shape::Ellipse { center, radii, rotation, feather, .. } => {
                let (cx, cy) = f.point(*center);
                let (a, b) = ellipse_radii(&f, *radii, *feather);
                let (s, c) = rotation.sin_cos();
                let hw = ((a * c).powi(2) + (b * s).powi(2)).sqrt();
                let hh = ((a * s).powi(2) + (b * c).powi(2)).sqrt();
                f.region(cx - hw, cy - hh, cx + hw, cy + hh)
            }
            Shape::Gradient { .. } => f.region(0.0, 0.0, f.w, f.h),
            Shape::Path { points, feather, .. } => {
                if points.len() < 3 {
                    return None;
                }
                // A Bézier curve stays inside the hull of its control points.
                let pad = feather.max(0.0) * f.unit;
                let all = points.iter().flat_map(|p| [(p[0], p[1]), (p[2], p[3]), (p[4], p[5])]).map(|(x, y)| f.point([x, y]));
                let (x0, y0, x1, y1) = extent(all);
                f.region(x0 - pad, y0 - pad, x1 + pad, y1 + pad)
            }
            Shape::Brush { points, .. } => {
                let pad = points.iter().map(|p| p[2].max(0.0)).fold(0.0, f32::max) * f.unit;
                if points.is_empty() || pad <= 0.0 {
                    return None;
                }
                let (x0, y0, x1, y1) = extent(points.iter().map(|p| f.point([p[0], p[1]])));
                f.region(x0 - pad, y0 - pad, x1 + pad, y1 + pad)
            }
            Shape::Raster { .. } => None,
        }
    }

    /// The shape's alpha over its [`bounds`](Self::bounds) in a `frame`-sized image.
    pub fn rasterize(&self, frame: (usize, usize)) -> Option<ShapeMask> {
        self.rasterize_in(frame, Region::full(frame.0, frame.1))
    }

    /// [`rasterize`](Self::rasterize), over the part of the bounds within `clip`. Each
    /// pixel gets the same value as in the whole raster.
    pub fn rasterize_in(&self, frame: (usize, usize), clip: Region) -> Option<ShapeMask> {
        let region = self.bounds(frame)?.intersect(&clip)?;
        let f = Frame::new(frame);
        let opacity = self.opacity();
        let mut alpha = vec![0.0f32; region.width * region.height];
        match self {
            Shape::Ellipse { center, radii, rotation, feather, .. } => {
                let (cx, cy) = f.point(*center);
                let (ri, ro) = (ellipse_radii(&f, *radii, 0.0), ellipse_radii(&f, *radii, *feather));
                let (s, c) = rotation.sin_cos();
                for (j, row) in alpha.chunks_exact_mut(region.width).enumerate() {
                    let y = (region.y + j) as f32 + 0.5 - cy;
                    for (i, a) in row.iter_mut().enumerate() {
                        let x = (region.x + i) as f32 + 0.5 - cx;
                        // In the ellipse's own axes.
                        let (u, v) = (x * c + y * s, -x * s + y * c);
                        // Normalised radius of the inner (edge) and outer (feather) ellipses.
                        let ti = ((u / ri.0).powi(2) + (v / ri.1).powi(2)).sqrt();
                        if ti <= 1.0 {
                            *a = opacity;
                            continue;
                        }
                        let to = ((u / ro.0).powi(2) + (v / ro.1).powi(2)).sqrt();
                        if to >= 1.0 || ro == ri {
                            continue;
                        }
                        // Where the point lies along its ray, from the edge (0) to the
                        // feather's end (1): the ray meets them at |p|/ti and |p|/to.
                        let t = (1.0 - 1.0 / ti) / (1.0 / to - 1.0 / ti);
                        *a = opacity * falloff(t);
                    }
                }
            }
            Shape::Gradient { anchor, angle, feather, .. } => {
                let (ax, ay) = f.point(*anchor);
                let (s, c) = angle.sin_cos();
                let half = (0.5 * feather.max(0.0) * f.unit).max(1e-3);
                for (j, row) in alpha.chunks_exact_mut(region.width).enumerate() {
                    let y = (region.y + j) as f32 + 0.5 - ay;
                    for (i, a) in row.iter_mut().enumerate() {
                        let x = (region.x + i) as f32 + 0.5 - ax;
                        let d = x * c + y * s;
                        *a = opacity * (1.0 - falloff((d + half) / (2.0 * half)));
                    }
                }
            }
            Shape::Path { points, feather, .. } => {
                let poly = flatten(&f, points);
                fill_polygon(&poly, region, &mut alpha);
                let band = feather.max(0.0) * f.unit;
                if band > 0.0 {
                    feather_outside(&poly, region, band, &mut alpha);
                }
                if opacity < 1.0 {
                    alpha.iter_mut().for_each(|a| *a *= opacity);
                }
            }
            Shape::Brush { points, .. } => {
                let pts: Vec<(f32, f32, f32, f32)> = points
                    .iter()
                    .map(|p| {
                        let (x, y) = f.point([p[0], p[1]]);
                        (x, y, (p[2] * f.unit).max(0.0), p[3].clamp(0.0, 1.0))
                    })
                    .collect();
                if pts.len() == 1 {
                    stroke_segment(pts[0], pts[0], region, &mut alpha);
                }
                for w in pts.windows(2) {
                    stroke_segment(w[0], w[1], region, &mut alpha);
                }
                if opacity < 1.0 {
                    alpha.iter_mut().for_each(|a| *a *= opacity);
                }
            }
            Shape::Raster { .. } => unreachable!("raster shapes have no bounds"),
        }
        Some(ShapeMask { region, alpha })
    }

    /// The shape moved by `(dx, dy)` (normalised sensor coordinates).
    pub fn translated(&self, dx: f32, dy: f32) -> Shape {
        let mut s = self.clone();
        match &mut s {
            Shape::Ellipse { center, .. } => *center = [center[0] + dx, center[1] + dy],
            Shape::Gradient { anchor, .. } => *anchor = [anchor[0] + dx, anchor[1] + dy],
            Shape::Path { points, .. } => {
                for p in points {
                    for k in 0..3 {
                        p[2 * k] += dx;
                        p[2 * k + 1] += dy;
                    }
                }
            }
            Shape::Brush { points, .. } => {
                for p in points {
                    p[0] += dx;
                    p[1] += dy;
                }
            }
            Shape::Raster { .. } => {}
        }
        s
    }
}

/// Pixel radii of an ellipse grown by `feather`. Never zero, so that divisions stay finite.
fn ellipse_radii(f: &Frame, radii: [f32; 2], feather: f32) -> (f32, f32) {
    let grow = feather.max(0.0) * f.unit;
    ((radii[0].abs() * f.unit + grow).max(1e-3), (radii[1].abs() * f.unit + grow).max(1e-3))
}

fn extent(points: impl Iterator<Item = (f32, f32)>) -> (f32, f32, f32, f32) {
    points.fold((f32::MAX, f32::MAX, f32::MIN, f32::MIN), |(x0, y0, x1, y1), (x, y)| (x0.min(x), y0.min(y), x1.max(x), y1.max(y)))
}

/// A closed path's outline as a polygon in pixel coordinates (the last point joins the first).
fn flatten(f: &Frame, nodes: &[[f32; 6]]) -> Vec<(f32, f32)> {
    let mut poly = Vec::new();
    for (i, a) in nodes.iter().enumerate() {
        let b = &nodes[(i + 1) % nodes.len()];
        let p0 = f.point([a[0], a[1]]);
        let p1 = f.point([a[4], a[5]]);
        let p2 = f.point([b[2], b[3]]);
        let p3 = f.point([b[0], b[1]]);
        // About one step per 2 pixels of control polygon.
        let len = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
        let steps = ((len / 2.0).ceil() as usize).clamp(1, 256);
        for s in 0..steps {
            let t = s as f32 / steps as f32;
            let u = 1.0 - t;
            let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            poly.push((w0 * p0.0 + w1 * p1.0 + w2 * p2.0 + w3 * p3.0, w0 * p0.1 + w1 * p1.1 + w2 * p2.1 + w3 * p3.1));
        }
    }
    poly
}

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// Set `alpha` to 1 at the pixel centres of `region` inside `poly` (even-odd rule).
fn fill_polygon(poly: &[(f32, f32)], region: Region, alpha: &mut [f32]) {
    let mut xs = Vec::new();
    for j in 0..region.height {
        let y = (region.y + j) as f32 + 0.5;
        xs.clear();
        for (i, &a) in poly.iter().enumerate() {
            let b = poly[(i + 1) % poly.len()];
            if (a.1 <= y) != (b.1 <= y) {
                xs.push(a.0 + (y - a.1) / (b.1 - a.1) * (b.0 - a.0));
            }
        }
        xs.sort_by(f32::total_cmp);
        let row = &mut alpha[j * region.width..(j + 1) * region.width];
        for pair in xs.chunks_exact(2) {
            // Pixel centres x + 0.5 within [pair[0], pair[1]).
            let start = ((pair[0] - 0.5).ceil() as i64 - region.x as i64).clamp(0, region.width as i64) as usize;
            let end = ((pair[1] - 0.5).ceil() as i64 - region.x as i64).clamp(0, region.width as i64) as usize;
            row[start..end.max(start)].fill(1.0);
        }
    }
}

/// Distance from a point to the segment `a`–`b`, and where along it the closest point is (0 … 1).
#[inline]
fn segment_distance(px: f32, py: f32, a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((px - a.0) * dx + (py - a.1) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    ((px - a.0 - t * dx).hypot(py - a.1 - t * dy), t)
}

/// Fade the pixels outside the polygon with their distance to it, over `band` pixels.
/// Only the pixels near each edge are visited.
fn feather_outside(poly: &[(f32, f32)], region: Region, band: f32, alpha: &mut [f32]) {
    let mut nearest = vec![f32::MAX; alpha.len()];
    for (i, &a) in poly.iter().enumerate() {
        let b = poly[(i + 1) % poly.len()];
        visit(region, a.0.min(b.0) - band, a.1.min(b.1) - band, a.0.max(b.0) + band, a.1.max(b.1) + band, |k, x, y| {
            let (d, _) = segment_distance(x, y, a, b);
            if d < nearest[k] {
                nearest[k] = d;
            }
        });
    }
    for (a, d) in alpha.iter_mut().zip(nearest) {
        if *a == 0.0 && d < band {
            *a = falloff(d / band);
        }
    }
}

/// One segment of a brush stroke, merged into `alpha` by maximum. Each end is `(x, y,
/// radius, hardness)` in pixels.
fn stroke_segment(a: (f32, f32, f32, f32), b: (f32, f32, f32, f32), region: Region, alpha: &mut [f32]) {
    let r = a.2.max(b.2);
    let (pa, pb) = ((a.0, a.1), (b.0, b.1));
    visit(region, a.0.min(b.0) - r, a.1.min(b.1) - r, a.0.max(b.0) + r, a.1.max(b.1) + r, |k, x, y| {
        let (d, t) = segment_distance(x, y, pa, pb);
        let radius = a.2 + (b.2 - a.2) * t;
        if d >= radius {
            return;
        }
        let inner = radius * (a.3 + (b.3 - a.3) * t);
        let v = if radius > inner { falloff((d - inner) / (radius - inner)) } else { 1.0 };
        if v > alpha[k] {
            alpha[k] = v;
        }
    });
}

/// Call `f(index, x, y)` for the pixel centres of `region` within `[x0, x1] × [y0, y1]`.
fn visit(region: Region, x0: f32, y0: f32, x1: f32, y1: f32, mut f: impl FnMut(usize, f32, f32)) {
    let span = |lo: f32, hi: f32, start: usize, len: usize| {
        let a = ((lo - 0.5).floor().max(start as f32) as usize).min(start + len);
        let b = ((hi - 0.5).ceil().max(0.0) as usize + 1).clamp(a, start + len);
        (a, b)
    };
    let (i0, i1) = span(x0, x1, region.x, region.width);
    let (j0, j1) = span(y0, y1, region.y, region.height);
    for j in j0..j1 {
        let y = j as f32 + 0.5;
        for i in i0..i1 {
            f((j - region.y) * region.width + (i - region.x), i as f32 + 0.5, y);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: (usize, usize) = (200, 100);

    fn circle(x: f32, y: f32, r: f32, feather: f32) -> Shape {
        Shape::Ellipse { center: [x, y], radii: [r, r], rotation: 0.0, feather, opacity: 1.0 }
    }

    fn alpha_at(s: &Shape, x: usize, y: usize) -> f32 {
        let m = s.rasterize(FRAME).unwrap();
        let r = m.region;
        if x < r.x || y < r.y || x >= r.right() || y >= r.bottom() { 0.0 } else { m.at(x, y) }
    }

    #[test]
    fn circles_are_round_in_pixels() {
        // Radius 0.1 of the short side (100 px) = 10 px, centred at (100, 50).
        let s = circle(0.5, 0.5, 0.1, 0.0);
        assert_eq!(alpha_at(&s, 100, 50), 1.0);
        assert_eq!(alpha_at(&s, 108, 50), 1.0);
        assert_eq!(alpha_at(&s, 100, 58), 1.0);
        assert_eq!(alpha_at(&s, 111, 50), 0.0);
        assert_eq!(alpha_at(&s, 100, 61), 0.0);
        let r = s.bounds(FRAME).unwrap();
        assert!(r.x <= 89 && r.right() >= 111 && r.y <= 39 && r.bottom() >= 61, "{r:?}");
        assert!(r.width <= 24 && r.height <= 24, "{r:?}");
    }

    #[test]
    fn feather_falls_off_outside_the_edge() {
        let s = circle(0.5, 0.5, 0.1, 0.1);
        let along: Vec<f32> = (100..122).map(|x| alpha_at(&s, x, 50)).collect();
        assert!(along.windows(2).all(|w| w[1] <= w[0]), "{along:?}");
        assert_eq!(along[9], 1.0); // inside the edge
        assert!(along[15] > 0.2 && along[15] < 0.8, "{along:?}");
        assert_eq!(alpha_at(&s, 121, 50), 0.0);
    }

    #[test]
    fn rotated_ellipse() {
        // 20 × 5 px half-axes, turned a quarter: tall and thin.
        let s = Shape::Ellipse { center: [0.5, 0.5], radii: [0.2, 0.05], rotation: std::f32::consts::FRAC_PI_2, feather: 0.0, opacity: 0.5 };
        assert_eq!(alpha_at(&s, 100, 65), 0.5);
        assert_eq!(alpha_at(&s, 110, 50), 0.0);
        let r = s.bounds(FRAME).unwrap();
        assert!(r.width < 16 && r.height > 40, "{r:?}");
    }

    #[test]
    fn gradient_goes_from_0_to_1_across_the_line() {
        // Pointing right (angle 0) through x = 100, 20 px transition.
        let s = Shape::Gradient { anchor: [0.5, 0.5], angle: 0.0, feather: 0.2, opacity: 1.0 };
        assert_eq!(alpha_at(&s, 80, 10), 0.0);
        assert!((alpha_at(&s, 100, 90) - 0.5).abs() < 0.1);
        assert_eq!(alpha_at(&s, 120, 50), 1.0);
        assert_eq!(s.bounds(FRAME), Some(Region::full(200, 100)));
    }

    #[test]
    fn path_fills_its_inside_and_feathers_out() {
        // A square of corners (60, 20) … (100, 60).
        let corner = |x: f32, y: f32| [x / 200.0, y / 100.0, x / 200.0, y / 100.0, x / 200.0, y / 100.0];
        let points = vec![corner(60.0, 20.0), corner(100.0, 20.0), corner(100.0, 60.0), corner(60.0, 60.0)];
        let s = Shape::Path { points: points.clone(), feather: 0.0, opacity: 1.0 };
        assert_eq!(alpha_at(&s, 80, 40), 1.0);
        assert_eq!(alpha_at(&s, 60, 20), 1.0);
        assert_eq!(alpha_at(&s, 100, 40), 0.0);
        assert_eq!(alpha_at(&s, 59, 40), 0.0);
        let feathered = Shape::Path { points, feather: 0.1, opacity: 1.0 };
        let a = alpha_at(&feathered, 105, 40);
        assert!(a > 0.2 && a < 0.8, "{a}");
        assert_eq!(alpha_at(&feathered, 111, 40), 0.0);
    }

    #[test]
    fn bezier_handles_bulge_the_path() {
        // A triangle whose first edge (top) is pulled up by its handles.
        let p = |x: f32, y: f32| [x / 200.0, y / 100.0];
        let node = |at: [f32; 2], inn: [f32; 2], out: [f32; 2]| [at[0], at[1], inn[0], inn[1], out[0], out[1]];
        let points = vec![
            node(p(60.0, 50.0), p(60.0, 50.0), p(70.0, 10.0)),
            node(p(140.0, 50.0), p(130.0, 10.0), p(140.0, 50.0)),
            node(p(100.0, 90.0), p(100.0, 90.0), p(100.0, 90.0)),
        ];
        let s = Shape::Path { points, feather: 0.0, opacity: 1.0 };
        assert_eq!(alpha_at(&s, 100, 30), 1.0); // above the straight edge, below the curve
        assert_eq!(alpha_at(&s, 100, 15), 0.0);
    }

    #[test]
    fn brush_strokes_have_hard_cores() {
        // A horizontal stroke at y = 50 from x = 40 to 160, 10 px radius, half hard.
        let s = Shape::Brush { points: vec![[0.2, 0.5, 0.1, 0.5], [0.8, 0.5, 0.1, 0.5]], opacity: 1.0 };
        assert_eq!(alpha_at(&s, 100, 50), 1.0);
        assert_eq!(alpha_at(&s, 100, 54), 1.0);
        let edge = alpha_at(&s, 100, 57);
        assert!(edge > 0.0 && edge < 1.0, "{edge}");
        assert_eq!(alpha_at(&s, 100, 61), 0.0);
        assert_eq!(alpha_at(&s, 28, 50), 0.0); // past the round cap
        // A single point is a dot.
        let dot = Shape::Brush { points: vec![[0.5, 0.5, 0.05, 1.0]], opacity: 1.0 };
        assert_eq!(alpha_at(&dot, 100, 50), 1.0);
        assert_eq!(alpha_at(&dot, 106, 50), 0.0);
    }

    #[test]
    fn shapes_outside_the_frame_have_no_bounds() {
        assert_eq!(circle(2.0, 2.0, 0.1, 0.0).bounds(FRAME), None);
        let clipped = circle(0.0, 0.0, 0.1, 0.0).bounds(FRAME).unwrap();
        assert_eq!((clipped.x, clipped.y), (0, 0));
        let invisible = Shape::Ellipse { center: [0.5, 0.5], radii: [0.1, 0.1], rotation: 0.0, feather: 0.0, opacity: 0.0 };
        assert_eq!(invisible.bounds(FRAME), None);
    }

    #[test]
    fn serialises_with_a_type_tag() {
        let json = r#"{"type":"ellipse","center":[0.4,0.3],"radii":[0.05,0.05]}"#;
        let s: Shape = serde_json::from_str(json).unwrap();
        assert_eq!(s, Shape::Ellipse { center: [0.4, 0.3], radii: [0.05, 0.05], rotation: 0.0, feather: 0.0, opacity: 1.0 });
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["type"], "ellipse");
        assert_eq!(back["opacity"], 1.0);
        let raster: Shape = serde_json::from_str(r#"{"type":"raster","source":"exposure"}"#).unwrap();
        assert_eq!(raster, Shape::Raster { source: "exposure".into(), invert: false, opacity: 1.0 });
        assert_eq!(raster.bounds(FRAME), None);
    }
}
