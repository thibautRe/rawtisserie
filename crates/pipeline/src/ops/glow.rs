//! Glow (roadmap 4.12): light spreading out of the brightest parts of the image, added
//! back to it. Bloom around lamps and specular highlights, film halation (with a red
//! tint), diffusion filters (a low threshold and strength).
//!
//! In linear Rec.2020, before exposure:
//!
//! 1. A bright pass keeps the light above the threshold `T`, measured on each pixel's
//!    brightest channel `v` (so saturated lights glow too), with a soft knee of half
//!    width `k`: `e(v) = 0` below `T − k`, `(v − T + k)² / 4k` across the knee, `v − T`
//!    above it (continuous, with a continuous slope). The pixel is scaled by `e(v) / v`,
//!    keeping its colour.
//! 2. A long-tailed kernel spreads it: a weighted mean of four Gaussians an octave
//!    apart, the widest of sigma `radius`. Each keeps the light's total, so the narrow
//!    ones make a bright core and the wide ones the tail. The falloff `f` (-1 … 1)
//!    weighs Gaussian `i` (0 the widest) by `2^(2f·(1.5 − i))`, normalised: equal at 0,
//!    the narrowest 64× the widest at -1 (a tight halo), the reverse at 1 (a long tail).
//! 3. The result, times the strength and the tint (normalised to luminance 1, so it
//!    changes the colour and not the amount), is added to the image.
//!
//! Each Gaussian is computed on a reduced copy of the bright pass (2×2 averages, as many
//! times as it stays at least 1.5 pixels wide there), then scaled back up bilinearly; its
//! sigma is reduced by what averaging and interpolation add. The reduced copies' cells
//! are aligned on the whole frame, not on the image given, so that a region of the
//! frame gets the same glow as the whole. Only the box around the pixels above the
//! threshold (plus the reach) is computed: the rest of the bright pass is 0.
//!
//! A streak or a motion glow (`shape`) spreads along an axis at `angle` instead: each
//! Gaussian is `thickness` times as wide across it. A streak's Gaussians are centred on
//! the light; a motion glow's are half as wide and as far from the light as they were
//! wide, towards `angle`, so that together they make a trail starting at the light. They're
//! computed on a grid turned to the axis (bilinear in and out), whose points are fixed in
//! the frame, so that a region gets the same glow as the whole. No reduced copies there:
//! the blurs are running sums, whatever their width.

use crate::color::luminance;
use crate::image::{Image, Rgb};
use crate::ops::filters;
use crate::params::{Glow, GlowShape};

/// Middle grey, which the threshold is an EV offset from.
const GREY: f32 = 0.1845;
/// Gaussians in the kernel, an octave apart.
const OCTAVES: usize = 4;
/// Octaves of weight between neighbouring Gaussians at the ends of the falloff.
const FALLOFF_OCTAVES: f32 = 2.0;
/// Most halvings of the bright pass.
const MAX_LEVEL: u32 = 6;
/// The narrowest a Gaussian may be on a reduced copy, in its pixels.
const MIN_SIGMA: f32 = 1.5;

/// [`Glow`] at a render scale.
#[derive(Clone, Copy, Debug)]
pub struct GlowOp {
    threshold: f32,
    knee: f32,
    /// Each Gaussian: the halvings it's computed after, its sigma there, and its weight.
    octaves: [(u32, f32, f32); OCTAVES],
    /// Strength × tint, per channel.
    gain: Rgb,
    /// A streak or a motion glow, instead of `octaves`.
    axis: Option<Axis>,
}

/// A glow along an axis (a streak, or motion).
#[derive(Clone, Copy, Debug)]
struct Axis {
    /// The axis's direction in the frame (x right, y down): `(cos, -sin)` of the angle.
    cos: f32,
    sin: f32,
    /// The grid's spacing along the axis, in pixels (1 across it).
    step: usize,
    /// Each Gaussian on the grid: its sigma along the axis (in steps) and across it, how
    /// far along it's centred from the light (in steps), and its weight.
    octaves: [(f32, f32, f32, f32); OCTAVES],
}

impl GlowOp {
    /// `scale`: output pixels per full-resolution pixel.
    pub fn new(p: &Glow, scale: f32) -> Self {
        let threshold = GREY * p.threshold.clamp(-12.0, 12.0).exp2();
        let widest = (p.radius * scale).max(0.0);
        let falloff = p.falloff.clamp(-1.0, 1.0);
        let weights: [f32; OCTAVES] = std::array::from_fn(|i| (FALLOFF_OCTAVES * falloff * (0.5 * (OCTAVES - 1) as f32 - i as f32)).exp2());
        let total: f32 = weights.iter().sum();
        let octaves = std::array::from_fn(|i| {
            let sigma = widest * 0.5f32.powi(i as i32);
            let level = ((sigma / MIN_SIGMA).max(1.0).log2().floor() as u32).min(MAX_LEVEL);
            let d = (1u32 << level) as f32;
            // A 2×2 average adds a variance of d²/12 (a box d wide), bilinear
            // interpolation d²/6 (a tent).
            let reduced = if level == 0 { sigma } else { (sigma * sigma - d * d / 4.0).max(0.0).sqrt() / d };
            (level, reduced, weights[i] / total)
        });
        let thickness = p.thickness.clamp(0.0, 1.0);
        let axis = (p.shape != GlowShape::Round).then(|| {
            let motion = p.shape == GlowShape::Motion;
            let (sin, cos) = p.angle.to_radians().sin_cos();
            let along = |i: usize| widest * 0.5f32.powi(i as i32) * if motion { 0.5 } else { 1.0 };
            // As coarse along the axis as the narrowest Gaussian allows.
            let level = ((along(OCTAVES - 1) / MIN_SIGMA).max(1.0).log2().floor() as u32).min(MAX_LEVEL);
            let d = (1u32 << level) as f32;
            // Splatting onto the grid and interpolating back each add a tent's variance,
            // d²/6 along and 1/6 across.
            let reduced = |sigma: f32, d: f32| (sigma * sigma - d * d / 3.0).max(0.0).sqrt() / d;
            Axis {
                cos,
                sin,
                step: 1 << level,
                octaves: std::array::from_fn(|i| {
                    let sigma = widest * 0.5f32.powi(i as i32);
                    let offset = if motion { sigma } else { 0.0 };
                    (reduced(along(i), d), reduced(thickness * sigma, 1.0), offset / d, weights[i] / total)
                }),
            }
        });
        let tint = tint(p.hue, p.saturation);
        Self {
            threshold,
            knee: p.softness.clamp(0.0, 1.0) * threshold,
            octaves,
            gain: tint.map(|c| c * p.strength.max(0.0)),
            axis,
        }
    }

    /// Whether it changes the image.
    pub fn active(&self) -> bool {
        self.gain.iter().any(|&g| g > 0.0)
    }

    /// The size of the cells of the coarsest reduced copy, in pixels.
    fn cell(&self) -> usize {
        if self.axis.is_some() {
            return 1;
        }
        1 << self.octaves.iter().map(|o| o.0).max().unwrap_or(0)
    }

    /// How far, in pixels, it reads around each pixel.
    pub fn reach(&self) -> usize {
        if let Some(axis) = &self.axis {
            // The blurs, the offset, and the steps onto the turned grid and back.
            let each = axis.octaves.iter().map(|&(along, across, offset, _)| {
                ((offset.ceil() as usize + filters::box_reach(along) + 2) * axis.step).max(filters::box_reach(across) + 2)
            });
            return each.max().unwrap_or(0);
        }
        let each = self.octaves.iter().map(|&(level, sigma, _)| {
            let d = 1usize << level;
            // The blur, the averaged cells and the interpolation's neighbour.
            if level == 0 { filters::box_reach(sigma) } else { (filters::box_reach(sigma) + 2) * d }
        });
        let cell = self.cell();
        each.max().unwrap_or(0) + if cell > 1 { cell } else { 0 }
    }

    /// The light above the threshold of a pixel.
    fn bright(&self, p: Rgb) -> Rgb {
        let p = p.map(|c| c.max(0.0));
        let v = p[0].max(p[1]).max(p[2]);
        let (t, k) = (self.threshold, self.knee);
        let e = if v <= t - k {
            return [0.0; 3];
        } else if v < t + k {
            let d = v - t + k;
            d * d / (4.0 * k)
        } else {
            v - t
        };
        p.map(|c| c * e / v)
    }

    /// Adds the glow to `img`, whose top left pixel is at `origin` in the frame.
    pub fn apply(&self, img: &mut Image, origin: (usize, usize)) {
        if !self.active() {
            return;
        }
        let (w, h) = (img.width, img.height);
        let Some([x0, y0, x1, y1]) = self.bright_box(img) else { return };
        // The box with the reach, in frame coordinates, out to whole cells (pixels
        // outside the image repeat its edges, as the blurs do).
        let (reach, cell) = (self.reach(), self.cell());
        let (ox, oy) = origin;
        let fx0 = (ox + x0.saturating_sub(reach)) / cell * cell;
        let fy0 = (oy + y0.saturating_sub(reach)) / cell * cell;
        let fx1 = (ox + (x1 + reach + 1).min(w)).next_multiple_of(cell);
        let fy1 = (oy + (y1 + reach + 1).min(h)).next_multiple_of(cell);
        let (bw, bh) = (fx1 - fx0, fy1 - fy0);
        let at = |f: usize, o: usize, n: usize| (f as isize - o as isize).clamp(0, n as isize - 1) as usize;
        let mut px = Vec::with_capacity(bw * bh);
        let mut row = vec![[0.0f32; 3]; bw];
        for fy in fy0..fy1 {
            let src = &img.pixels[at(fy, oy, h) * w..][..w];
            // Pixels before and after the image repeat its edges.
            let (first, last) = (ox.clamp(fx0, fx1), (ox + w).clamp(fx0, fx1));
            row[first - fx0..last - fx0].iter_mut().zip(&src[first - ox..last - ox]).for_each(|(r, &p)| *r = self.bright(p));
            if first > fx0 {
                row[..first - fx0].fill(self.bright(src[0]));
            }
            if last < fx1 {
                row[last - fx0..].fill(self.bright(src[w - 1]));
            }
            px.extend_from_slice(&row);
        }
        let bright = Level { w: bw, h: bh, px };
        if let Some(axis) = &self.axis {
            return self.apply_along(axis, img, origin, (fx0, fy0), &bright);
        }
        let mut levels = vec![bright];
        let top = self.octaves.iter().map(|o| o.0).max().unwrap_or(0);
        for _ in 0..top {
            let half = levels.last().expect("level 0 is there").half();
            levels.push(half);
        }

        // The pixels of `img` in the box.
        let (ix0, iy0) = (fx0.saturating_sub(ox), fy0.saturating_sub(oy));
        let (ix1, iy1) = ((fx1 - ox).min(w), (fy1 - oy).min(h));
        for &(level, sigma, weight) in &self.octaves {
            let mut l = levels[level as usize].clone();
            filters::box_blur_rgb(&mut l.px, l.w, l.h, sigma);
            let weight = self.gain.map(|g| g * weight);
            l.px.iter_mut().for_each(|p| (0..3).for_each(|c| p[c] *= weight[c]));
            let d = 1usize << level;
            let pos = |i: usize, f0: usize, o: usize, n: usize| {
                let u = (((o + i - f0) as f32 + 0.5) / d as f32 - 0.5).clamp(0.0, (n - 1) as f32);
                let i0 = u as usize;
                (i0, (i0 + 1).min(n - 1), u - i0 as f32)
            };
            let cols: Vec<_> = (ix0..ix1).map(|x| pos(x, fx0, ox, l.w)).collect();
            let mut row = vec![[0.0f32; 3]; l.w];
            for y in iy0..iy1 {
                let (j0, j1, t) = pos(y, fy0, oy, l.h);
                let (a, b) = (&l.px[j0 * l.w..][..l.w], &l.px[j1 * l.w..][..l.w]);
                for ((r, p), q) in row.iter_mut().zip(a).zip(b) {
                    *r = std::array::from_fn(|c| p[c] + (q[c] - p[c]) * t);
                }
                for (p, &(i0, i1, s)) in img.pixels[y * w + ix0..y * w + ix1].iter_mut().zip(&cols) {
                    let (a, b) = (row[i0], row[i1]);
                    (0..3).for_each(|c| p[c] += a[c] + (b[c] - a[c]) * s);
                }
            }
        }
    }

    /// A streak or a motion glow: `bright` (the bright pass from `corner` in the frame)
    /// spread along the axis on a turned grid, added to `img` (at `origin` in the frame).
    ///
    /// The bright pass is splatted onto the grid (bilinearly, each pixel's light shared
    /// between the 4 points around it), whose points are `step` pixels apart along the
    /// axis and 1 across, at whole steps from the frame's origin: a region's grid is the
    /// whole's. Blurred there, it's read back bilinearly.
    fn apply_along(&self, axis: &Axis, img: &mut Image, origin: (usize, usize), corner: (usize, usize), bright: &Level) {
        let (c, s, d) = (axis.cos, axis.sin, axis.step as f32);
        // Frame (x right, y down) to the grid: u along the axis (in steps), v across it.
        let to_grid = |x: f32, y: f32| ((x * c - y * s) / d, x * s + y * c);
        let (fx0, fy0) = (corner.0 as f32, corner.1 as f32);
        let (fx1, fy1) = (fx0 + (bright.w - 1) as f32, fy0 + (bright.h - 1) as f32);
        let corners = [(fx0, fy0), (fx1, fy0), (fx0, fy1), (fx1, fy1)].map(|(x, y)| to_grid(x, y));
        let u0 = corners.iter().map(|p| p.0).fold(f32::MAX, f32::min).floor() - 1.0;
        let v0 = corners.iter().map(|p| p.1).fold(f32::MAX, f32::min).floor() - 1.0;
        let u1 = corners.iter().map(|p| p.0).fold(f32::MIN, f32::max).ceil() + 1.0;
        let v1 = corners.iter().map(|p| p.1).fold(f32::MIN, f32::max).ceil() + 1.0;
        let (gw, gh) = ((u1 - u0) as usize + 1, (v1 - v0) as usize + 1);

        let mut grid = vec![[0.0f32; 3]; gw * gh];
        for (by, row) in bright.px.chunks_exact(bright.w).enumerate() {
            for (bx, p) in row.iter().enumerate() {
                if *p == [0.0; 3] {
                    continue;
                }
                let (u, v) = to_grid(fx0 + bx as f32, fy0 + by as f32);
                let (u, v) = (u - u0, v - v0);
                let (i, j) = (u as usize, v as usize);
                let (tu, tv) = (u - i as f32, v - j as f32);
                for (k, wk) in [(j * gw + i, (1.0 - tu) * (1.0 - tv)), (j * gw + i + 1, tu * (1.0 - tv)), ((j + 1) * gw + i, (1.0 - tu) * tv), ((j + 1) * gw + i + 1, tu * tv)] {
                    let g = &mut grid[k];
                    (0..3).for_each(|ch| g[ch] += p[ch] * wk);
                }
            }
        }

        let mut sum = vec![[0.0f32; 3]; gw * gh];
        let mut blurred = grid.clone();
        for &(along, across, offset, weight) in &axis.octaves {
            blurred.copy_from_slice(&grid);
            filters::box_blur_rgb_xy(&mut blurred, gw, gh, along, across);
            // A grid point holds the light of `step` pixels.
            let gain = self.gain.map(|g| g * weight / d);
            // Moved `offset` along the axis (a motion glow's trail), between grid points.
            let (whole, t) = (offset.floor() as usize, offset.fract());
            for (out, src) in sum.chunks_exact_mut(gw).zip(blurred.chunks_exact(gw)) {
                for i in whole..gw {
                    let a = src[i - whole];
                    let b = if i > whole { src[i - whole - 1] } else { a };
                    (0..3).for_each(|k| out[i][k] += gain[k] * (a[k] + (b[k] - a[k]) * t));
                }
            }
        }

        // Back to the frame, over the box (no light reaches further).
        let sum = Level { w: gw, h: gh, px: sum };
        let (ox, oy) = origin;
        let (w, h) = (img.width, img.height);
        let (ix0, iy0) = (corner.0.saturating_sub(ox), corner.1.saturating_sub(oy));
        let (ix1, iy1) = ((corner.0 + bright.w - ox).min(w), (corner.1 + bright.h - oy).min(h));
        for y in iy0..iy1 {
            for x in ix0..ix1 {
                let (u, v) = to_grid((ox + x) as f32, (oy + y) as f32);
                let g = bilinear(&sum, u - u0, v - v0);
                let p = &mut img.pixels[y * w + x];
                (0..3).for_each(|k| p[k] += g[k]);
            }
        }
    }

    /// The smallest box `[x0, y0, x1, y1]` (inclusive) around the pixels above the
    /// threshold, if any.
    fn bright_box(&self, img: &Image) -> Option<[usize; 4]> {
        let floor = self.threshold - self.knee;
        let above = |p: &Rgb| p[0].max(p[1]).max(p[2]) > floor;
        let mut b: Option<[usize; 4]> = None;
        for (y, row) in img.pixels.chunks_exact(img.width).enumerate() {
            let Some(first) = row.iter().position(above) else { continue };
            let last = row.iter().rposition(above).unwrap_or(first);
            b = Some(match b {
                None => [first, y, last, y],
                Some([x0, y0, x1, _]) => [x0.min(first), y0, x1.max(last), y],
            });
        }
        b
    }
}

/// A copy of the bright pass, reduced or not.
#[derive(Clone)]
struct Level {
    w: usize,
    h: usize,
    px: Vec<Rgb>,
}

impl Level {
    /// 2×2 averages (sizes are even, whole cells).
    fn half(&self) -> Level {
        let (w, h) = (self.w / 2, self.h / 2);
        let px = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .map(|(x, y)| {
                let (a, b) = (&self.px[2 * y * self.w..][..self.w], &self.px[(2 * y + 1) * self.w..][..self.w]);
                std::array::from_fn(|c| 0.25 * (a[2 * x][c] + a[2 * x + 1][c] + b[2 * x][c] + b[2 * x + 1][c]))
            })
            .collect();
        Level { w, h, px }
    }
}

/// `level` at `(x, y)`, between its pixels (edges repeated past it).
fn bilinear(level: &Level, x: f32, y: f32) -> Rgb {
    let x = x.clamp(0.0, (level.w - 1) as f32);
    let y = y.clamp(0.0, (level.h - 1) as f32);
    let (x0, y0) = (x as usize, y as usize);
    let (x1, y1) = ((x0 + 1).min(level.w - 1), (y0 + 1).min(level.h - 1));
    let (tx, ty) = (x - x0 as f32, y - y0 as f32);
    let at = |x: usize, y: usize| level.px[y * level.w + x];
    let (a, b, c, d) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
    std::array::from_fn(|k| {
        let top = a[k] + (b[k] - a[k]) * tx;
        let bottom = c[k] + (d[k] - c[k]) * tx;
        top + (bottom - top) * ty
    })
}

/// The tint: white desaturated towards the hue (HSV, in the working space's primaries),
/// with luminance 1.
fn tint(hue: f32, saturation: f32) -> Rgb {
    let h = hue.rem_euclid(360.0) / 60.0;
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    let pure = match h as u32 {
        0 => [1.0, x, 0.0],
        1 => [x, 1.0, 0.0],
        2 => [0.0, 1.0, x],
        3 => [0.0, x, 1.0],
        4 => [x, 0.0, 1.0],
        _ => [1.0, 0.0, x],
    };
    let s = saturation.clamp(0.0, 1.0);
    let c = pure.map(|p| 1.0 - s + s * p);
    let y = luminance(c);
    c.map(|v| v / y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(p: Glow) -> GlowOp {
        GlowOp::new(&p, 1.0)
    }

    #[test]
    fn soft_knee_is_continuous() {
        let g = op(Glow { threshold: 0.0, softness: 0.5, ..Glow::default() });
        let (t, k) = (GREY, 0.5 * GREY);
        let e = |v: f32| g.bright([v; 3])[0];
        assert_eq!(e(t - k), 0.0);
        assert_eq!(e(0.5 * t), 0.0);
        assert!((e(t - k + 1e-4)).abs() < 1e-5);
        assert!((e(t + k - 1e-5) - k).abs() < 1e-4, "{}", e(t + k - 1e-5));
        assert!((e(t + k + 1e-5) - k).abs() < 1e-4);
        assert!((e(4.0) - (4.0 - t)).abs() < 1e-5);
        // A hard threshold.
        let hard = op(Glow { threshold: 0.0, softness: 0.0, ..Glow::default() });
        assert_eq!(hard.bright([GREY; 3]), [0.0; 3]);
        assert!((hard.bright([1.0; 3])[0] - (1.0 - GREY)).abs() < 1e-6);
    }

    #[test]
    fn bright_pass_keeps_the_colour_and_reads_the_brightest_channel() {
        let g = op(Glow { threshold: 0.0, softness: 0.0, ..Glow::default() });
        // A saturated red light glows, in red.
        let b = g.bright([2.0, 0.2, 0.0]);
        assert!(b[0] > 1.0 && (b[1] / b[0] - 0.1).abs() < 1e-6 && b[2] == 0.0, "{b:?}");
    }

    #[test]
    fn tint_has_luminance_one() {
        for (h, s) in [(0.0, 0.0), (20.0, 0.8), (200.0, 1.0), (-30.0, 0.5)] {
            assert!((luminance(tint(h, s)) - 1.0).abs() < 1e-5);
        }
        assert!(tint(123.0, 0.0).iter().all(|c| (c - 1.0).abs() < 1e-5));
        let red = tint(0.0, 1.0);
        assert!(red[1] == 0.0 && red[2] == 0.0);
    }

    #[test]
    fn glow_spreads_light_from_highlights_only() {
        let (w, h) = (101, 101);
        let mut img = Image { width: w, height: h, pixels: vec![[0.1; 3]; w * h] };
        img.pixels[50 * w + 50] = [100.0; 3];
        let before = img.clone();
        let g = op(Glow { threshold: 2.0, softness: 0.0, radius: 8.0, strength: 1.0, hue: 0.0, saturation: 1.0, ..Glow::default() });
        g.apply(&mut img, (0, 0));
        // Light around the highlight, in the tint's colour (red), falling off.
        let near = img.get(53, 50);
        let far = img.get(62, 50);
        assert!(near[0] - 0.1 > far[0] - 0.1 && far[0] > 0.1, "{near:?} {far:?}");
        assert_eq!(near[1], 0.1);
        // Its total is strength × the light above the threshold (× the tint's red).
        let added: f32 = img.pixels.iter().zip(&before.pixels).map(|(a, b)| a[0] - b[0]).sum();
        let expected = (100.0 - GREY * 4.0) * tint(0.0, 1.0)[0];
        assert!((added / expected - 1.0).abs() < 0.01, "{added} {expected}");
        // Nothing under the threshold glows.
        let mut dim = Image { width: w, height: h, pixels: vec![[0.5; 3]; w * h] };
        g.apply(&mut dim, (0, 0));
        assert!(dim.pixels.iter().all(|p| *p == [0.5; 3]));
    }

    #[test]
    fn blurring_around_the_light_only_changes_nothing() {
        // With a second light in a corner, the blurs cover the whole image: the glow of
        // the first one is the same.
        let (w, h) = (300, 200);
        let mut one = Image { width: w, height: h, pixels: vec![[0.05; 3]; w * h] };
        for y in 90..100 {
            one.pixels[y * w + 140..y * w + 150].fill([3.0, 2.0, 1.0]);
        }
        let mut two = one.clone();
        two.pixels[0] = [4.0; 3];
        let g = op(Glow { radius: 12.0, strength: 2.0, ..Glow::default() });
        g.apply(&mut one, (0, 0));
        g.apply(&mut two, (0, 0));
        assert!(one.pixels[95 * w + 130][0] > 0.06, "{:?}", one.pixels[95 * w + 130]);
        for y in 40..h {
            for x in 60..w {
                let (a, b) = (one.get(x, y), two.get(x, y));
                assert!((0..3).all(|c| (a[c] - b[c]).abs() < 1e-4), "{x},{y}: {a:?} {b:?}");
            }
        }
    }

    #[test]
    fn a_region_gets_the_same_glow() {
        let (w, h) = (500, 400);
        let mut whole = Image { width: w, height: h, pixels: vec![[0.05; 3]; w * h] };
        for (x, y) in [(200, 180), (260, 230), (330, 170)] {
            for j in y..y + 6 {
                whole.pixels[j * w + x..j * w + x + 8].fill([3.0, 2.0, 1.5]);
            }
        }
        let g = op(Glow { radius: 20.0, strength: 2.0, ..Glow::default() });
        let reach = g.reach();
        // A region with its margin, from an odd place.
        let (rx, ry, rw, rh) = (101, 77, 333, 281);
        let mut part = whole.crop(crate::image::Region { x: rx, y: ry, width: rw, height: rh });
        g.apply(&mut whole, (0, 0));
        g.apply(&mut part, (rx, ry));
        assert!(reach < 100, "{reach}");
        let mut worst = 0.0f32;
        for y in reach..rh - reach {
            for x in reach..rw - reach {
                let (a, b) = (part.get(x, y), whole.get(rx + x, ry + y));
                worst = (0..3).fold(worst, |m, c| m.max((a[c] - b[c]).abs()));
            }
        }
        assert!(worst < 1e-4, "{worst}");
        assert!(whole.get(215, 195)[0] > 0.06, "{:?}", whole.get(215, 195));
    }

    #[test]
    fn falloff_tightens_or_spreads_the_glow_and_keeps_its_total() {
        let (w, h) = (161, 161);
        let glow = |falloff: f32| {
            let mut img = Image { width: w, height: h, pixels: vec![[0.0; 3]; w * h] };
            img.pixels[80 * w + 80] = [100.0; 3];
            op(Glow { threshold: 2.0, softness: 0.0, radius: 16.0, strength: 1.0, falloff, ..Glow::default() }).apply(&mut img, (0, 0));
            img.pixels[80 * w + 80][1] -= 100.0;
            img
        };
        let (tight, even, long) = (glow(-1.0), glow(0.0), glow(1.0));
        let total = |i: &Image| i.pixels.iter().map(|p| p[1]).sum::<f32>();
        for i in [&tight, &even, &long] {
            assert!((total(i) / total(&even) - 1.0).abs() < 1e-3);
        }
        // Near the light, the tight one is brightest; far away, the long one.
        let (near, far) = (|i: &Image| i.get(83, 80)[1], |i: &Image| i.get(120, 80)[1]);
        assert!(near(&tight) > near(&even) && near(&even) > near(&long));
        assert!(far(&long) > far(&even) && far(&even) > far(&tight));
    }

    /// A single light in the middle of a dark frame, glowing with `p` (green: the glow
    /// alone), 16 px wide unless `p` says otherwise.
    fn one_light(p: Glow) -> Image {
        let radius = if p.radius == Glow::default().radius { 16.0 } else { p.radius };
        let (w, h) = (201, 201);
        let mut img = Image { width: w, height: h, pixels: vec![[0.0; 3]; w * h] };
        img.pixels[100 * w + 100] = [100.0; 3];
        op(Glow { threshold: 2.0, softness: 0.0, radius, strength: 1.0, ..p }).apply(&mut img, (0, 0));
        img.pixels[100 * w + 100][1] -= 100.0;
        img
    }

    #[test]
    fn a_streak_spreads_along_its_axis_and_keeps_the_total() {
        let total = |i: &Image| i.pixels.iter().map(|p| p[1]).sum::<f32>();
        let round = one_light(Glow::default());
        let flat = one_light(Glow { shape: GlowShape::Streak, thickness: 0.05, ..Glow::default() });
        assert!((total(&flat) / total(&round) - 1.0).abs() < 0.01, "{} {}", total(&flat), total(&round));
        // Along (both ways alike), and hardly across.
        let g = |x: usize, y: usize| flat.get(x, y)[1];
        assert!(g(130, 100) > 50.0 * g(100, 130), "{} {}", g(130, 100), g(100, 130));
        assert!((g(130, 100) / g(70, 100) - 1.0).abs() < 1e-3);
        // Turned a quarter: vertical.
        let up = one_light(Glow { shape: GlowShape::Streak, angle: 90.0, ..Glow::default() });
        assert!((up.get(100, 130)[1] / g(130, 100) - 1.0).abs() < 1e-3, "{} {}", up.get(100, 130)[1], g(130, 100));
    }

    #[test]
    fn a_motion_glow_trails_one_way() {
        // 90°: up the frame.
        let img = one_light(Glow { shape: GlowShape::Motion, angle: 90.0, ..Glow::default() });
        let g = |x: usize, y: usize| img.get(x, y)[1];
        assert!(g(100, 80) > 20.0 * g(100, 120), "{} {}", g(100, 80), g(100, 120));
        assert!(g(100, 80) > 20.0 * g(120, 100), "{} {}", g(100, 80), g(120, 100));
        assert!(g(100, 90) > g(100, 70), "{} {}", g(100, 90), g(100, 70));
    }

    #[test]
    fn a_region_gets_the_same_streak() {
        const REGION: (usize, usize, usize, usize) = (0, 0, 850, 750);
        let (w, h) = (900, 800);
        let mut whole = Image { width: w, height: h, pixels: vec![[0.05; 3]; w * h] };
        for (x, y) in [(400, 380), (460, 430), (530, 370)] {
            for j in y..y + 6 {
                whole.pixels[j * w + x..j * w + x + 8].fill([3.0, 2.0, 1.5]);
            }
        }
        // A grid as fine as the frame's pixels, and a coarser one.
        for (shape, radius) in [(GlowShape::Streak, 100.0)].into_iter().chain( [(GlowShape::Streak, 20.0), (GlowShape::Motion, 20.0), (GlowShape::Streak, 80.0), (GlowShape::Motion, 90.0)]) {
            let mut whole = whole.clone();
            for angle in [33.0, -125.0, 160.0, -60.0] {
            let mut whole = whole.clone();
            let g = op(Glow { radius, strength: 2.0, shape, angle, thickness: 0.1, ..Glow::default() });
            let reach = g.reach();
            let (rx, ry, rw, rh) = REGION;
            let mut part = whole.crop(crate::image::Region { x: rx, y: ry, width: rw, height: rh });
            g.apply(&mut whole, (0, 0));
            g.apply(&mut part, (rx, ry));
            assert!(reach < 350, "{reach}");
            let mut worst = 0.0f32;
            for y in reach..rh - reach {
                for x in reach..rw - reach {
                    let (a, b) = (part.get(x, y), whole.get(rx + x, ry + y));
                    worst = (0..3).fold(worst, |m, c| m.max((a[c] - b[c]).abs()));
                }
            }
            assert!(worst < 1e-4, "{shape:?} {radius} {angle}: {worst}");
            }
        }
    }

    #[test]
    fn a_coarse_grid_keeps_the_streak() {
        // Long enough for the grid to be coarser than the pixels along the axis: the light
        // along the row is still the four Gaussians'.
        let (w, h) = (801, 41);
        let mut img = Image { width: w, height: h, pixels: vec![[0.0; 3]; w * h] };
        img.pixels[20 * w + 400] = [100.0; 3];
        let p = Glow { threshold: 2.0, softness: 0.0, radius: 80.0, strength: 1.0, shape: GlowShape::Streak, thickness: 0.0, ..Glow::default() };
        assert!(op(p).axis.unwrap().step >= 4);
        op(p).apply(&mut img, (0, 0));
        let light = 100.0 - GREY * 4.0;
        let gauss = |x: f32, s: f32| (-0.5 * x * x / (s * s)).exp() / (s * (2.0 * std::f32::consts::PI).sqrt());
        // Three box blurs make a Gaussian's tail a little off, beyond 1.5 sigma.
        for (x, within) in [(5.0, 0.08), (20.0, 0.08), (60.0, 0.08), (150.0, 0.15)] {
            let expected = light * (0..4).map(|i| 0.25 * gauss(x, 80.0 / (1 << i) as f32)).sum::<f32>();
            let got = img.get(400 + x as usize, 20)[1];
            assert!((got / expected - 1.0).abs() < within, "{x}: {got} {expected}");
        }
    }

    #[test]
    fn off_without_strength() {
        assert!(!op(Glow { strength: 0.0, ..Glow::default() }).active());
        assert!(op(Glow::default()).active());
        assert_eq!(op(Glow { radius: 0.0, ..Glow::default() }).reach(), 0);
        assert!(op(Glow::default()).reach() >= 2 * 60, "{}", op(Glow::default()).reach());
    }
}
