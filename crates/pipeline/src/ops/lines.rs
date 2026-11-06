//! Straight line detection for perspective correction: segments that are close to
//! vertical or horizontal, with those that agree on a vanishing point selected.
//!
//! The detector follows the idea of LSD (Grompone von Gioi et al., "LSD: a Line Segment
//! Detector", IPOL 2012), simplified: pixels are grown into regions whose gradients
//! share an orientation, strongest first, and a region that fills a thin rectangle
//! well enough is a segment. There's no a-contrario validation: short or sparse
//! regions are dropped instead.

use crate::image::Image;

/// A detected segment, in the image's pixels (not centred), and whether it is one of
/// the lines that agree on a vanishing point.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub a: (f32, f32),
    pub b: (f32, f32),
    pub vertical: bool,
    pub selected: bool,
}

/// A guide line to fit the perspective to (`Developer::fit_perspective`): endpoints in
/// the sensor frame (normalised), and whether it should become vertical or horizontal.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideLine {
    pub a: (f32, f32),
    pub b: (f32, f32),
    pub vertical: bool,
}

/// Angle tolerance for growing a region, radians.
const TOLERANCE: f32 = std::f32::consts::PI / 8.0;
/// Minimum gradient magnitude (of square-root luminance, the image's mean at 0.18²).
const MIN_GRADIENT: f32 = 0.02;
/// Segments steeper than this from both axes are dropped, degrees.
const MAX_TILT: f32 = 40.0;
/// Fewest pixels in a region, and the share of its rectangle it must fill.
const MIN_PIXELS: usize = 12;
const MIN_DENSITY: f32 = 0.55;
/// At most this many segments, longest first.
const MAX_SEGMENTS: usize = 300;
/// A line agrees with a vanishing point within this angle, degrees.
const INLIER_ANGLE: f64 = 1.5;
/// Pieces of a line (cut by crossing edges: window bars, bricks…) are detected down to
/// this share of the minimum length, then merged when they are collinear: within this
/// angle (degrees) and distance (pixels), with gaps up to this share of the image size.
const PIECE: f32 = 0.3;
const MERGE_ANGLE: f32 = 1.5;
const MERGE_DISTANCE: f32 = 1.5;
const MERGE_GAP: f32 = 0.02;
/// The roll and tilt (or pan) a vanishing point implies must be within these, degrees,
/// for its lines to be selected.
const PLAUSIBLE_ROLL: f64 = 20.0;
const PLAUSIBLE_TILT: f64 = 35.0;
/// Lines that set a vanishing point must be this far apart (a share of the image's
/// width for verticals, height for horizontals): two edges of one bar would set it
/// anywhere.
const MIN_SPREAD: f64 = 0.05;

/// Segments in `img` (a linear RGB image of the oriented, lens-corrected frame), for
/// a camera of focal length `focal` in its pixels. Shorter than `min_length` pixels
/// are left out.
pub fn detect(img: &Image, focal: f32, min_length: f32) -> Vec<Segment> {
    let (w, h) = (img.width, img.height);
    if w < 8 || h < 8 {
        return Vec::new();
    }
    let luma = smoothed_luma(img);
    // LSD's 2×2 gradient, at the centre of each block of four pixels.
    let (gw, gh) = (w - 1, h - 1);
    let mut magnitude = vec![0.0f32; gw * gh];
    let mut angle = vec![0.0f32; gw * gh];
    for y in 0..gh {
        for x in 0..gw {
            let (a, b, c, d) = (luma[y * w + x], luma[y * w + x + 1], luma[(y + 1) * w + x], luma[(y + 1) * w + x + 1]);
            let gx = (b + d - a - c) / 2.0;
            let gy = (c + d - a - b) / 2.0;
            magnitude[y * gw + x] = gx.hypot(gy);
            // The level line's direction: along the edge, with its contrast's polarity.
            angle[y * gw + x] = gx.atan2(-gy);
        }
    }
    let mut order: Vec<u32> = (0..gw * gh).filter(|&i| magnitude[i] > MIN_GRADIENT).map(|i| i as u32).collect();
    order.sort_unstable_by(|a, b| magnitude[*b as usize].total_cmp(&magnitude[*a as usize]));

    let mut used = vec![false; gw * gh];
    let mut segments = Vec::new();
    let mut region: Vec<usize> = Vec::new();
    for &seed in &order {
        let seed = seed as usize;
        if used[seed] {
            continue;
        }
        // Grow the region over 8-connected pixels aligned with its mean orientation.
        region.clear();
        region.push(seed);
        used[seed] = true;
        let (mut sx, mut sy) = (angle[seed].cos(), angle[seed].sin());
        let mut mean = angle[seed];
        let mut k = 0;
        while k < region.len() {
            let (px, py) = (region[k] % gw, region[k] / gw);
            k += 1;
            for (dx, dy) in [(-1i64, -1i64), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)] {
                let (nx, ny) = (px as i64 + dx, py as i64 + dy);
                if nx < 0 || ny < 0 || nx >= gw as i64 || ny >= gh as i64 {
                    continue;
                }
                let n = ny as usize * gw + nx as usize;
                if used[n] || magnitude[n] <= MIN_GRADIENT || angle_diff(angle[n], mean) > TOLERANCE {
                    continue;
                }
                used[n] = true;
                region.push(n);
                sx += angle[n].cos();
                sy += angle[n].sin();
                mean = sy.atan2(sx);
            }
        }
        if region.len() < MIN_PIXELS {
            // Noise. Its pixels stay used, which keeps the whole pass linear.
            continue;
        }
        if let Some(s) = rectangle(&region, gw, &magnitude, min_length * PIECE) {
            segments.push(s);
        }
    }
    let segments = merge(segments, MERGE_GAP * w.max(h) as f32);

    // Keep the long, near-vertical and near-horizontal ones, longest first.
    let max_tilt = MAX_TILT.to_radians().tan();
    let mut segments: Vec<Segment> = segments
        .into_iter()
        .filter(|(a, b)| (b.0 - a.0).hypot(b.1 - a.1) >= min_length)
        .filter_map(|(a, b)| {
            let (dx, dy) = ((b.0 - a.0).abs(), (b.1 - a.1).abs());
            let vertical = dy > dx;
            let ratio = if vertical { dx / dy } else { dy / dx };
            (ratio <= max_tilt).then_some(Segment { a, b, vertical, selected: false })
        })
        .collect();
    segments.sort_by(|p, q| length(q).total_cmp(&length(p)));
    segments.truncate(MAX_SEGMENTS);
    for vertical in [true, false] {
        select_consistent(&mut segments, vertical, (w as f32, h as f32), focal);
    }
    segments
}

/// Rec. 2020 luminance, scaled so that its mean is middle grey, square-rooted (closer
/// to perceived lightness) and smoothed with a small binomial kernel.
fn smoothed_luma(img: &Image) -> Vec<f32> {
    let (w, h) = (img.width, img.height);
    let luma: Vec<f32> = img.pixels.iter().map(|p| (0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]).max(0.0)).collect();
    let mean = luma.iter().map(|&v| v as f64).sum::<f64>() / luma.len() as f64;
    let k = if mean > 1e-9 { (0.18 / mean) as f32 } else { 1.0 };
    let luma: Vec<f32> = luma.iter().map(|&v| (v * k).min(16.0).sqrt()).collect();
    // 1-2-1 horizontally, then vertically (edges clamped).
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &luma[y * w..(y + 1) * w];
        for x in 0..w {
            let (l, r) = (row[x.saturating_sub(1)], row[(x + 1).min(w - 1)]);
            tmp[y * w + x] = (l + 2.0 * row[x] + r) / 4.0;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let (up, down) = (y.saturating_sub(1), (y + 1).min(h - 1));
        for x in 0..w {
            out[y * w + x] = (tmp[up * w + x] + 2.0 * tmp[y * w + x] + tmp[down * w + x]) / 4.0;
        }
    }
    out
}

/// The difference of two angles, 0 … π.
fn angle_diff(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(std::f32::consts::TAU);
    d.min(std::f32::consts::TAU - d)
}

/// The segment a region of gradient pixels (indices in a `gw`-wide grid) stands for:
/// its weighted centroid and principal direction, from end to end, if it is long
/// enough and fills its rectangle well enough.
fn rectangle(region: &[usize], gw: usize, magnitude: &[f32], min_length: f32) -> Option<((f32, f32), (f32, f32))> {
    // Gradient pixels sit between four image pixels.
    let at = |i: usize| ((i % gw) as f64 + 1.0, (i / gw) as f64 + 1.0);
    let (mut sw, mut cx, mut cy) = (0.0f64, 0.0, 0.0);
    for &i in region {
        let (x, y) = at(i);
        let m = magnitude[i] as f64;
        sw += m;
        cx += m * x;
        cy += m * y;
    }
    let (cx, cy) = (cx / sw, cy / sw);
    let (mut xx, mut yy, mut xy) = (0.0f64, 0.0, 0.0);
    for &i in region {
        let (x, y) = at(i);
        let m = magnitude[i] as f64;
        xx += m * (x - cx) * (x - cx);
        yy += m * (y - cy) * (y - cy);
        xy += m * (x - cx) * (y - cy);
    }
    // Principal axis of the 2×2 covariance.
    let theta = 0.5 * (2.0 * xy).atan2(xx - yy);
    let (dx, dy) = (theta.cos(), theta.sin());
    let (mut lo, mut hi, mut wlo, mut whi) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &i in region {
        let (x, y) = at(i);
        let (along, across) = ((x - cx) * dx + (y - cy) * dy, -(x - cx) * dy + (y - cy) * dx);
        lo = lo.min(along);
        hi = hi.max(along);
        wlo = wlo.min(across);
        whi = whi.max(across);
    }
    let (len, width) = (hi - lo + 1.0, whi - wlo + 1.0);
    if (len as f32) < min_length || width > (len / 6.0).max(3.0) || (region.len() as f64 / (len * width)) < MIN_DENSITY as f64 {
        return None;
    }
    let a = ((cx + dx * lo) as f32, (cy + dy * lo) as f32);
    let b = ((cx + dx * hi) as f32, (cy + dy * hi) as f32);
    Some((a, b))
}

type Piece = ((f32, f32), (f32, f32));

/// Merge collinear pieces separated by gaps up to `max_gap` pixels, longest first, until
/// none are left to merge.
fn merge(mut pieces: Vec<Piece>, max_gap: f32) -> Vec<Piece> {
    let len = |p: &Piece| (p.1.0 - p.0.0).hypot(p.1.1 - p.0.1);
    let max_sin = MERGE_ANGLE.to_radians().sin();
    loop {
        pieces.sort_by(|p, q| len(q).total_cmp(&len(p)));
        let mut merged = false;
        let mut out: Vec<Piece> = Vec::with_capacity(pieces.len());
        let mut gone = vec![false; pieces.len()];
        for i in 0..pieces.len() {
            if gone[i] {
                continue;
            }
            let mut p = pieces[i];
            for j in i + 1..pieces.len() {
                if gone[j] {
                    continue;
                }
                let q = pieces[j];
                let l = len(&p);
                if l == 0.0 {
                    break;
                }
                let (dx, dy) = ((p.1.0 - p.0.0) / l, (p.1.1 - p.0.1) / l);
                let (qx, qy) = (q.1.0 - q.0.0, q.1.1 - q.0.1);
                let lq = qx.hypot(qy);
                if lq == 0.0 || (dx * qy - dy * qx).abs() / lq > max_sin {
                    continue;
                }
                // Both ends of `q` close to `p`'s line, and close enough along it.
                let along = |r: (f32, f32)| (r.0 - p.0.0) * dx + (r.1 - p.0.1) * dy;
                let across = |r: (f32, f32)| (-(r.0 - p.0.0) * dy + (r.1 - p.0.1) * dx).abs();
                if across(q.0) > MERGE_DISTANCE || across(q.1) > MERGE_DISTANCE {
                    continue;
                }
                let (t0, t1) = (along(q.0).min(along(q.1)), along(q.0).max(along(q.1)));
                let gap = (t0 - l).max(-t1);
                if gap > max_gap {
                    continue;
                }
                // The union, along the longer piece's line.
                let (lo, hi) = (t0.min(0.0), t1.max(l));
                let start = p.0;
                p = ((start.0 + dx * lo, start.1 + dy * lo), (start.0 + dx * hi, start.1 + dy * hi));
                gone[j] = true;
                merged = true;
            }
            out.push(p);
        }
        pieces = out;
        if !merged {
            return pieces;
        }
    }
}

fn length(s: &Segment) -> f32 {
    (s.b.0 - s.a.0).hypot(s.b.1 - s.a.1)
}

/// Select the segments of one kind that agree on a vanishing point, the one most of
/// their length agrees on (RANSAC over pairs of them). It must lie beyond the frame
/// along their direction: two lines that cross within it aren't parallel ones.
fn select_consistent(segments: &mut [Segment], vertical: bool, (w, h): (f32, f32), focal: f32) {
    let f = focal.max(1.0) as f64;
    let picked: Vec<usize> = (0..segments.len()).filter(|&i| segments[i].vertical == vertical).collect();
    if picked.len() < 2 {
        return;
    }
    let centred = |p: (f32, f32)| (p.0 as f64 - w as f64 / 2.0, p.1 as f64 - h as f64 / 2.0);
    let normals: Vec<Option<[f64; 3]>> = picked
        .iter()
        .map(|&i| {
            let (a, b) = (centred(segments[i].a), centred(segments[i].b));
            let n = super::perspective::cross([a.0 / f, a.1 / f, 1.0], [b.0 / f, b.1 / f, 1.0]);
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            (len > 1e-12).then(|| n.map(|v| v / len))
        })
        .collect();
    let max_sin = INLIER_ANGLE.to_radians().sin();
    // Whether segment `k` points at direction `v`, and its length if so.
    let agrees = |k: usize, v: [f64; 3]| -> Option<f64> {
        let s = &segments[picked[k]];
        let (a, b) = (centred(s.a), centred(s.b));
        let (sx, sy) = (b.0 - a.0, b.1 - a.1);
        let (mx, my) = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
        // Towards the vanishing point from the middle (or along it, at infinity).
        let (tx, ty) = if v[2].abs() < 1e-12 { (v[0], v[1]) } else { (f * v[0] / v[2] - mx, f * v[1] / v[2] - my) };
        let (ls, lt) = (sx.hypot(sy), tx.hypot(ty));
        if ls == 0.0 || lt == 0.0 {
            return None;
        }
        ((sx * ty - sy * tx).abs() / (ls * lt) <= max_sin).then_some(ls)
    };
    let plausible = |v: [f64; 3]| {
        if v[2].abs() > 1e-12 {
            let (px, py) = (f * v[0] / v[2], f * v[1] / v[2]);
            if if vertical { py.abs() < h as f64 / 2.0 } else { px.abs() < w as f64 / 2.0 } {
                return false;
            }
        }
        // The correction it implies (as `perspective::fit` would) must be moderate.
        let (a, b) = if vertical { (v[0], v[1]) } else { (-v[1], v[0]) };
        if b.abs() < 1e-12 {
            return false;
        }
        let roll = (a / b).atan();
        let level = roll.sin() * a + roll.cos() * b;
        let tilt = (-v[2] / level).atan();
        roll.to_degrees().abs() <= PLAUSIBLE_ROLL && tilt.to_degrees().abs() <= PLAUSIBLE_TILT
    };
    // Where a segment crosses the frame, across its kind: x for verticals, y for horizontals.
    let offset = |k: usize| {
        let s = &segments[picked[k]];
        (if vertical { s.a.0 + s.b.0 } else { s.a.1 + s.b.1 }) as f64 / 2.0
    };
    let min_spread = MIN_SPREAD * if vertical { w } else { h } as f64;
    let n = picked.len();
    let pairs: Vec<(usize, usize)> = if n * (n - 1) / 2 <= 3000 {
        (0..n).flat_map(|i| (i + 1..n).map(move |j| (i, j))).collect()
    } else {
        // Deterministic sampling (xorshift), so that a detection can be repeated.
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        (0..3000).map(|_| ((next() % n as u64) as usize, (next() % n as u64) as usize)).filter(|(i, j)| i != j).collect()
    };
    let mut best: (f64, Option<[f64; 3]>) = (0.0, None);
    for (i, j) in pairs {
        let (Some(a), Some(b)) = (normals[i], normals[j]) else { continue };
        if (offset(i) - offset(j)).abs() < min_spread {
            continue;
        }
        let v = super::perspective::cross(a, b);
        let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if len < 1e-12 {
            continue;
        }
        let v = v.map(|c| c / len);
        if !plausible(v) {
            continue;
        }
        let score: f64 = (0..n).filter_map(|k| agrees(k, v)).sum();
        if score > best.0 {
            best = (score, Some(v));
        }
    }
    let Some(v) = best.1 else { return };
    let inliers: Vec<usize> = (0..n).filter(|&k| agrees(k, v).is_some()).collect();
    let (lo, hi) = inliers.iter().fold((f64::MAX, f64::MIN), |(lo, hi), &k| (lo.min(offset(k)), hi.max(offset(k))));
    if inliers.len() >= 2 && hi - lo >= min_spread {
        for k in inliers {
            segments[picked[k]].selected = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dark image with bright rectangles: their edges are lines.
    fn boxes(w: usize, h: usize, rects: &[(usize, usize, usize, usize)]) -> Image {
        let mut img = Image::new(w, h);
        for p in &mut img.pixels {
            *p = [0.02; 3];
        }
        for &(x0, y0, x1, y1) in rects {
            for y in y0..y1 {
                for x in x0..x1 {
                    img.pixels[y * w + x] = [0.5; 3];
                }
            }
        }
        img
    }

    #[test]
    fn finds_the_edges_of_a_box() {
        let img = boxes(400, 300, &[(100, 60, 300, 240)]);
        let segments = detect(&img, 400.0, 40.0);
        let verticals: Vec<_> = segments.iter().filter(|s| s.vertical).collect();
        let horizontals: Vec<_> = segments.iter().filter(|s| !s.vertical).collect();
        assert_eq!((verticals.len(), horizontals.len()), (2, 2), "{segments:?}");
        for s in &verticals {
            let x = (s.a.0 + s.b.0) / 2.0;
            assert!((x - 100.0).abs() < 1.5 || (x - 300.0).abs() < 1.5, "{s:?}");
            assert!(length(s) > 160.0, "{s:?}");
        }
        // Parallel lines agree on a vanishing point at infinity.
        assert!(segments.iter().all(|s| s.selected), "{segments:?}");
    }

    #[test]
    fn leaves_out_lines_that_disagree() {
        // Three parallel verticals, and one leaning by 6°.
        let mut img = boxes(600, 400, &[(100, 50, 140, 350), (250, 50, 290, 350)]);
        for y in 50..350 {
            let x0 = 450 + ((y - 50) as f32 * 6f32.to_radians().tan()) as usize;
            for x in x0..x0 + 40 {
                img.pixels[y * 600 + x] = [0.5; 3];
            }
        }
        let segments = detect(&img, 600.0, 60.0);
        // The upright edges are selected; the leaning ones (stair-stepped, maybe in
        // pieces) aren't.
        let upright = |s: &Segment| (s.a.0 + s.b.0) / 2.0 < 400.0;
        let verticals: Vec<_> = segments.iter().filter(|s| s.vertical).collect();
        assert_eq!(verticals.iter().filter(|s| upright(s)).count(), 4, "{segments:?}");
        assert!(verticals.len() > 4, "{segments:?}");
        assert!(verticals.iter().all(|s| s.selected == upright(s)), "{segments:?}");
    }

    #[test]
    fn nothing_in_a_flat_image() {
        assert!(detect(&boxes(200, 200, &[]), 200.0, 20.0).is_empty());
    }
}
