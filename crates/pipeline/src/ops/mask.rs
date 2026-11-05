//! Masks (roadmap 4.5): where a module instance applies, 0 … 1 per pixel. The
//! instance's output is blended with its input by that amount.
//!
//! A mask ([`params::Mask`]) has two parts, multiplied together, then feathered:
//!
//! * **Drawn**: shapes of the recipe (`crate::shapes`), combined with union,
//!   intersection, difference or exclusion. They live in the sensor frame, so they are
//!   rasterised there (at the render's scale) and resampled through the geometry stage
//!   like the image. That depends only on the shapes and the geometry, so the developer
//!   caches it with the spatial stages ([`MaskPlane`]) and point renders read it per pixel.
//! * **Parametric**: smooth ranges of luminance, saturation, hue and each RGB channel,
//!   measured on the module's input pixel by pixel ([`MaskStage`]).
//!
//! The feather is a blur, or an edge-aware guided filter (He et al.) steered by the log
//! luminance of the image under the mask. It needs neighbours, so:
//!
//! * a mask without ranges feathers its drawn part, guided by the geometry stage, and
//!   its plane is cached with the drawn part's; the ranges (none), invert and opacity
//!   stay in the fused point pass;
//! * a mask with ranges and a feather ([`params::Mask::feathers_whole`]) is computed
//!   whole by the developer, on the module's input: for a point module, the spatial
//!   image through the point modules before it. Its plane is the mask itself, keyed by
//!   those modules, so editing them (or the ranges) re-renders like a spatial edit.
//!
//! Then the mask is inverted if asked, and scaled by its opacity, per pixel.
//!
//! Deviation from Ansel's masks: saturation and hue are measured in CIE 1976 u′v′
//! (exposure-invariant and cheap) rather than JzAzBz.

use serde::Serialize;

use super::filters;
use super::lut::{BitsLut, CEILING, FINE, FLOOR, log2_fast};
use crate::color::{self, MIDDLE_GREY, luminance};
use crate::image::{Image, Region, Rgb};
use crate::params::{self, EditParams, ModuleInstance, ShapeOp};
use crate::shapes::Shape;

/// Below this saturation (`s_uv`), hues fade out: greys have none.
const NEUTRAL_SATURATION: f32 = 0.1;

/// The guided filter's regularisation, in EV²: edges with less contrast than about
/// 0.1 EV are smoothed over.
const GUIDED_EPS: f32 = 0.01;

/// A drawn part's alpha over a render: the [`DrawnPlane`]s of the developer's spatial
/// image, by instance id, in the same pixels as that image.
#[derive(Clone, Debug)]
pub struct MaskPlane {
    pub id: String,
    /// Row-major, 0 … 1.
    pub alpha: Vec<f32>,
}

impl MaskPlane {
    /// Rows `y0..y1` of a plane `width` pixels wide.
    pub fn rows(&self, width: usize, y0: usize, y1: usize) -> MaskPlane {
        MaskPlane { id: self.id.clone(), alpha: self.alpha[y0 * width..y1 * width].to_vec() }
    }

    /// `region` of a plane `width` pixels wide.
    pub fn crop(&self, width: usize, region: Region) -> MaskPlane {
        let alpha = (region.y..region.bottom()).flat_map(|y| &self.alpha[y * width + region.x..y * width + region.right()]).copied().collect();
        MaskPlane { id: self.id.clone(), alpha }
    }
}

/// The instance's mask, if it has one that does anything.
pub fn active(m: &ModuleInstance) -> Option<&params::Mask> {
    m.mask.as_ref().filter(|mask| m.module.kind().maskable() && !mask.is_identity())
}

/// The drawn part of a mask, resolved: what its plane is built from (and keyed by).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Drawn {
    pub shapes: Vec<(Shape, ShapeOp)>,
    /// Full-resolution pixels.
    pub feather: f32,
    pub edge_aware: bool,
}

impl Drawn {
    /// The drawn part of `mask` with the recipe's shapes, or `None` without shapes (it
    /// is then 1 everywhere). Missing shapes are skipped. A mask feathered whole leaves
    /// its drawn part as drawn (the feather comes after the ranges).
    pub fn of(params: &EditParams, mask: &params::Mask) -> Option<Drawn> {
        let shapes: Vec<_> = mask.drawn.iter().filter_map(|d| Some((params.shapes.get(&d.shape)?.clone(), d.op))).collect();
        let feather = if mask.feathers_whole() { 0.0 } else { mask.feather.max(0.0) };
        (!shapes.is_empty()).then(|| Drawn { shapes, feather, edge_aware: mask.edge_aware })
    }

    /// How far the feathering reads around each pixel, in output pixels at `scale`.
    pub fn margin(&self, scale: f32) -> usize {
        feather_margin(self.feather, self.edge_aware, scale)
    }
}

/// Box radius of the guided filter, or Gaussian sigma, in output pixels at `scale`; 0
/// for no feathering. Either spreads an edge over about the feather's width.
fn spread(feather: f32, scale: f32) -> f32 {
    let s = feather.max(0.0) * scale / 2.0;
    if s < 0.25 { 0.0 } else { s }
}

/// How far a feather (full-resolution pixels) reads around each pixel, in output pixels at `scale`.
pub fn feather_margin(feather: f32, edge_aware: bool, scale: f32) -> usize {
    let s = spread(feather, scale);
    if s == 0.0 {
        0
    } else if edge_aware {
        // Two box filters, each of radius ⌈s⌉.
        2 * (s.ceil() as usize)
    } else {
        filters::reach(s)
    }
}

/// The drawn masks of the recipe's enabled, masked instances, by id, in pipeline order.
pub fn drawn_masks(params: &EditParams) -> Vec<(String, Drawn)> {
    params.modules.iter().filter(|m| m.enabled).filter_map(|m| Some((m.id.clone(), Drawn::of(params, active(m)?)?))).collect()
}

/// Where a drawn mask is rasterised: the sensor frame at the render's scale, so that
/// whole and region renders at the same size get the same pixels.
pub fn raster_frame(sensor: (usize, usize), scale: f32) -> (usize, usize) {
    let side = |v: usize| ((v as f32 * scale).ceil() as usize).max(1);
    (side(sensor.0), side(sensor.1))
}

/// The combined alpha of `drawn`'s shapes in a `frame`-sized raster, over the part of
/// `clip` where any may be non-zero: `(region, alpha)`, or `None` if that is empty.
pub fn rasterize(drawn: &Drawn, frame: (usize, usize), clip: Region) -> Option<(Region, Vec<f32>)> {
    // Every op keeps the result within the shapes' union (the first one starts it).
    let region = drawn.shapes.iter().filter_map(|(s, _)| s.bounds(frame)).reduce(|a, b| a.union(&b))?.intersect(&clip)?;
    let mut acc = vec![0.0f32; region.width * region.height];
    for (i, (shape, op)) in drawn.shapes.iter().enumerate() {
        let op = if i == 0 { ShapeOp::Union } else { *op };
        let raster = shape.rasterize_in(frame, region);
        // The shape's alpha at each pixel of `region` (0 outside its raster).
        let b_at = |x: usize, y: usize| match &raster {
            Some(r) if x >= r.region.x && y >= r.region.y && x < r.region.right() && y < r.region.bottom() => r.at(x, y),
            _ => 0.0,
        };
        // Union, difference and exclusion leave `a` alone where the shape is 0.
        let visit = if op == ShapeOp::Intersection { Some(region) } else { raster.as_ref().map(|r| r.region) };
        let Some(visit) = visit else { continue };
        for y in visit.y..visit.bottom() {
            for x in visit.x..visit.right() {
                let k = (y - region.y) * region.width + (x - region.x);
                let (a, b) = (acc[k], b_at(x, y));
                acc[k] = match op {
                    ShapeOp::Union => a.max(b),
                    ShapeOp::Intersection => a * b,
                    ShapeOp::Difference => a * (1.0 - b),
                    ShapeOp::Exclusion => a + b - 2.0 * a * b,
                };
            }
        }
    }
    Some((region, acc))
}

/// Feather a mask's `plane` by `feather` full-resolution pixels (the plane is the same
/// size as `guide`, which steers edge-aware feathering), at `scale` (output pixels per
/// full-resolution pixel), and clamp it to 0 … 1.
pub fn feather(plane: &mut [f32], guide: &Image, feather: f32, edge_aware: bool, scale: f32) {
    let (w, h) = (guide.width, guide.height);
    debug_assert_eq!(plane.len(), w * h);
    let s = spread(feather, scale);
    if s > 0.0 && w > 0 && h > 0 {
        if edge_aware {
            guided_filter(plane, guide, s.ceil() as usize);
        } else {
            filters::blur_plane(plane, w, h, s);
        }
    }
    plane.iter_mut().for_each(|a| *a = a.clamp(0.0, 1.0));
}

/// He et al.'s guided filter of `p` (in place) by the log luminance of `guide`, with
/// box windows of radius `r`: the output is locally an affine function of the guide,
/// so it follows the image's edges and is smooth elsewhere.
fn guided_filter(p: &mut [f32], guide: &Image, r: usize) {
    let (w, h) = (guide.width, guide.height);
    let floor = MIDDLE_GREY * (-12.0f32).exp2();
    let grey = MIDDLE_GREY.log2();
    // Centred on middle grey, which keeps the squares small for f32.
    let i: Vec<f32> = guide.pixels.iter().map(|px| log2_fast(luminance(*px).max(floor)) - grey).collect();
    let mean_i = box_mean(&i, w, h, r);
    let mean_p = box_mean(p, w, h, r);
    let corr_ii = box_mean(&i.iter().map(|v| v * v).collect::<Vec<_>>(), w, h, r);
    let corr_ip = box_mean(&i.iter().zip(p.iter()).map(|(a, b)| a * b).collect::<Vec<_>>(), w, h, r);
    let mut a = vec![0.0f32; w * h];
    let mut b = vec![0.0f32; w * h];
    for k in 0..w * h {
        let var = (corr_ii[k] - mean_i[k] * mean_i[k]).max(0.0);
        let cov = corr_ip[k] - mean_i[k] * mean_p[k];
        a[k] = cov / (var + GUIDED_EPS);
        b[k] = mean_p[k] - a[k] * mean_i[k];
    }
    let (mean_a, mean_b) = (box_mean(&a, w, h, r), box_mean(&b, w, h, r));
    for k in 0..w * h {
        p[k] = mean_a[k] * i[k] + mean_b[k];
    }
}

/// The mean of `v` over the window of radius `r` around each pixel, clipped to the
/// image. Sums are kept in f64, and both passes go along rows (cache friendly).
fn box_mean(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    // Horizontal: prefix sums along each row.
    let mut rows = vec![0.0f32; w * h];
    let mut line = vec![0.0f64; w + 1];
    for (src, dst) in v.chunks_exact(w).zip(rows.chunks_exact_mut(w)) {
        for x in 0..w {
            line[x + 1] = line[x] + src[x] as f64;
        }
        for (x, d) in dst.iter_mut().enumerate() {
            let (lo, hi) = (x.saturating_sub(r), (x + r + 1).min(w));
            *d = ((line[hi] - line[lo]) / (hi - lo) as f64) as f32;
        }
    }
    // Vertical: a running sum per column over a window of rows.
    let mut out = vec![0.0f32; w * h];
    let mut acc = vec![0.0f64; w];
    let row = |y: usize| &rows[y * w..(y + 1) * w];
    for y in 0..r.min(h) {
        acc.iter_mut().zip(row(y)).for_each(|(a, v)| *a += *v as f64);
    }
    for y in 0..h {
        if y + r < h {
            acc.iter_mut().zip(row(y + r)).for_each(|(a, v)| *a += *v as f64);
        }
        if y > r {
            acc.iter_mut().zip(row(y - r - 1)).for_each(|(a, v)| *a -= *v as f64);
        }
        let n = ((y + r + 1).min(h) - y.saturating_sub(r)) as f64;
        out[y * w..(y + 1) * w].iter_mut().zip(&acc).for_each(|(o, a)| *o = (*a / n) as f32);
    }
    out
}

/// A feathered range `[a, b, c, d]`, made non-decreasing.
#[derive(Clone, Copy, Debug)]
struct Range([f32; 4]);

impl Range {
    fn new([a, b, c, d]: [f32; 4]) -> Self {
        let b = b.max(a);
        let c = c.max(b);
        Range([a, b, c, d.max(c)])
    }

    /// Hue ranges wrap around: positions are taken in degrees from `a`.
    fn hue([a, b, c, d]: [f32; 4]) -> Self {
        let from = |v: f32| (v - a).rem_euclid(360.0);
        let r = Range::new([0.0, from(b), from(c), from(d)]);
        Range([a, r.0[1], r.0[2], r.0[3]])
    }

    #[inline]
    fn eval(&self, x: f32) -> f32 {
        let [a, b, c, d] = self.0;
        let t = if x < a || x > d {
            return 0.0;
        } else if x < b {
            (x - a) / (b - a)
        } else if x <= c {
            return 1.0;
        } else {
            (d - x) / (d - c)
        };
        t * t * (3.0 - 2.0 * t)
    }

    #[inline]
    fn eval_hue(&self, degrees: f32) -> f32 {
        let a = self.0[0];
        let x = (degrees - a).rem_euclid(360.0);
        Range([0.0, self.0[1], self.0[2], self.0[3]]).eval(x)
    }
}

/// Entries of the hue table, over the diamond angle (0 … 4).
const HUE_LUT: usize = 4096;

/// A monotonic stand-in for the angle of `(x, y)`, 0 … 4 (a quarter turn per unit),
/// without a trigonometric function: where the direction meets the diamond |x| + |y| = 1.
#[inline]
fn diamond_angle(y: f32, x: f32) -> f32 {
    let t = y / (x.abs() + y.abs());
    match (x >= 0.0, y >= 0.0) {
        (true, true) => t,
        (false, _) => 2.0 - t,
        (true, false) => 4.0 + t,
    }
}

/// The angle in degrees of the diamond angle `d` (inverse of [`diamond_angle`]).
fn diamond_to_degrees(d: f32) -> f32 {
    let (x, y) = if d < 1.0 {
        (1.0 - d, d)
    } else if d < 2.0 {
        (1.0 - d, 2.0 - d)
    } else if d < 3.0 {
        (1.0 - (4.0 - d), 2.0 - d)
    } else {
        (d - 3.0, d - 4.0)
    };
    atan2_degrees(y, x)
}

/// A mask's per-pixel part, compiled: the parametric ranges, invert and opacity.
pub struct MaskStage {
    luminance: Option<BitsLut<f32>>,
    /// Red, green and blue, each indexed by the channel's value.
    channels: [Option<BitsLut<f32>>; 3],
    saturation: Option<Range>,
    /// The hue range over the diamond angle of the pixel's direction from white in u′v′.
    hue: Option<Box<[f32; HUE_LUT + 1]>>,
    /// Rows giving `13·(u′ − u′white)·D`, `13·(v′ − v′white)·D` and `D = X + 15Y + 3Z`
    /// from linear Rec.2020.
    uv: [[f32; 3]; 3],
    invert: bool,
    opacity: f32,
    /// Its plane is the whole mask (before invert and opacity): it is feathered whole.
    complete: bool,
    /// Whether it reads a plane (its drawn part, or the whole mask).
    pub drawn: bool,
}

impl MaskStage {
    /// `drawn`: whether the mask has a drawn part (see [`Drawn::of`]).
    pub fn new(mask: &params::Mask, drawn: bool) -> Self {
        let complete = mask.feathers_whole();
        Self { complete, drawn: drawn || complete, ..Self::parametric(mask) }
    }

    /// The parametric part alone (times the drawn part given to [`eval`](Self::eval)),
    /// without invert and opacity: what a mask feathered whole is made from.
    pub fn parametric(mask: &params::Mask) -> Self {
        // Ranges in EV from middle grey, indexed by the linear value.
        let ev_lut = |r: [f32; 4]| {
            let r = Range::new(r);
            BitsLut::new(FLOOR, CEILING, FINE, move |y| r.eval((y / MIDDLE_GREY).log2()))
        };
        let luminance = mask.luminance.map(ev_lut);
        let channels = mask.channels().map(|r| r.map(ev_lut));
        let xyz = color::xyz_from_rec2020();
        let d = [0, 1, 2].map(|c| xyz[0][c] + 15.0 * xyz[1][c] + 3.0 * xyz[2][c]);
        let white = color::white_xyz();
        let dw = white[0] + 15.0 * white[1] + 3.0 * white[2];
        let (un, vn) = (4.0 * white[0] / dw, 9.0 * white[1] / dw);
        let uv = [[0, 1, 2].map(|c| 13.0 * (4.0 * xyz[0][c] - un * d[c])), [0, 1, 2].map(|c| 13.0 * (9.0 * xyz[1][c] - vn * d[c])), d];
        Self {
            luminance,
            channels,
            saturation: mask.saturation.map(Range::new),
            hue: mask.hue.map(|r| {
                let r = Range::hue(r);
                let mut lut = Box::new([0.0f32; HUE_LUT + 1]);
                for (k, v) in lut.iter_mut().enumerate() {
                    *v = r.eval_hue(diamond_to_degrees(k as f32 * 4.0 / HUE_LUT as f32));
                }
                lut
            }),
            uv,
            invert: mask.invert,
            opacity: mask.opacity.clamp(0.0, 1.0),
            complete: false,
            drawn: false,
        }
    }

    /// `parametric` with invert and opacity, as the developer gives them.
    pub fn finish(&self, m: f32) -> f32 {
        (if self.invert { 1.0 - m } else { m }) * self.opacity
    }

    /// The mask at a pixel whose input is `c`, with the drawn part's alpha `drawn` there
    /// (1 without a drawn part; the whole mask if it is feathered whole).
    #[inline]
    pub fn eval(&self, c: Rgb, drawn: f32) -> f32 {
        if self.complete {
            return self.finish(drawn);
        }
        let mut m = drawn;
        if let Some(lut) = &self.luminance {
            m *= lut.eval(luminance(c));
        }
        for (lut, v) in self.channels.iter().zip(c) {
            if let Some(lut) = lut {
                m *= lut.eval(v);
            }
        }
        if m > 0.0 && (self.saturation.is_some() || self.hue.is_some()) {
            let dot = |row: &[f32; 3]| row[0] * c[0] + row[1] * c[1] + row[2] * c[2];
            let d = dot(&self.uv[2]);
            let (du, dv) = if d > 1e-12 { (dot(&self.uv[0]) / d, dot(&self.uv[1]) / d) } else { (0.0, 0.0) };
            let s = (du * du + dv * dv).sqrt();
            if let Some(r) = &self.saturation {
                m *= r.eval(s);
            }
            if let Some(lut) = &self.hue {
                let at = if s > 0.0 { diamond_angle(dv, du) * (HUE_LUT as f32 / 4.0) } else { 0.0 };
                m *= lut[(at + 0.5) as usize] * (s / NEUTRAL_SATURATION).min(1.0);
            }
        }
        if self.invert {
            m = 1.0 - m;
        }
        m * self.opacity
    }

    /// [`eval`](Self::eval) for many pixels: `drawn` holds their drawn part (empty
    /// without one), `out` gets the mask.
    #[inline]
    pub fn eval_all(&self, pixels: &[Rgb], drawn: &[f32], out: &mut [f32]) {
        if drawn.is_empty() {
            out.iter_mut().zip(pixels).for_each(|(o, c)| *o = self.eval(*c, 1.0));
        } else {
            out.iter_mut().zip(pixels).zip(drawn).for_each(|((o, c), d)| *o = self.eval(*c, *d));
        }
    }

    /// The saturation (`s_uv`) and hue (degrees) a pixel is measured at.
    pub fn saturation_hue(&self, c: Rgb) -> (f32, f32) {
        let dot = |row: &[f32; 3]| row[0] * c[0] + row[1] * c[1] + row[2] * c[2];
        let d = dot(&self.uv[2]).max(1e-12);
        let (du, dv) = (dot(&self.uv[0]) / d, dot(&self.uv[1]) / d);
        ((du * du + dv * dv).sqrt(), atan2_degrees(dv, du))
    }
}

/// The colours of the mask sliders' tracks (`apps/web/src/develop/masks.ts`), which
/// the mask overlay paints a part's values in. CSS gradients interpolate sRGB-encoded
/// values, and so does this.
pub struct ValueColors {
    stage: MaskStage,
    /// Hue in whole degrees → colour.
    hues: Vec<[f32; 3]>,
}

impl Default for ValueColors {
    fn default() -> Self {
        Self::new()
    }
}

impl ValueColors {
    pub fn new() -> Self {
        let stage = MaskStage::parametric(&params::Mask::default());
        Self { stage, hues: (0..360).map(|d| hue_rgb(d as f32)).collect() }
    }

    /// Black at -8 EV, white at +3 EV (as filmic shows them, roughly).
    pub fn luminance(&self, c: Rgb) -> [u8; 3] {
        [ev_level(luminance(c)); 3]
    }

    /// Channel `i` of `c` on the luminance scale, from black to that channel's colour.
    pub fn channel(&self, c: Rgb, i: usize) -> [u8; 3] {
        let mut out = [0; 3];
        out[i] = ev_level(c[i]);
        out
    }

    /// Grey at 0, rust at 0.9, red-orange from 2.
    pub fn saturation(&self, c: Rgb) -> [u8; 3] {
        const STOPS: [(f32, [f32; 3]); 3] = [(0.0, [138.0, 138.0, 138.0]), (0.9, [196.0, 106.0, 60.0]), (2.0, [255.0, 58.0, 0.0])];
        let (s, _) = self.stage.saturation_hue(c);
        let s = s.clamp(0.0, 2.0);
        let i = if s < STOPS[1].0 { 0 } else { 1 };
        let ((a, ca), (b, cb)) = (STOPS[i], STOPS[i + 1]);
        let t = (s - a) / (b - a);
        [0, 1, 2].map(|k| (ca[k] + (cb[k] - ca[k]) * t + 0.5) as u8)
    }

    /// The hue's colour, fading to grey where there is none (greys).
    pub fn hue(&self, c: Rgb) -> [u8; 3] {
        let (s, h) = self.stage.saturation_hue(c);
        let rgb = self.hues[(h as usize).min(359)];
        let t = (s / NEUTRAL_SATURATION).min(1.0);
        rgb.map(|v| ((128.0 + (v - 128.0) * t) + 0.5) as u8)
    }
}

/// A linear value's level from black (-8 EV from middle grey) to white (+3 EV).
fn ev_level(v: f32) -> u8 {
    let ev = (v.max(1e-9) / MIDDLE_GREY).log2();
    (((ev + 8.0) / 11.0).clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// The colour of hue `degrees` (8-bit sRGB, as floats), as `hueCss` in TS gives it: a
/// colour 0.06 from white in u′v′ in that direction, scaled to its brightest channel.
fn hue_rgb(degrees: f32) -> [f32; 3] {
    let white = color::white_xyz();
    let d = white[0] + 15.0 * white[1] + 3.0 * white[2];
    let (un, vn) = (4.0 * white[0] / d, 9.0 * white[1] / d);
    let t = degrees.to_radians();
    let (u, v) = (un + 0.06 * t.cos(), vn + 0.06 * t.sin());
    let xyz = [9.0 * u / (4.0 * v), 1.0, (12.0 - 3.0 * u - 20.0 * v) / (4.0 * v)];
    let rgb = color::mul_vec(&color::REC709_FROM_XYZ, xyz).map(|c| c.max(0.0));
    let max = rgb[0].max(rgb[1]).max(rgb[2]).max(1e-9);
    rgb.map(|c| (color::srgb_oetf(c / max) * 255.0).round())
}

/// `atan2(y, x)` in degrees, 0 … 360, within about 0.01°, without a library call.
#[inline]
fn atan2_degrees(y: f32, x: f32) -> f32 {
    let (ax, ay) = (x.abs(), y.abs());
    let (lo, hi) = (ax.min(ay), ax.max(ay));
    if hi == 0.0 {
        return 0.0;
    }
    let t = lo / hi;
    let t2 = t * t;
    // Minimax polynomial for atan on [0, 1] (|error| < 1e-5 rad).
    let mut a = t * (0.999_866 + t2 * (-0.330_299_5 + t2 * (0.180_141 + t2 * (-0.085_133 + t2 * 0.020_835_1))));
    if ay > ax {
        a = std::f32::consts::FRAC_PI_2 - a;
    }
    if x < 0.0 {
        a = std::f32::consts::PI - a;
    }
    if y < 0.0 {
        a = -a;
    }
    let deg = a.to_degrees();
    if deg < 0.0 { deg + 360.0 } else { deg }
}

/// Blend `out` (a module's output) with `input` by mask value `m`.
#[inline]
pub fn blend(input: Rgb, out: Rgb, m: f32) -> Rgb {
    [input[0] + (out[0] - input[0]) * m, input[1] + (out[1] - input[1]) * m, input[2] + (out[2] - input[2]) * m]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::{REC2020_FROM_REC709, mul_vec};
    use crate::params::{DrawnShape, Mask};

    fn srgb(r: f32, g: f32, b: f32) -> Rgb {
        mul_vec(&REC2020_FROM_REC709, [r, g, b])
    }

    #[test]
    fn atan2_is_accurate() {
        for i in 0..720 {
            let a = (i as f32 * 0.5).to_radians();
            let (y, x) = a.sin_cos();
            let want = (y.atan2(x).to_degrees() + 360.0) % 360.0;
            let got = atan2_degrees(y * 3.0, x * 3.0);
            let diff = (got - want).abs().min(360.0 - (got - want).abs());
            assert!(diff < 0.01, "{i}: {got} vs {want}");
        }
    }

    #[test]
    fn channel_ranges_select_by_channel() {
        let reds = MaskStage::new(&Mask { red: Some([-1.0, 0.0, 3.0, 4.0]), ..Mask::default() }, false);
        assert!(reds.eval([MIDDLE_GREY, 0.0, 0.0], 1.0) > 0.99);
        assert_eq!(reds.eval([MIDDLE_GREY / 8.0, 1.0, 1.0], 1.0), 0.0);
        // Ranges multiply.
        let both = MaskStage::new(&Mask { red: Some([-1.0, 0.0, 3.0, 4.0]), blue: Some([-20.0, -20.0, -4.0, -3.0]), ..Mask::default() }, false);
        assert!(both.eval([MIDDLE_GREY, 0.1, 0.001], 1.0) > 0.99);
        assert_eq!(both.eval([MIDDLE_GREY, 0.1, MIDDLE_GREY], 1.0), 0.0);
        assert_eq!(ValueColors::new().channel([0.0, MIDDLE_GREY * 16.0, 0.0], 1), [0, 255, 0]);
    }

    #[test]
    fn value_colours_follow_the_tracks() {
        let colors = ValueColors::new();
        assert_eq!(colors.luminance([MIDDLE_GREY / 512.0; 3]), [0; 3]);
        assert_eq!(colors.luminance([MIDDLE_GREY * 16.0; 3]), [255; 3]);
        assert_eq!(colors.saturation([0.2; 3]), [138; 3]);
        assert_eq!(colors.hue([0.2; 3]), [128; 3], "greys have no hue");
        let [r, g, b] = colors.hue(srgb(0.6, 0.05, 0.03));
        assert!(r > g && r > b, "{r} {g} {b}");
        let [r, g, b] = colors.hue(srgb(0.03, 0.05, 0.6));
        assert!(b > r && b > g, "{r} {g} {b}");
    }

    #[test]
    fn diamond_angles_round_trip() {
        for i in 0..360 {
            let a = (i as f32 + 0.25).to_radians();
            let (y, x) = a.sin_cos();
            let back = diamond_to_degrees(diamond_angle(y, x));
            assert!((back - (i as f32 + 0.25)).abs() < 0.01, "{i}: {back}");
        }
    }

    #[test]
    fn ranges_are_feathered_trapezoids() {
        let r = Range::new([0.0, 1.0, 2.0, 4.0]);
        assert_eq!(r.eval(-0.1), 0.0);
        assert_eq!(r.eval(0.5), 0.5);
        assert_eq!(r.eval(1.5), 1.0);
        assert_eq!(r.eval(3.0), 0.5);
        assert_eq!(r.eval(4.1), 0.0);
        // Hard edges, and unsorted values.
        assert_eq!(Range::new([1.0, 1.0, 2.0, 2.0]).eval(1.0), 1.0);
        assert_eq!(Range::new([2.0, 1.0, 0.0, 3.0]).eval(2.5), 0.5);
        // Hue ranges wrap around.
        let h = Range::hue([340.0, 350.0, 10.0, 20.0]);
        assert_eq!(h.eval_hue(0.0), 1.0);
        assert_eq!(h.eval_hue(345.0), 0.5);
        assert_eq!(h.eval_hue(15.0), 0.5);
        assert_eq!(h.eval_hue(180.0), 0.0);
    }

    #[test]
    fn hues_and_saturations_of_known_colours() {
        let stage = MaskStage::new(&Mask::default(), false);
        let (grey_s, _) = stage.saturation_hue([0.18; 3]);
        assert!(grey_s < 1e-3, "{grey_s}");
        for (rgb, hue) in [((1.0, 0.0, 0.0), 12.0), ((1.0, 1.0, 0.0), 86.0), ((0.0, 1.0, 0.0), 128.0), ((0.0, 0.0, 1.0), 266.0)] {
            let (s, h) = stage.saturation_hue(srgb(rgb.0, rgb.1, rgb.2));
            assert!((h - hue).abs() < 3.0 && s > 1.0, "{rgb:?}: {h}° s {s}");
        }
        // Exposure-invariant.
        let skin = srgb(0.6, 0.32, 0.21);
        let (s1, h1) = stage.saturation_hue(skin);
        let (s2, h2) = stage.saturation_hue(skin.map(|v| v * 8.0));
        assert!((s1 - s2).abs() < 1e-4 && (h1 - h2).abs() < 1e-3);
        assert!(s1 > 0.4 && s1 < 0.8, "{s1}");
    }

    #[test]
    fn parametric_masks_select_by_luminance_and_hue() {
        let mask = Mask { luminance: Some([-1.0, 0.0, 2.0, 3.0]), ..Mask::default() };
        let stage = MaskStage::new(&mask, false);
        assert!(stage.eval([MIDDLE_GREY; 3], 1.0) > 0.99);
        assert_eq!(stage.eval([MIDDLE_GREY / 8.0; 3], 1.0), 0.0);
        assert!((stage.eval([MIDDLE_GREY / 2.0_f32.sqrt(); 3], 1.0) - 0.5).abs() < 0.02);
        // The drawn part multiplies; invert and opacity apply last.
        assert!((stage.eval([MIDDLE_GREY; 3], 0.25) - 0.25).abs() < 0.01);
        let inverted = MaskStage::new(&Mask { invert: true, opacity: 0.5, ..mask }, false);
        assert!((inverted.eval([MIDDLE_GREY / 8.0; 3], 1.0) - 0.5).abs() < 1e-6);

        let reds = MaskStage::new(&Mask { hue: Some([350.0, 0.0, 25.0, 40.0]), ..Mask::default() }, false);
        assert!(reds.eval(srgb(0.5, 0.05, 0.03), 1.0) > 0.99);
        assert_eq!(reds.eval(srgb(0.05, 0.05, 0.5), 1.0), 0.0);
        // Greys have no hue.
        assert_eq!(reds.eval([0.2, 0.2, 0.2], 1.0), 0.0);
    }

    fn circle(x: f32, y: f32, r: f32) -> Shape {
        Shape::Ellipse { center: [x, y], radii: [r, r], rotation: 0.0, feather: 0.0, opacity: 1.0 }
    }

    #[test]
    fn shapes_combine_with_their_ops() {
        let frame = (200, 100);
        let whole = Region::full(200, 100);
        let at = |d: &Drawn, x: usize, y: usize| {
            let (r, alpha) = rasterize(d, frame, whole).unwrap();
            if x < r.x || y < r.y || x >= r.right() || y >= r.bottom() { 0.0 } else { alpha[(y - r.y) * r.width + x - r.x] }
        };
        // 25 px radii, centred at x = 80 and 100.
        let drawn = |op: ShapeOp| Drawn { shapes: vec![(circle(0.4, 0.5, 0.25), ShapeOp::Difference), (circle(0.5, 0.5, 0.25), op)], feather: 0.0, edge_aware: false };
        // Left circle only, overlap, right circle only.
        let sample = |op| [60, 90, 120].map(|x| at(&drawn(op), x, 50));
        assert_eq!(sample(ShapeOp::Union), [1.0, 1.0, 1.0]);
        assert_eq!(sample(ShapeOp::Intersection), [0.0, 1.0, 0.0]);
        assert_eq!(sample(ShapeOp::Difference), [1.0, 0.0, 0.0]);
        assert_eq!(sample(ShapeOp::Exclusion), [1.0, 0.0, 1.0]);
        // A clipped raster has the same pixels.
        let d = drawn(ShapeOp::Exclusion);
        let (r, alpha) = rasterize(&d, frame, Region { x: 90, y: 40, width: 50, height: 20 }).unwrap();
        // …and stops where the shapes do (the right one ends at x = 125).
        assert_eq!(r, Region { x: 90, y: 40, width: 36, height: 20 });
        assert_eq!(alpha[10 * 36 + 30], at(&d, 120, 50));
        assert_eq!(alpha[10 * 36 + 30], 1.0);
    }

    #[test]
    fn guided_feathering_follows_edges() {
        // Dark left half, bright right half, and a hard mask edge on the image's edge.
        let (w, h) = (64, 16);
        let mut guide = Image::new(w, h);
        for (k, px) in guide.pixels.iter_mut().enumerate() {
            *px = if k % w < 32 { [0.02; 3] } else { [0.5; 3] };
        }
        let plane: Vec<f32> = (0..w * h).map(|k| if k % w >= 32 { 1.0 } else { 0.0 }).collect();
        let feathered = |edge_aware| {
            let mut p = plane.clone();
            feather(&mut p, &guide, 16.0, edge_aware, 1.0);
            p
        };
        let (guided, blurred) = (feathered(true), feathered(false));
        let row = 8 * w;
        // Both are in range. The blur spreads the edge over the feather; the guided filter
        // keeps it where the image's edge is.
        assert!(guided.iter().chain(&blurred).all(|v| (0.0..=1.0).contains(v)));
        assert!(blurred[row + 28] > 0.2 && blurred[row + 35] < 0.8, "{:?}", &blurred[row + 24..row + 40]);
        assert!(guided[row + 28] < 0.05 && guided[row + 35] > 0.95, "{:?}", &guided[row + 24..row + 40]);
    }

    #[test]
    fn drawn_skips_missing_shapes_and_identity_masks_are_inactive() {
        let mut p = EditParams::default();
        p.shapes.insert("a".into(), circle(0.5, 0.5, 0.1));
        let mask = Mask { drawn: vec![DrawnShape { shape: "a".into(), op: ShapeOp::Union }, DrawnShape { shape: "gone".into(), op: ShapeOp::Union }], ..Mask::default() };
        assert_eq!(Drawn::of(&p, &mask).unwrap().shapes.len(), 1);
        assert!(Drawn::of(&p, &Mask::default()).is_none());
        p.modules[0].mask = Some(Mask::default());
        assert!(active(&p.modules[0]).is_none());
        p.modules[0].mask = Some(Mask { opacity: 0.5, ..Mask::default() });
        assert!(active(&p.modules[0]).is_some());
        // Not on filmic.
        let last = p.modules.len() - 1;
        p.modules[last].mask = Some(Mask { opacity: 0.5, ..Mask::default() });
        assert!(active(&p.modules[last]).is_none());
    }
}
