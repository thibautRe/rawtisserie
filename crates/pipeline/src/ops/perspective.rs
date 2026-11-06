//! Perspective correction: a camera rotation (roll, tilt, pan) followed by a shear
//! and a stretch, as a homography of the oriented, lens-corrected frame; the framing
//! that hides the empty borders it leaves; and fitting it to guide lines that should
//! be vertical or horizontal.
//!
//! The model follows the idea of darktable's `ashift.c` (the lines' vanishing points
//! are sent to infinity), but as a rotation of a pinhole camera: with the right focal
//! length, the corrected image has the proportions of a picture taken with a level
//! camera. Files don't record the sensor size, so the focal length is read as a
//! full-frame one; `aspect` compensates when that's off.
//!
//! Coordinates are full-resolution pixels of the oriented frame, centred (y down).
//! The roll is [`crate::params::Geometry::angle`] (clockwise positive).

use crate::params::{AutoCrop, Geometry};

pub type Mat3 = [[f64; 3]; 3];

/// Largest tilt and pan, degrees.
pub const MAX_ROTATION: f32 = 40.0;
pub const MAX_SHEAR: f32 = 0.5;
pub const MAX_ASPECT: f32 = 1.0;

/// The correction's parameters (sanitised), and the focal length it uses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Perspective {
    /// Tilt, degrees: positive for a camera that pointed up.
    pub vertical: f32,
    /// Pan, degrees: positive for a camera that pointed left.
    pub horizontal: f32,
    pub shear: f32,
    pub aspect: f32,
    /// Focal length, as a multiple of the frame's long side: the warp is built at
    /// whatever resolution the frame is (the full sensor, a binned base), and must
    /// bend the same at each.
    pub focal: f32,
}

impl Perspective {
    pub fn new(g: &Geometry, focal: f32) -> Self {
        let finite = |v: f32, max: f32| if v.is_finite() { v.clamp(-max, max) } else { 0.0 };
        Self {
            vertical: finite(g.vertical, MAX_ROTATION),
            horizontal: finite(g.horizontal, MAX_ROTATION),
            shear: finite(g.shear, MAX_SHEAR),
            aspect: finite(g.aspect, MAX_ASPECT),
            focal,
        }
    }

    /// No correction (whatever the focal length).
    pub fn is_identity(&self) -> bool {
        self.vertical == 0.0 && self.horizontal == 0.0 && self.shear == 0.0 && self.aspect == 0.0
    }

    /// The forward warp, oriented frame → corrected frame (both centred), with the roll
    /// `angle` (degrees, clockwise) undone first. Tilt and pan are reduced if they would
    /// turn a corner of the `ow × oh` frame behind the camera.
    pub fn warp(&self, angle: f32, ow: f64, oh: f64) -> Mat3 {
        let f = (self.focal as f64 * ow.max(oh)).max(1.0);
        let roll = rot_z((angle as f64).to_radians());
        let (mut t, mut h) = ((self.vertical as f64).to_radians(), (self.horizontal as f64).to_radians());
        // Each corner's depth after the rotation, relative to its distance: well in front.
        let in_front = |t: f64, h: f64| {
            let r = mul(&mul(&rot_x(t), &rot_y(h)), &roll);
            corners(ow, oh).iter().all(|&(x, y)| {
                let d = [x / f, y / f, 1.0];
                let z = r[2][0] * d[0] + r[2][1] * d[1] + r[2][2];
                z > 0.15 * (d[0] * d[0] + d[1] * d[1] + 1.0).sqrt()
            })
        };
        for _ in 0..40 {
            if in_front(t, h) {
                break;
            }
            (t, h) = (t * 0.9, h * 0.9);
        }
        let rotation = mul(&mul(&rot_x(t), &rot_y(h)), &roll);
        let k = [[f, 0.0, 0.0], [0.0, f, 0.0], [0.0, 0.0, 1.0]];
        let k_inv = [[1.0 / f, 0.0, 0.0], [0.0, 1.0 / f, 0.0], [0.0, 0.0, 1.0]];
        let shear = [[1.0, 0.0, 0.0], [self.shear as f64, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let a = 2f64.powf(self.aspect as f64 / 2.0);
        let stretch = [[a, 0.0, 0.0], [0.0, 1.0 / a, 0.0], [0.0, 0.0, 1.0]];
        mul(&mul(&mul(&stretch, &shear), &mul(&k, &rotation)), &k_inv)
    }
}

/// The corrected image's framing: what of the corrected frame (centred pixels) the
/// output shows, and the output frame's size in (full-resolution) pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Framing {
    /// Top-left corner and size of the shown rectangle, corrected frame.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Size of the output frame (before the crop).
    pub frame: (f64, f64),
}

/// How `warp` frames an `ow × oh` oriented frame, by `mode`.
pub fn framing(warp: &Mat3, ow: f64, oh: f64, mode: AutoCrop) -> Framing {
    let quad = corners(ow, oh).map(|(x, y)| apply(warp, x, y));
    // The frame keeps the oriented frame's number of pixels.
    let sized = |x: f64, y: f64, width: f64, height: f64| {
        let k = (ow * oh / (width * height)).sqrt();
        Framing { x, y, width, height, frame: (width * k, height * k) }
    };
    match mode {
        AutoCrop::Off => {
            let (x0, x1) = quad.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p.0), hi.max(p.0)));
            let (y0, y1) = quad.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p.1), hi.max(p.1)));
            sized(x0, y0, x1 - x0, y1 - y0)
        }
        AutoCrop::Aspect => {
            let (cx, cy, s) = inscribed(&quad, ow / 2.0, oh / 2.0);
            Framing { x: cx - s * ow / 2.0, y: cy - s * oh / 2.0, width: s * ow, height: s * oh, frame: (ow, oh) }
        }
        AutoCrop::Area => {
            // Area against the log of the aspect: a coarse scan, then a golden-section search.
            let area = |l: f64| {
                let (a, b) = ((l / 2.0).exp(), (-l / 2.0).exp());
                let (cx, cy, s) = inscribed(&quad, a, b);
                (s * s * a * b, (cx, cy, s * a, s * b))
            };
            const RANGE: f64 = 3.0;
            const STEPS: usize = 48;
            let step = 2.0 * RANGE / STEPS as f64;
            let best = (0..=STEPS).map(|i| -RANGE + i as f64 * step).max_by(|a, b| area(*a).0.total_cmp(&area(*b).0)).unwrap_or(0.0);
            let (mut lo, mut hi) = (best - step, best + step);
            let g = (5f64.sqrt() - 1.0) / 2.0;
            for _ in 0..40 {
                let (m1, m2) = (hi - g * (hi - lo), lo + g * (hi - lo));
                if area(m1).0 < area(m2).0 { lo = m1 } else { hi = m2 }
            }
            let (_, (cx, cy, a, b)) = area((lo + hi) / 2.0);
            sized(cx - a, cy - b, 2.0 * a, 2.0 * b)
        }
    }
}

/// The largest rectangle with half sides `(s·a, s·b)` inside the convex `quad` (in
/// order around it): `(centre x, centre y, s)`. A linear program in three unknowns
/// over four constraints: the best of the vertices where three of them meet.
fn inscribed(quad: &[(f64, f64); 4], a: f64, b: f64) -> (f64, f64, f64) {
    let (mx, my) = (quad.iter().map(|p| p.0).sum::<f64>() / 4.0, quad.iter().map(|p| p.1).sum::<f64>() / 4.0);
    // Each edge as nx·cx + ny·cy - k·s ≥ c, the rectangle's worst corner inside.
    let rows: Vec<[f64; 4]> = (0..4)
        .map(|i| {
            let (p, q) = (quad[i], quad[(i + 1) % 4]);
            let (mut nx, mut ny) = (p.1 - q.1, q.0 - p.0);
            if nx * (mx - p.0) + ny * (my - p.1) < 0.0 {
                (nx, ny) = (-nx, -ny);
            }
            let len = nx.hypot(ny).max(1e-12);
            let (nx, ny) = (nx / len, ny / len);
            [nx, ny, -(nx.abs() * a + ny.abs() * b), nx * p.0 + ny * p.1]
        })
        .collect();
    let mut best = (mx, my, 0.0);
    for skip in 0..4 {
        let eq: Vec<&[f64; 4]> = rows.iter().enumerate().filter(|(i, _)| *i != skip).map(|(_, r)| r).collect();
        let m = [[eq[0][0], eq[0][1], eq[0][2]], [eq[1][0], eq[1][1], eq[1][2]], [eq[2][0], eq[2][1], eq[2][2]]];
        let Some(inv) = invert(&m) else { continue };
        let rhs = [eq[0][3], eq[1][3], eq[2][3]];
        let v = [0, 1, 2].map(|i| inv[i][0] * rhs[0] + inv[i][1] * rhs[1] + inv[i][2] * rhs[2]);
        let tolerance = 1e-9 * (a + b).max(1.0) * 10.0;
        let feasible = rows.iter().all(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2] >= r[3] - tolerance);
        if feasible && v[2] > best.2 {
            best = (v[0], v[1], v[2]);
        }
    }
    // The largest size may leave the centre free along a segment (a straightened frame
    // touches only two sides): take its middle, the middle of where pairs of
    // constraints meet at that size.
    let s = best.2 * (1.0 - 1e-9);
    let mut lo = (f64::MAX, f64::MAX);
    let mut hi = (f64::MIN, f64::MIN);
    for i in 0..4 {
        for j in i + 1..4 {
            let (p, q) = (&rows[i], &rows[j]);
            let det = p[0] * q[1] - p[1] * q[0];
            if det.abs() < 1e-9 {
                continue;
            }
            let (ci, cj) = (p[3] - p[2] * s, q[3] - q[2] * s);
            let (x, y) = ((ci * q[1] - cj * p[1]) / det, (p[0] * cj - q[0] * ci) / det);
            let tolerance = 1e-9 * (a + b).max(1.0);
            if rows.iter().all(|r| r[0] * x + r[1] * y + r[2] * s >= r[3] - tolerance) {
                lo = (lo.0.min(x), lo.1.min(y));
                hi = (hi.0.max(x), hi.1.max(y));
            }
        }
    }
    if lo.0 <= hi.0 {
        best = ((lo.0 + hi.0) / 2.0, (lo.1 + hi.1) / 2.0, best.2);
    }
    best
}

/// The frame's corners, centred, in order around it.
fn corners(ow: f64, oh: f64) -> [(f64, f64); 4] {
    let (x, y) = (ow / 2.0, oh / 2.0);
    [(-x, -y), (x, -y), (x, y), (-x, y)]
}

pub fn apply(m: &Mat3, x: f64, y: f64) -> (f64, f64) {
    let w = m[2][0] * x + m[2][1] * y + m[2][2];
    ((m[0][0] * x + m[0][1] * y + m[0][2]) / w, (m[1][0] * x + m[1][1] * y + m[1][2]) / w)
}

pub fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

pub fn invert(m: &Mat3) -> Option<Mat3> {
    let c = |i: usize, j: usize| m[(i + 1) % 3][(j + 1) % 3] * m[(i + 2) % 3][(j + 2) % 3] - m[(i + 1) % 3][(j + 2) % 3] * m[(i + 2) % 3][(j + 1) % 3];
    let det = m[0][0] * c(0, 0) + m[0][1] * c(0, 1) + m[0][2] * c(0, 2);
    let scale = m.iter().flatten().fold(0.0f64, |a, v| a.max(v.abs()));
    if !det.is_finite() || det.abs() <= 1e-12 * scale.powi(3) {
        return None;
    }
    // The adjugate is the transposed cofactor matrix.
    Some([0, 1, 2].map(|i| [0, 1, 2].map(|j| c(j, i) / det)))
}

/// Rotation about the optical axis: clockwise on screen (y points down).
fn rot_z(r: f64) -> Mat3 {
    let (s, c) = r.sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// Rotation about the horizontal axis that levels a camera tilted up by `t`.
fn rot_x(t: f64) -> Mat3 {
    let (s, c) = t.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

/// Rotation about the vertical axis that undoes a pan to the left by `h`.
fn rot_y(h: f64) -> Mat3 {
    let (s, c) = h.sin_cos();
    [[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]]
}

// ---------------------------------------------------------------------------------
// Fitting

/// A guide line, oriented frame (centred pixels), and what it should become.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Guide {
    pub a: (f64, f64),
    pub b: (f64, f64),
    pub vertical: bool,
}

/// Which lines a fit straightens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    Vertical,
    Horizontal,
    Both,
}

/// The parameters a fit sets: roll (`angle`), tilt, pan and shear, as in [`Geometry`].
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub angle: f32,
    pub vertical: f32,
    pub horizontal: f32,
    pub shear: f32,
}

/// Fit the correction so that the vertical guides become vertical and/or the horizontal
/// ones horizontal, for a camera of focal length `focal` (pixels). Two lines or more
/// of a kind set the rotation that sends their vanishing point to infinity; a single
/// one only sets the roll. `None` without any line of the kinds `mode` uses.
///
/// Vertical (horizontal) alone leaves the pan (tilt) and the shear at 0. Both aligns
/// the verticals exactly and the horizontals' vanishing point at infinity, then
/// shears them level (they needn't be square to the verticals: the focal length may
/// be off, or the walls not at right angles).
pub fn fit(guides: &[Guide], mode: FitMode, focal: f64) -> Option<Fit> {
    let pick = |vertical: bool| -> Vec<Guide> { guides.iter().copied().filter(|g| g.vertical == vertical).collect() };
    let (verticals, horizontals) = (pick(true), pick(false));
    let v = (mode != FitMode::Horizontal).then(|| vanishing(&verticals, focal)).flatten();
    let h = (mode != FitMode::Vertical).then(|| vanishing(&horizontals, focal)).flatten();
    let deg = |r: f64| r.to_degrees() as f32;
    let fit = |angle: f64, vertical: f64, horizontal: f64, shear: f64| Fit {
        angle: deg(angle).clamp(-45.0, 45.0),
        vertical: deg(vertical).clamp(-MAX_ROTATION, MAX_ROTATION),
        horizontal: deg(horizontal).clamp(-MAX_ROTATION, MAX_ROTATION),
        shear: (shear as f32).clamp(-MAX_SHEAR, MAX_SHEAR),
    };
    match (v, h) {
        (Some(v), Some(h)) if mode == FitMode::Both => {
            let r1 = if v[1] < 0.0 { neg(v) } else { v };
            let r2 = cross(v, h);
            let n = norm(r2);
            if n < 1e-6 {
                return fit_vertical(v).map(|(r, t)| fit(r, t, 0.0, 0.0));
            }
            let r2 = scale(r2, if r2[2] < 0.0 { -1.0 / n } else { 1.0 / n });
            let r0 = cross(r1, r2);
            // R = [r0; r1; r2] (rows) = rot_x(tilt)·rot_y(pan)·rot_z(roll).
            let roll = (-r0[1]).atan2(r0[0]);
            let pan = (-r0[2]).clamp(-1.0, 1.0).asin();
            let tilt = (-r1[2]).atan2(r2[2]);
            // Where the horizontals point after the rotation (z = 0), sheared level.
            let (hx, hy) = (dot(r0, h), dot(r1, h));
            let shear = if hx.abs() > 1e-9 { -hy / hx } else { 0.0 };
            Some(fit(roll, tilt, pan, shear))
        }
        (Some(v), _) if mode != FitMode::Horizontal => fit_vertical(v).map(|(r, t)| fit(r, t, 0.0, 0.0)),
        (_, Some(h)) if mode != FitMode::Vertical => fit_horizontal(h).map(|(r, p)| fit(r, 0.0, p, 0.0)),
        _ => {
            // A single line of a kind: level it with the roll alone.
            let single = |gs: &[Guide], vertical: bool| {
                let g = gs.iter().max_by(|a, b| length(a).total_cmp(&length(b)))?;
                let (dx, dy) = (g.b.0 - g.a.0, g.b.1 - g.a.1);
                Some(if vertical { (dx / dy).atan() } else { (-dy / dx).atan() })
            };
            let roll = match mode {
                FitMode::Vertical => single(&verticals, true),
                FitMode::Horizontal => single(&horizontals, false),
                FitMode::Both => single(&verticals, true).or_else(|| single(&horizontals, false)),
            }?;
            Some(fit(roll, 0.0, 0.0, 0.0))
        }
    }
}

/// Roll and tilt that send direction `v` straight up or down.
fn fit_vertical(v: [f64; 3]) -> Option<(f64, f64)> {
    if v[1].abs() < 1e-12 {
        return None;
    }
    let roll = (v[0] / v[1]).atan();
    let y = roll.sin() * v[0] + roll.cos() * v[1];
    Some((roll, (-v[2] / y).atan()))
}

/// Roll and pan that send direction `h` straight left or right.
fn fit_horizontal(h: [f64; 3]) -> Option<(f64, f64)> {
    if h[0].abs() < 1e-12 {
        return None;
    }
    let roll = (-h[1] / h[0]).atan();
    let x = roll.cos() * h[0] - roll.sin() * h[1];
    Some((roll, (-h[2] / x).atan()))
}

/// The common direction (camera coordinates, unit) of two lines or more: each line and
/// the camera centre span a plane, and the vanishing direction is the one closest to
/// all of them (weighted by length), the smallest eigenvector of `Σ w·n·nᵀ`.
fn vanishing(guides: &[Guide], focal: f64) -> Option<[f64; 3]> {
    if guides.len() < 2 {
        return None;
    }
    let mut m = [[0.0; 3]; 3];
    for g in guides {
        let n = plane(g, focal)?;
        let w = length(g);
        for i in 0..3 {
            for j in 0..3 {
                m[i][j] += w * n[i] * n[j];
            }
        }
    }
    let (values, vectors) = eigen_symmetric(m);
    let i = (0..3).min_by(|&a, &b| values[a].total_cmp(&values[b]))?;
    // Lines all along one direction leave two eigenvalues near 0: no single point.
    let mut sorted = values;
    sorted.sort_by(f64::total_cmp);
    if sorted[1] <= 1e-9 * sorted[2].max(1e-30) {
        return None;
    }
    Some([vectors[0][i], vectors[1][i], vectors[2][i]])
}

/// Unit normal of the plane through the camera centre and the line.
fn plane(g: &Guide, focal: f64) -> Option<[f64; 3]> {
    let n = cross([g.a.0 / focal, g.a.1 / focal, 1.0], [g.b.0 / focal, g.b.1 / focal, 1.0]);
    let len = norm(n);
    (len > 1e-12).then(|| scale(n, 1.0 / len))
}

fn length(g: &Guide) -> f64 {
    (g.b.0 - g.a.0).hypot(g.b.1 - g.a.1)
}

/// Eigenvalues and eigenvectors (as columns) of a symmetric matrix, by Jacobi rotations.
fn eigen_symmetric(mut a: Mat3) -> ([f64; 3], Mat3) {
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..50 {
        let (p, q) = [(0, 1), (0, 2), (1, 2)].into_iter().max_by(|x, y| a[x.0][x.1].abs().total_cmp(&a[y.0][y.1].abs())).unwrap();
        if a[p][q].abs() < 1e-18 {
            break;
        }
        let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
        let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
        let t = if theta == 0.0 { 1.0 } else { t };
        let (c, s) = (1.0 / (t * t + 1.0).sqrt(), t / (t * t + 1.0).sqrt());
        let mut j = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        j[p][p] = c;
        j[q][q] = c;
        j[p][q] = s;
        j[q][p] = -s;
        let jt = transpose(&j);
        a = mul(&mul(&jt, &a), &j);
        v = mul(&v, &j);
    }
    ([a[0][0], a[1][1], a[2][2]], v)
}

fn transpose(m: &Mat3) -> Mat3 {
    [0, 1, 2].map(|i| [0, 1, 2].map(|j| m[j][i]))
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn scale(a: [f64; 3], k: f64) -> [f64; 3] {
    a.map(|v| v * k)
}

fn neg(a: [f64; 3]) -> [f64; 3] {
    scale(a, -1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: f64 = 6000.0;
    const H: f64 = 4000.0;
    const F: f64 = 4000.0;

    fn perspective(vertical: f32, horizontal: f32, shear: f32) -> Perspective {
        Perspective { vertical, horizontal, shear, aspect: 0.0, focal: (F / W) as f32 }
    }

    /// The image of 3D line `p + s·d` (camera coordinates) through a camera rotated by `r`.
    fn project(r: &Mat3, p: [f64; 3], d: [f64; 3], s: f64) -> (f64, f64) {
        let q = [p[0] + s * d[0], p[1] + s * d[1], p[2] + s * d[2]];
        let q = [0, 1, 2].map(|i| r[i][0] * q[0] + r[i][1] * q[1] + r[i][2] * q[2]);
        (F * q[0] / q[2], F * q[1] / q[2])
    }

    fn guide(r: &Mat3, p: [f64; 3], d: [f64; 3], vertical: bool) -> Guide {
        Guide { a: project(r, p, d, -1.0), b: project(r, p, d, 1.0), vertical }
    }

    /// A box-like scene's vertical and horizontal edges (one facade), seen by a camera
    /// whose world → camera rotation is `r`.
    fn scene(r: &Mat3) -> Vec<Guide> {
        let up = [0.0, 1.0, 0.0];
        let across = [1.0, 0.0, 0.0];
        let mut out = Vec::new();
        for x in [-3.0, -1.0, 2.0] {
            out.push(guide(r, [x, 0.0, 10.0], up, true));
        }
        for y in [-2.0, 0.5, 1.5] {
            out.push(guide(r, [0.0, y, 10.0], across, false));
        }
        out
    }

    fn angle_off(g: &Guide, warp: &Mat3) -> f64 {
        let (a, b) = (apply(warp, g.a.0, g.a.1), apply(warp, g.b.0, g.b.1));
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        if g.vertical { (dx / dy).atan().to_degrees().abs() } else { (dy / dx).atan().to_degrees().abs() }
    }

    #[test]
    fn identity_warp() {
        let w = perspective(0.0, 0.0, 0.0).warp(0.0, W, H);
        let (x, y) = apply(&w, 1234.0, -567.0);
        assert!((x - 1234.0).abs() < 1e-9 && (y + 567.0).abs() < 1e-9);
    }

    #[test]
    fn positive_vertical_corrects_a_camera_pointing_up() {
        // Pointing up: verticals converge towards the top. A positive tilt spreads the
        // top of the frame wider than its bottom.
        let w = perspective(10.0, 0.0, 0.0).warp(0.0, W, H);
        let top = apply(&w, W / 2.0, -H / 2.0).0 - apply(&w, -W / 2.0, -H / 2.0).0;
        let bottom = apply(&w, W / 2.0, H / 2.0).0 - apply(&w, -W / 2.0, H / 2.0).0;
        assert!(top > bottom, "{top} {bottom}");
        // A camera pointing left: the left side is farther, a positive pan widens it.
        let w = perspective(0.0, 10.0, 0.0).warp(0.0, W, H);
        let left = apply(&w, -W / 2.0, H / 2.0).1 - apply(&w, -W / 2.0, -H / 2.0).1;
        let right = apply(&w, W / 2.0, H / 2.0).1 - apply(&w, W / 2.0, -H / 2.0).1;
        assert!(left > right, "{left} {right}");
    }

    #[test]
    fn fits_a_tilted_and_rolled_camera() {
        // World → camera for a camera pitched up 12° and rolled 3°: the inverse of the correction.
        let camera = transpose(&mul(&rot_x(12f64.to_radians()), &rot_z(3f64.to_radians())));
        let guides = scene(&camera);
        let fit = fit(&guides, FitMode::Vertical, F).unwrap();
        assert!((fit.vertical - 12.0).abs() < 0.01 && (fit.angle - 3.0).abs() < 0.01, "{fit:?}");
        let w = Perspective { vertical: fit.vertical, ..perspective(0.0, 0.0, 0.0) }.warp(fit.angle, W, H);
        for g in guides.iter().filter(|g| g.vertical) {
            assert!(angle_off(g, &w) < 0.01, "{g:?}");
        }
    }

    #[test]
    fn fits_both_with_a_pan() {
        let camera = transpose(&mul(&mul(&rot_x(8f64.to_radians()), &rot_y(-15f64.to_radians())), &rot_z(-2f64.to_radians())));
        let guides = scene(&camera);
        let fit = fit(&guides, FitMode::Both, F).unwrap();
        assert!((fit.vertical - 8.0).abs() < 0.01 && (fit.horizontal + 15.0).abs() < 0.01, "{fit:?}");
        assert!((fit.angle + 2.0).abs() < 0.01 && fit.shear.abs() < 1e-4, "{fit:?}");
        let p = Perspective { vertical: fit.vertical, horizontal: fit.horizontal, shear: fit.shear, aspect: 0.0, focal: (F / W) as f32 };
        let w = p.warp(fit.angle, W, H);
        for g in &guides {
            assert!(angle_off(g, &w) < 0.01, "{g:?}");
        }
        // Horizontal alone levels the horizontals.
        let fit = super::fit(&guides, FitMode::Horizontal, F).unwrap();
        let w = Perspective { horizontal: fit.horizontal, ..perspective(0.0, 0.0, 0.0) }.warp(fit.angle, W, H);
        for g in guides.iter().filter(|g| !g.vertical) {
            assert!(angle_off(g, &w) < 0.01, "{g:?}");
        }
    }

    #[test]
    fn both_shears_horizontals_that_are_not_square() {
        // Walls at 80° to each other: verticals exact, horizontals levelled by the shear.
        let camera = transpose(&rot_x(6f64.to_radians()));
        let skew = [10f64.to_radians().cos(), 10f64.to_radians().sin(), 0.0];
        let mut guides: Vec<Guide> = scene(&camera).into_iter().filter(|g| g.vertical).collect();
        for y in [-2.0, 1.0] {
            guides.push(guide(&camera, [0.0, y, 10.0], skew, false));
        }
        let fit = fit(&guides, FitMode::Both, F).unwrap();
        assert!(fit.shear.abs() > 0.05, "{fit:?}");
        let p = Perspective { vertical: fit.vertical, horizontal: fit.horizontal, shear: fit.shear, aspect: 0.0, focal: (F / W) as f32 };
        let w = p.warp(fit.angle, W, H);
        for g in &guides {
            assert!(angle_off(g, &w) < 0.01, "{g:?}");
        }
    }

    #[test]
    fn a_single_line_sets_the_roll() {
        let g = Guide { a: (0.0, -1000.0), b: (100.0, 1000.0), vertical: true };
        let fit = fit(&[g], FitMode::Vertical, F).unwrap();
        assert_eq!((fit.vertical, fit.horizontal), (0.0, 0.0));
        let w = perspective(0.0, 0.0, 0.0).warp(fit.angle, W, H);
        assert!(angle_off(&g, &w) < 1e-6);
        assert!(super::fit(&[g], FitMode::Horizontal, F).is_none());
    }

    #[test]
    fn aspect_framing_matches_straighten() {
        // Rotation alone: the same scale as the straighten-only path, centred.
        let angle = 7.0f32;
        let w = perspective(0.0, 0.0, 0.0).warp(angle, W, H);
        let f = framing(&w, W, H, AutoCrop::Aspect);
        let t = (angle as f64).to_radians();
        let scale = ((W * t.cos() + H * t.sin()) / W).max((W * t.sin() + H * t.cos()) / H);
        assert!((f.width - W / scale).abs() < 1e-6 && (f.x + f.width / 2.0).abs() < 1e-6, "{f:?}");
        assert_eq!(f.frame, (W, H));
    }

    #[test]
    fn framings_stay_inside() {
        let w = perspective(15.0, -5.0, 0.1).warp(2.0, W, H);
        let quad = corners(W, H).map(|(x, y)| apply(&w, x, y));
        let inside = |x: f64, y: f64| {
            (0..4).all(|i| {
                let (p, q) = (quad[i], quad[(i + 1) % 4]);
                // Signed distance to the edge, pixels.
                ((q.0 - p.0) * (y - p.1) - (q.1 - p.1) * (x - p.0)) / (q.0 - p.0).hypot(q.1 - p.1) >= -1e-3
            })
        };
        let aspect = framing(&w, W, H, AutoCrop::Aspect);
        let area = framing(&w, W, H, AutoCrop::Area);
        for f in [aspect, area] {
            for (x, y) in [(f.x, f.y), (f.x + f.width, f.y), (f.x, f.y + f.height), (f.x + f.width, f.y + f.height)] {
                assert!(inside(x, y), "{f:?} ({x}, {y})");
            }
        }
        assert!(area.width * area.height >= aspect.width * aspect.height - 1e-6);
        assert!((aspect.width / aspect.height - W / H).abs() < 1e-9);
        // The frame keeps the pixel count.
        assert!((area.frame.0 * area.frame.1 - W * H).abs() < 1e-3);
        let off = framing(&w, W, H, AutoCrop::Off);
        assert!(off.width >= area.width && off.height >= area.height);
    }

    #[test]
    fn extreme_tilts_stay_in_front() {
        let w = Perspective { vertical: 40.0, horizontal: 40.0, shear: 0.0, aspect: 0.0, focal: 0.2 }.warp(0.0, W, H);
        for (x, y) in corners(W, H) {
            assert!(w[2][0] * x + w[2][1] * y + w[2][2] > 0.0);
        }
    }
}
