//! Orientation, straightening, cropping and resampling — done in a single
//! inverse-mapping pass from output pixels back into the base image.

use crate::decode::Orient;
use crate::image::{Image, Mask};
use crate::params::Crop;

/// Everything needed to map the (sensor-oriented) base image into the output frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
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

/// Render `out_w × out_h` pixels of the transformed `src`.
pub fn apply(src: &Image, t: &Transform, out_w: usize, out_h: usize) -> Image {
    let (sw, sh) = (src.width as f32, src.height as f32);
    let (ow, oh) = t.oriented_size(sw, sh);
    let crop = t.crop.sanitized();
    let m = Mapping::new(sw, sh, t, out_w, out_h);

    // Source pixels per output pixel. The base image is binned to within 2× of the
    // output, so plain bilinear is enough unless we shrink by more than 1.5×.
    let ratio = (crop.width * ow / out_w as f32).max(crop.height * oh / out_h as f32);
    let ss = if ratio > 1.5 { (ratio.ceil() as usize).clamp(2, 4) } else { 1 };
    let inv_ss = 1.0 / ss as f32;
    let norm = 1.0 / (ss * ss) as f32;

    let mut out = Image::new(out_w, out_h);
    for (y, row) in out.pixels.chunks_exact_mut(out_w).enumerate() {
        for (x, px) in row.iter_mut().enumerate() {
            let mut acc = [0.0f32; 3];
            for sy in 0..ss {
                for sx in 0..ss {
                    let fx = x as f32 + (sx as f32 + 0.5) * inv_ss;
                    let fy = y as f32 + (sy as f32 + 0.5) * inv_ss;
                    let (u, v) = m.at(fx, fy);
                    let s = src.sample_bilinear(u, v);
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

/// Render `out_w × out_h` pixels of the transformed `src` mask, by nearest sampling.
pub fn apply_mask(src: &Mask, t: &Transform, out_w: usize, out_h: usize) -> Mask {
    let m = Mapping::new(src.width as f32, src.height as f32, t, out_w, out_h);
    let (max_x, max_y) = (src.width as f32 - 1.0, src.height as f32 - 1.0);
    let mut out = Mask::new(out_w, out_h);
    for y in 0..out_h {
        for x in 0..out_w {
            let (u, v) = m.at(x as f32 + 0.5, y as f32 + 0.5);
            if src.get(u.clamp(0.0, max_x) as usize, v.clamp(0.0, max_y) as usize) {
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
            orient: Orient { flip, quarter_turns },
            angle: 0.0,
            crop: Crop::default(),
        }
    }

    // Source:  0 1 2
    //          3 4 5
    #[test]
    fn identity() {
        let out = apply(&indexed(), &transform(false, 0), 3, 2);
        assert_eq!(reds(&out), [0., 1., 2., 3., 4., 5.]);
    }

    #[test]
    fn rotate_clockwise() {
        // 3 0
        // 4 1
        // 5 2
        let out = apply(&indexed(), &transform(false, 1), 2, 3);
        assert_eq!(reds(&out), [3., 0., 4., 1., 5., 2.]);
    }

    #[test]
    fn flip_then_rotate_is_transpose() {
        // EXIF 5 (transpose): 0 3 / 1 4 / 2 5
        let out = apply(&indexed(), &transform(true, 3), 2, 3);
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
        let out = apply(&indexed(), &t, 2, 1);
        assert_eq!(reds(&out), [4., 5.]);
    }

    #[test]
    fn mask_follows_the_image() {
        // Mark source pixel 1 (top middle); rotated clockwise it lands at (1, 1).
        let mut mask = Mask::new(3, 2);
        mask.set(1, 0);
        let out = apply_mask(&mask, &transform(false, 1), 2, 3);
        let marked: Vec<bool> = (0..3).flat_map(|y| (0..2).map(move |x| (x, y))).map(|(x, y)| out.get(x, y)).collect();
        assert_eq!(marked, [false, false, false, true, false, false]);
    }

    #[test]
    fn orient_composition() {
        // Camera says rotate 90° CW, user rotates another 90° CW → 180°.
        assert_eq!(Orient::from_exif(6).then(1, false), Orient { flip: false, quarter_turns: 2 });
        // Rotate 90° CW then mirror == transpose (EXIF 5).
        assert_eq!(Orient::default().then(1, true), Orient::from_exif(5));
        assert_eq!(
            reds(&apply(&indexed(), &Transform { orient: Orient::default().then(1, true), ..transform(false, 0) }, 2, 3)),
            [0., 3., 1., 4., 2., 5.]
        );
    }
}
