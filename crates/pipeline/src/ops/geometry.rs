//! Lens correction, orientation, straightening, cropping and resampling — done in a
//! single inverse-mapping pass from output pixels back into the base image.
//!
//! Output pixel → (crop, straighten, orientation: affine) → lens-corrected sensor
//! frame → (lens correction: radial, per channel) → base image.

use crate::decode::Orient;
use crate::image::{Image, Mask, Region};
use crate::lens::{Correction, LensProfile};
use crate::params::{Crop, Lens};

/// Everything needed to map the (sensor-oriented) base image into the output frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    /// Strengths of the lens correction, if the file has a profile and it is enabled.
    pub lens: Option<Lens>,
    pub orient: Orient,
    /// Straighten angle, degrees, clockwise positive.
    pub angle: f32,
    pub crop: Crop,
}

impl Transform {
    /// Size of the oriented frame for a source of `w × h`.
    pub fn oriented_size(&self, w: f32, h: f32) -> (f32, f32) {
        if self.orient.swaps_axes() { (h, w) } else { (w, h) }
    }

    /// Size of the cropped region, in source pixels, for a source of `w × h`.
    pub fn cropped_size(&self, w: f32, h: f32) -> (f32, f32) {
        let (ow, oh) = self.oriented_size(w, h);
        let crop = self.crop.sanitized();
        (ow * crop.width, oh * crop.height)
    }

    /// Scale applied when straightening so that no empty corners show.
    fn straighten_scale(&self, ow: f32, oh: f32) -> f32 {
        let t = self.angle.to_radians().abs();
        let (s, c) = t.sin_cos();
        ((ow * c + oh * s) / ow).max((ow * s + oh * c) / oh)
    }
}

/// Output pixel → source pixel coordinates. The whole chain (crop, straighten,
/// orientation) is affine, so it is stored as an origin and two steps.
#[derive(Clone, Copy, Debug)]
struct Mapping {
    u0: f32,
    v0: f32,
    du_dx: f32,
    dv_dx: f32,
    du_dy: f32,
    dv_dy: f32,
}

impl Mapping {
    fn new(sw: f32, sh: f32, t: &Transform, out_w: usize, out_h: usize) -> Self {
        let (ow, oh) = t.oriented_size(sw, sh);
        let crop = t.crop.sanitized();
        let scale = t.straighten_scale(ow, oh);
        let (sin, cos) = (-t.angle.to_radians()).sin_cos();
        let (cx, cy) = (ow / 2.0, oh / 2.0);

        // Output pixel → base image, as a chain of maps that are each affine.
        let map = |x: f32, y: f32| -> (f32, f32) {
            let (fx, fy) = ((crop.x + x / out_w as f32 * crop.width) * ow, (crop.y + y / out_h as f32 * crop.height) * oh);
            // Output frame → oriented frame (undo straighten: rotate back and shrink).
            let (dx, dy) = ((fx - cx) / scale, (fy - cy) / scale);
            let (u, v) = (dx * cos - dy * sin + cx, dx * sin + dy * cos + cy);
            // Oriented frame → sensor frame (undo the quarter turns, then the flip).
            let (mut u, mut v, mut w, mut h) = (u, v, ow, oh);
            for _ in 0..t.orient.quarter_turns {
                // inverse of a clockwise turn: (u, v) in a w×h frame came from (v, w - u) in h×w.
                (u, v, w, h) = (v, w - u, h, w);
            }
            let _ = h;
            if t.orient.flip {
                u = w - u;
            }
            (u, v)
        };
        // …so the whole chain is affine: evaluate it once, then step through it.
        let (u0, v0) = map(0.0, 0.0);
        let (ux, vx) = map(1.0, 0.0);
        let (uy, vy) = map(0.0, 1.0);
        Self { u0, v0, du_dx: ux - u0, dv_dx: vx - v0, du_dy: uy - u0, dv_dy: vy - v0 }
    }

    #[inline]
    fn at(&self, x: f32, y: f32) -> (f32, f32) {
        (self.u0 + x * self.du_dx + y * self.du_dy, self.v0 + x * self.dv_dx + y * self.dv_dy)
    }
}

/// Maps points between the output frame and the sensor frame, both normalised (0 … 1
/// across the width and the height): the output frame is the oriented, straightened and
/// cropped image; the sensor frame is the base image, where shapes live
/// (`crate::shapes`). The developer's overlay draws shapes with it.
pub struct SensorMapping {
    width: f32,
    height: f32,
    /// Output (normalised) → lens-corrected sensor frame (pixels).
    map: Mapping,
    lens: Option<Correction>,
}

/// [`SensorMapping`] as data, for mirroring it in TypeScript (`packages/pipeline/src/shapes.ts`).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorMappingData {
    /// Sensor size in pixels.
    pub width: f32,
    pub height: f32,
    /// Output `(x, y)` (normalised) → `(u0 + x·a + y·c, v0 + x·b + y·d)`, sensor pixels
    /// before lens correction, as `[u0, v0, a, b, c, d]`.
    pub affine: [f32; 6],
    pub lens: Option<LensData>,
}

/// Lens distortion (green) as a radial table: a point at offset `d` from `(cx, cy)`
/// reads the source at `d · scale(|d|² · to_index)`, interpolated linearly.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LensData {
    pub cx: f32,
    pub cy: f32,
    pub to_index: f32,
    pub scale: Vec<f32>,
}

impl SensorMapping {
    /// For a sensor of `width × height` pixels.
    pub fn new(t: &Transform, profile: Option<&LensProfile>, width: f32, height: f32) -> Self {
        Self { width, height, map: Mapping::new(width, height, t, 1, 1), lens: correction(t, profile, width, height) }
    }

    /// The sensor position of an output position.
    pub fn to_sensor(&self, x: f32, y: f32) -> (f32, f32) {
        let (u, v) = self.map.at(x, y);
        let (u, v) = self.lens.as_ref().map_or((u, v), |l| l.map_green(u, v));
        (u / self.width, v / self.height)
    }

    /// The output position of a sensor position.
    pub fn from_sensor(&self, u: f32, v: f32) -> (f32, f32) {
        let (u, v) = (u * self.width, v * self.height);
        let (u, v) = self.lens.as_ref().map_or((u, v), |l| l.unmap_green(u, v));
        let m = &self.map;
        let det = m.du_dx * m.dv_dy - m.du_dy * m.dv_dx;
        let (du, dv) = (u - m.u0, v - m.v0);
        ((du * m.dv_dy - dv * m.du_dy) / det, (dv * m.du_dx - du * m.dv_dx) / det)
    }

    pub fn data(&self) -> SensorMappingData {
        let m = &self.map;
        SensorMappingData {
            width: self.width,
            height: self.height,
            affine: [m.u0, m.v0, m.du_dx, m.dv_dx, m.du_dy, m.dv_dy],
            lens: self.lens.as_ref().map(|l| {
                let (cx, cy, to_index, scale) = l.green_table();
                LensData { cx, cy, to_index, scale: scale.to_vec() }
            }),
        }
    }
}

fn correction(t: &Transform, profile: Option<&LensProfile>, sw: f32, sh: f32) -> Option<Correction> {
    Correction::new(profile?, t.lens.as_ref()?, sw, sh)
}

/// Render `out_w × out_h` pixels of the transformed `src`, corrected with `profile`
/// when `t.lens` asks for it.
pub fn apply(src: &Image, t: &Transform, profile: Option<&LensProfile>, out_w: usize, out_h: usize) -> Image {
    let whole = Region::full(src.width, src.height);
    apply_region(src, whole, (src.width, src.height), t, profile, out_w, out_h, Region::full(out_w, out_h))
}

/// `region` of [`apply`]'s output, from a patch of the base image: `src` holds pixels
/// `src_at` of a `base` sized image. The patch must cover [`source_bounds`].
#[allow(clippy::too_many_arguments)]
pub fn apply_region(
    src: &Image,
    src_at: Region,
    base: (usize, usize),
    t: &Transform,
    profile: Option<&LensProfile>,
    out_w: usize,
    out_h: usize,
    region: Region,
) -> Image {
    debug_assert_eq!((src.width, src.height), (src_at.width, src_at.height));
    let (sw, sh) = (base.0 as f32, base.1 as f32);
    let (ow, oh) = t.oriented_size(sw, sh);
    let crop = t.crop.sanitized();
    let m = Mapping::new(sw, sh, t, out_w, out_h);
    let at = Patch { x0: region.x as f32, y0: region.y as f32, u0: src_at.x as f32, v0: src_at.y as f32 };

    // Source pixels per output pixel. The base image is binned to within 2× of the
    // output, so plain bilinear is enough unless we shrink by more than 1.5×.
    let ratio = (crop.width * ow / out_w as f32).max(crop.height * oh / out_h as f32);
    let ss = if ratio > 1.5 { (ratio.ceil() as usize).clamp(2, 4) } else { 1 };
    let inv_ss = 1.0 / ss as f32;
    let norm = 1.0 / (ss * ss) as f32;

    let mut out = Image::new(region.width, region.height);
    if let Some(lens) = correction(t, profile, sw, sh) {
        apply_lens(src, &m, &lens, ss, at, &mut out);
        return out;
    }
    for (y, row) in out.pixels.chunks_exact_mut(region.width.max(1)).enumerate() {
        for (x, px) in row.iter_mut().enumerate() {
            let mut acc = [0.0f32; 3];
            for sy in 0..ss {
                for sx in 0..ss {
                    let fx = at.x0 + x as f32 + (sx as f32 + 0.5) * inv_ss;
                    let fy = at.y0 + y as f32 + (sy as f32 + 0.5) * inv_ss;
                    let (u, v) = m.at(fx, fy);
                    let s = src.sample_bilinear(u - at.u0, v - at.v0);
                    acc[0] += s[0];
                    acc[1] += s[1];
                    acc[2] += s[2];
                }
            }
            *px = acc.map(|a| a * norm);
        }
    }
    out
}

/// Offsets of a region render: output pixel `(x, y)` is `(x0 + x, y0 + y)` of the
/// whole output, and source position `(u, v)` is `(u - u0, v - v0)` in the patch.
#[derive(Clone, Copy)]
struct Patch {
    x0: f32,
    y0: f32,
    u0: f32,
    v0: f32,
}

/// The pixels of a `base` sized source that [`apply_region`] reads for `region`
/// (with a margin for the filters and lens correction's per-channel shifts).
pub fn source_bounds(base: (usize, usize), t: &Transform, profile: Option<&LensProfile>, out_w: usize, out_h: usize, region: Region) -> Region {
    let (sw, sh) = (base.0 as f32, base.1 as f32);
    let m = Mapping::new(sw, sh, t, out_w, out_h);
    let lens = correction(t, profile, sw, sh);
    // The chain maps straight lines to straight lines, except for lens distortion,
    // which is smooth: points along the border are enough.
    const STEPS: usize = 32;
    let (x0, y0, x1, y1) = (region.x as f32, region.y as f32, region.right() as f32, region.bottom() as f32);
    let border = (0..=STEPS).flat_map(|i| {
        let f = i as f32 / STEPS as f32;
        let (x, y) = (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
        [(x, y0), (x, y1), (x0, y), (x1, y)]
    });
    let (mut lo, mut hi) = ((f32::MAX, f32::MAX), (f32::MIN, f32::MIN));
    for (x, y) in border {
        let (u, v) = m.at(x, y);
        let (u, v) = lens.as_ref().map_or((u, v), |l| l.map_green(u, v));
        lo = (lo.0.min(u), lo.1.min(v));
        hi = (hi.0.max(u), hi.1.max(v));
    }
    // Bilinear taps, a curved border between the samples, and TCA (well under 1 %).
    let margin = 4.0 + 0.01 * (hi.0 - lo.0).max(hi.1 - lo.1);
    let span = |lo: f32, hi: f32, len: usize| {
        let start = ((lo - margin).floor().max(0.0) as usize).min(len - 1);
        let end = ((hi + margin).ceil().max(0.0) as usize).clamp(start + 1, len);
        (start, end - start)
    };
    let ((x, width), (y, height)) = (span(lo.0, hi.0, base.0), span(lo.1, hi.1, base.1));
    Region { x, y, width, height }
}

/// [`apply_region`]'s loop with lens correction: each channel is read at its own position
/// (unless there's no TCA), and scaled by the vignetting gain. The correction is
/// evaluated once per output pixel, at its centre, and shared by its subsamples.
fn apply_lens(src: &Image, m: &Mapping, lens: &Correction, ss: usize, at: Patch, out: &mut Image) {
    let inv_ss = 1.0 / ss as f32;
    let norm = 1.0 / (ss * ss) as f32;
    let out_w = out.width;
    let (cx, cy) = lens.centre();
    for (y, row) in out.pixels.chunks_exact_mut(out_w.max(1)).enumerate() {
        for (x, px) in row.iter_mut().enumerate() {
            let (u, v) = m.at(at.x0 + x as f32 + 0.5, at.y0 + y as f32 + 0.5);
            let (scales, gain) = lens.local(u, v);
            let mut acc = [0.0f32; 3];
            for sy in 0..ss {
                for sx in 0..ss {
                    let fx = at.x0 + x as f32 + (sx as f32 + 0.5) * inv_ss;
                    let fy = at.y0 + y as f32 + (sy as f32 + 0.5) * inv_ss;
                    let (u, v) = m.at(fx, fy);
                    let (dx, dy) = (u - cx, v - cy);
                    // Positions in the whole source first, then in the patch (exactly, as the
                    // origin is a whole number), so that patches read what the whole would.
                    if lens.tca {
                        for (c, s) in scales.iter().enumerate() {
                            acc[c] += src.sample_bilinear_channel(cx + dx * s - at.u0, cy + dy * s - at.v0, c);
                        }
                    } else {
                        let s = src.sample_bilinear(cx + dx * scales[1] - at.u0, cy + dy * scales[1] - at.v0);
                        acc[0] += s[0];
                        acc[1] += s[1];
                        acc[2] += s[2];
                    }
                }
            }
            *px = acc.map(|a| a * norm * gain);
        }
    }
}

/// `region` of the transformed one-channel `plane`, which holds pixels `plane_at` of a
/// `frame`-sized source and is 0 outside them; sampled bilinearly at each output pixel's
/// centre, through lens distortion (green). Masks use it: their drawn part is
/// rasterised in the sensor frame and follows the image through the geometry stage.
///
/// Source positions are computed exactly on a grid of [`PLANE_BLOCK`] output pixels
/// (aligned to the whole output, so that regions match it) and interpolated in
/// between: lens distortion bends much less than a pixel over a block. Blocks that
/// can't reach the plane are skipped.
#[allow(clippy::too_many_arguments)]
pub fn apply_plane_region(
    plane: &[f32],
    plane_at: Region,
    frame: (usize, usize),
    t: &Transform,
    profile: Option<&LensProfile>,
    out_w: usize,
    out_h: usize,
    region: Region,
) -> Vec<f32> {
    debug_assert_eq!(plane.len(), plane_at.width * plane_at.height);
    const B: usize = PLANE_BLOCK;
    let (sw, sh) = (frame.0 as f32, frame.1 as f32);
    let m = Mapping::new(sw, sh, t, out_w, out_h);
    let lens = correction(t, profile, sw, sh);
    let (pw, ph) = (plane_at.width as i64, plane_at.height as i64);
    let tap = |x: i64, y: i64| if x >= 0 && y >= 0 && x < pw && y < ph { plane[(y * pw + x) as usize] } else { 0.0 };
    // Source position of a grid node, in the plane's pixels (minus the half-pixel offset).
    let node = |x: usize, y: usize| {
        let (u, v) = m.at(x as f32, y as f32);
        let (u, v) = lens.as_ref().map_or((u, v), |l| l.map_green(u, v));
        (u - 0.5 - plane_at.x as f32, v - 0.5 - plane_at.y as f32)
    };
    let mut out = vec![0.0f32; region.width * region.height];
    let (bx0, bx1) = (region.x / B, region.right().div_ceil(B));
    let (by0, by1) = (region.y / B, region.bottom().div_ceil(B));
    let mut top: Vec<(f32, f32)> = (bx0..=bx1).map(|bx| node(bx * B, by0 * B)).collect();
    for by in by0..by1 {
        let bottom: Vec<(f32, f32)> = (bx0..=bx1).map(|bx| node(bx * B, (by + 1) * B)).collect();
        for bx in bx0..bx1 {
            let k = bx - bx0;
            let (a, b, c, d) = (top[k], top[k + 1], bottom[k], bottom[k + 1]);
            // Skip blocks whose source lies wholly outside the plane (with room for the taps).
            let (lo_u, hi_u) = (a.0.min(b.0).min(c.0).min(d.0), a.0.max(b.0).max(c.0).max(d.0));
            let (lo_v, hi_v) = (a.1.min(b.1).min(c.1).min(d.1), a.1.max(b.1).max(c.1).max(d.1));
            if hi_u < -2.0 || hi_v < -2.0 || lo_u > pw as f32 + 1.0 || lo_v > ph as f32 + 1.0 {
                continue;
            }
            let (x0, x1) = ((bx * B).max(region.x), ((bx + 1) * B).min(region.right()));
            let (y0, y1) = ((by * B).max(region.y), ((by + 1) * B).min(region.bottom()));
            for y in y0..y1 {
                let ty = (y - by * B) as f32 / B as f32 + 0.5 / B as f32;
                let left = (a.0 + (c.0 - a.0) * ty, a.1 + (c.1 - a.1) * ty);
                let right = (b.0 + (d.0 - b.0) * ty, b.1 + (d.1 - b.1) * ty);
                let row = &mut out[(y - region.y) * region.width..];
                for x in x0..x1 {
                    let tx = (x - bx * B) as f32 / B as f32 + 0.5 / B as f32;
                    let (fx, fy) = (left.0 + (right.0 - left.0) * tx, left.1 + (right.1 - left.1) * tx);
                    if !(fx > -1.0 && fy > -1.0 && fx < pw as f32 && fy < ph as f32) {
                        continue;
                    }
                    let (xf, yf) = (fx.floor(), fy.floor());
                    let (sx, sy) = (fx - xf, fy - yf);
                    let (xi, yi) = (xf as i64, yf as i64);
                    let upper = tap(xi, yi) + (tap(xi + 1, yi) - tap(xi, yi)) * sx;
                    let lower = tap(xi, yi + 1) + (tap(xi + 1, yi + 1) - tap(xi, yi + 1)) * sx;
                    row[x - region.x] = upper + (lower - upper) * sy;
                }
            }
        }
        top = bottom;
    }
    out
}

/// Size of the blocks [`apply_plane_region`] interpolates source positions over.
pub const PLANE_BLOCK: usize = 16;

/// Render `out_w × out_h` pixels of the transformed `src` mask, by nearest sampling.
pub fn apply_mask(src: &Mask, t: &Transform, profile: Option<&LensProfile>, out_w: usize, out_h: usize) -> Mask {
    let whole = Region::full(src.width, src.height);
    apply_mask_region(src, whole, (src.width, src.height), t, profile, out_w, out_h, Region::full(out_w, out_h))
}

/// `region` of [`apply_mask`]'s output, from a patch of the mask (as [`apply_region`]).
#[allow(clippy::too_many_arguments)]
pub fn apply_mask_region(
    src: &Mask,
    src_at: Region,
    base: (usize, usize),
    t: &Transform,
    profile: Option<&LensProfile>,
    out_w: usize,
    out_h: usize,
    region: Region,
) -> Mask {
    let (sw, sh) = (base.0 as f32, base.1 as f32);
    let m = Mapping::new(sw, sh, t, out_w, out_h);
    let lens = correction(t, profile, sw, sh);
    let (min_x, min_y) = (src_at.x as f32, src_at.y as f32);
    let (max_x, max_y) = (min_x + src.width as f32 - 1.0, min_y + src.height as f32 - 1.0);
    let mut out = Mask::new(region.width, region.height);
    for y in 0..region.height {
        for x in 0..region.width {
            let (u, v) = m.at((region.x + x) as f32 + 0.5, (region.y + y) as f32 + 0.5);
            let (u, v) = lens.as_ref().map_or((u, v), |l| l.map_green(u, v));
            let (u, v) = (u.clamp(min_x, max_x) as usize - src_at.x, v.clamp(min_y, max_y) as usize - src_at.y);
            if src.get(u, v) {
                out.set(x, y);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3×2 image whose red channel encodes the pixel index.
    fn indexed() -> Image {
        let mut img = Image::new(3, 2);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [i as f32, 0.0, 0.0];
        }
        img
    }

    fn reds(img: &Image) -> Vec<f32> {
        img.pixels.iter().map(|p| p[0].round()).collect()
    }

    fn transform(flip: bool, quarter_turns: u8) -> Transform {
        Transform {
            lens: None,
            orient: Orient { flip, quarter_turns },
            angle: 0.0,
            crop: Crop::default(),
        }
    }

    // Source:  0 1 2
    //          3 4 5
    #[test]
    fn identity() {
        let out = apply(&indexed(), &transform(false, 0), None, 3, 2);
        assert_eq!(reds(&out), [0., 1., 2., 3., 4., 5.]);
    }

    #[test]
    fn rotate_clockwise() {
        // 3 0
        // 4 1
        // 5 2
        let out = apply(&indexed(), &transform(false, 1), None, 2, 3);
        assert_eq!(reds(&out), [3., 0., 4., 1., 5., 2.]);
    }

    #[test]
    fn flip_then_rotate_is_transpose() {
        // EXIF 5 (transpose): 0 3 / 1 4 / 2 5
        let out = apply(&indexed(), &transform(true, 3), None, 2, 3);
        assert_eq!(reds(&out), [0., 3., 1., 4., 2., 5.]);
    }

    #[test]
    fn crop() {
        let t = Transform {
            crop: Crop {
                x: 1.0 / 3.0,
                y: 0.5,
                width: 2.0 / 3.0,
                height: 0.5,
            },
            ..transform(false, 0)
        };
        let out = apply(&indexed(), &t, None, 2, 1);
        assert_eq!(reds(&out), [4., 5.]);
    }

    #[test]
    fn mask_follows_the_image() {
        // Mark source pixel 1 (top middle); rotated clockwise it lands at (1, 1).
        let mut mask = Mask::new(3, 2);
        mask.set(1, 0);
        let out = apply_mask(&mask, &transform(false, 1), None, 2, 3);
        let marked: Vec<bool> = (0..3).flat_map(|y| (0..2).map(move |x| (x, y))).map(|(x, y)| out.get(x, y)).collect();
        assert_eq!(marked, [false, false, false, true, false, false]);
    }

    #[test]
    fn sensor_mapping_round_trips() {
        use crate::lens::{LensProfile, LensSource};
        let profile = LensProfile {
            source: LensSource::Sony,
            knots: vec![0.0, 0.5, 1.0],
            distortion: vec![1.0, 0.98, 0.93],
            ca_red: vec![0.0, 0.0, 0.0],
            ca_blue: vec![0.0, 0.0, 0.0],
            vignetting: vec![0.0, 0.0, 0.0],
        };
        let t = Transform {
            lens: Some(Lens { distortion: 1.0, tca: 0.0, vignetting: 0.0 }),
            orient: Orient { flip: true, quarter_turns: 1 },
            angle: 4.0,
            crop: Crop { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
        };
        for lens in [None, Some(&profile)] {
            let m = SensorMapping::new(&t, lens, 6000.0, 4000.0);
            for (x, y) in [(0.5, 0.5), (0.0, 0.0), (1.0, 0.3), (0.2, 0.9)] {
                let (u, v) = m.to_sensor(x, y);
                let (bx, by) = m.from_sensor(u, v);
                assert!((bx - x).abs() < 1e-4 && (by - y).abs() < 1e-4, "{lens:?} ({x}, {y}) → ({u}, {v}) → ({bx}, {by})");
            }
        }
        // Without lens correction or geometry, both frames are the same.
        let m = SensorMapping::new(&transform(false, 0), None, 6000.0, 4000.0);
        let (u, v) = m.to_sensor(0.25, 0.75);
        assert!((u - 0.25).abs() < 1e-6 && (v - 0.75).abs() < 1e-6);
    }

    #[test]
    fn sensor_mapping_follows_the_render() {
        // A marked source pixel lands where `from_sensor` says (a quarter turn).
        let (u, v) = SensorMapping::new(&transform(false, 1), None, 3.0, 2.0).from_sensor(1.5 / 3.0, 0.5 / 2.0);
        // Source pixel 1 (top middle) is at (1, 1) of the 2 × 3 output: centre (1.5, 1.5).
        assert!((u - 1.5 / 2.0).abs() < 1e-6 && (v - 1.5 / 3.0).abs() < 1e-6, "({u}, {v})");
    }

    #[test]
    fn orient_composition() {
        // Camera says rotate 90° CW, user rotates another 90° CW → 180°.
        assert_eq!(Orient::from_exif(6).then(1, false), Orient { flip: false, quarter_turns: 2 });
        // Rotate 90° CW then mirror == transpose (EXIF 5).
        assert_eq!(Orient::default().then(1, true), Orient::from_exif(5));
        assert_eq!(
            reds(&apply(&indexed(), &Transform { orient: Orient::default().then(1, true), ..transform(false, 0) }, None, 2, 3)),
            [0., 3., 1., 4., 2., 5.]
        );
    }
}
