//! Lens correction: distortion, transverse chromatic aberration (TCA) and vignetting,
//! from the correction data that cameras embed in RAW files.
//!
//! Only Sony's embedded data is read for now (ARW tags `0x7032`, `0x7035`, `0x7037`).
//! The decoding and the model follow darktable's `lens.cc` ("embedded metadata",
//! version 2). Deviations:
//! * Vignetting is applied in the geometry resample, at each sample's source
//!   position, instead of on the input image first. The gain varies slowly, so the
//!   result is the same, and the cached base image stays independent of the lens.
//! * The strength of the vignetting correction scales its gain in EV. At 100 % this
//!   is exactly darktable's correction.
//! * The image is always scaled to the largest size with no empty borders (darktable
//!   leaves the scale to the user, with an auto-scale button).

use rawler::formats::tiff::reader::TiffReader;
use rawler::formats::tiff::{GenericTiffReader, Value};

use crate::params::Lens;

/// Correction data for one image, as functions of the distance from the image centre.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LensProfile {
    pub source: LensSource,
    /// Knot radii, as a fraction of the half-diagonal of the sensor's usable area,
    /// increasing. Between knots values are interpolated linearly; outside they are
    /// held constant.
    pub(crate) knots: Vec<f32>,
    /// Source radius / corrected radius, for green, at each knot of the corrected image.
    pub(crate) distortion: Vec<f32>,
    /// Extra relative radius of red and blue against green (TCA), at each knot.
    pub(crate) ca_red: Vec<f32>,
    pub(crate) ca_blue: Vec<f32>,
    /// Light falloff in EV, at each knot of the source image (positive: darker).
    pub(crate) vignetting: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum LensSource {
    Sony,
}

impl LensSource {
    /// The name used in metadata (`PhotoMetadata::lens_correction`).
    pub fn name(self) -> &'static str {
        match self {
            LensSource::Sony => "sony",
        }
    }
}

impl LensProfile {
    /// The correction data embedded in a RAW file, if any.
    pub fn embedded(bytes: &[u8], make: &str) -> Option<Self> {
        if make.eq_ignore_ascii_case("sony") { sony(bytes) } else { None }
    }
}

/// Sony ARW: three signed arrays whose first value is the number of knots, `nc`
/// (16 in practice): distortion, then red CA followed by blue CA (2 × nc), then
/// vignetting. Knot `i` sits at a radius of `(i + 0.5) / (nc - 1)`.
fn sony(bytes: &[u8]) -> Option<LensProfile> {
    const DISTORTION: u16 = 0x7037;
    const CA: u16 = 0x7035;
    const VIGNETTING: u16 = 0x7032;

    let tiff = GenericTiffReader::new_with_buffer(bytes, 0, 0, None).ok()?;
    let read = |tag: u16| -> Option<Vec<i32>> {
        match &tiff.find_first_ifd_with_tag(tag)?.get_entry(tag)?.value {
            Value::SShort(v) => Some(v.iter().map(|&x| x.into()).collect()),
            Value::Short(v) => Some(v.iter().map(|&x| (x as i16).into()).collect()),
            _ => None,
        }
    };
    let (d, ca, v) = (read(DISTORTION)?, read(CA)?, read(VIGNETTING)?);
    let nc = usize::try_from(*d.first()?).ok()?;
    let valid = (2..=16).contains(&nc)
        && d.len() > nc
        && ca.first() == Some(&(2 * nc as i32))
        && ca.len() > 2 * nc
        && v.first() == Some(&(nc as i32))
        && v.len() > nc;
    if !valid {
        return None;
    }
    let ldexp = |x: i32, e: i32| x as f32 * 2f32.powi(e);
    Some(LensProfile {
        source: LensSource::Sony,
        knots: (0..nc).map(|i| (i as f32 + 0.5) / (nc - 1) as f32).collect(),
        distortion: d[1..=nc].iter().map(|&x| 1.0 + ldexp(x, -14)).collect(),
        ca_red: ca[1..=nc].iter().map(|&x| ldexp(x, -21)).collect(),
        ca_blue: ca[nc + 1..=2 * nc].iter().map(|&x| ldexp(x, -21)).collect(),
        // darktable divides by 2^(0.5 - 2^(v·2⁻¹³ - 1)), i.e. brightens by this many EV.
        vignetting: v[1..=nc].iter().map(|&x| 2f32.powf(ldexp(x, -13) - 1.0) - 0.5).collect(),
    })
}

/// `values` at `x`, interpolated linearly between `knots`, constant outside.
fn interpolate(knots: &[f32], values: &[f32], x: f32) -> f32 {
    let i = knots.partition_point(|&k| k < x);
    if i == 0 {
        return values[0];
    }
    if i == knots.len() {
        return values[i - 1];
    }
    let t = (x - knots[i - 1]) / (knots[i] - knots[i - 1]);
    values[i - 1] + (values[i] - values[i - 1]) * t
}

/// Number of steps in the lookup tables, over the squared radius.
const TABLE_SIZE: usize = 1024;

/// A profile with its strengths applied, for an image of a given size, as lookup
/// tables over the squared distance from the centre of the corrected image.
///
/// A sample at offset `d` from the centre of the corrected image reads channel `c`
/// at offset `d · scale[c](|d|²)` in the source, multiplied by `gain(|d|²)`.
pub struct Correction {
    cx: f32,
    cy: f32,
    /// Squared offset (source pixels) → table position.
    to_index: f32,
    /// Per channel (R, G, B), with the fitting zoom folded in.
    scale: [Vec<f32>; 3],
    gain: Vec<f32>,
    /// Red or blue differ from green.
    pub tca: bool,
}

impl Correction {
    /// `None` if the strengths make it a no-op.
    pub fn new(profile: &LensProfile, lens: &Lens, width: f32, height: f32) -> Option<Self> {
        let (sd, st, sv) = (lens.distortion.clamp(0.0, 2.0), lens.tca.clamp(0.0, 2.0), lens.vignetting.clamp(0.0, 2.0));
        if sd == 0.0 && st == 0.0 && sv == 0.0 {
            return None;
        }
        let p = profile;
        // Source / corrected radius for channel `c` at normalised corrected radius `r`.
        let ratio = |c: usize, r: f32| {
            let green = 1.0 + sd * (interpolate(&p.knots, &p.distortion, r) - 1.0);
            let ca = match c {
                0 => st * interpolate(&p.knots, &p.ca_red, r),
                2 => st * interpolate(&p.knots, &p.ca_blue, r),
                _ => 0.0,
            };
            green * (1.0 + ca)
        };

        // Zoom so that the frame's edges map inside the source: every point of the
        // border, at radius r, needs ratio(r / zoom) / zoom ≤ 1. Edge points range from
        // the short side's half-width out to the corner.
        let r_min = width.min(height) / width.hypot(height);
        let mut zoom = 1.0f32;
        for _ in 0..8 {
            zoom = (0..=64)
                .map(|i| r_min + (1.0 - r_min) * i as f32 / 64.0)
                .flat_map(|r| (0..3).map(move |c| (c, r)))
                .map(|(c, r)| ratio(c, r / zoom))
                .fold(f32::MIN, f32::max);
        }

        // Tables over the squared normalised radius of output samples, up to the corner
        // (plus a margin for supersampling at the edges). The profile sees the radius
        // before the zoom.
        let half_diagonal = 0.5 * width.hypot(height);
        let max_r2 = 1.1;
        let r_at = |i: usize| (i as f32 / TABLE_SIZE as f32 * max_r2).sqrt();
        let table = |c: usize| (0..=TABLE_SIZE).map(|i| ratio(c, r_at(i) / zoom) / zoom).collect::<Vec<f32>>();
        let scale = [table(0), table(1), table(2)];
        let gain = (0..=TABLE_SIZE)
            .map(|i| {
                let source_r = r_at(i) * scale[1][i];
                (sv * interpolate(&p.knots, &p.vignetting, source_r)).exp2()
            })
            .collect();
        Some(Self {
            cx: 0.5 * width,
            cy: 0.5 * height,
            to_index: TABLE_SIZE as f32 / (max_r2 * half_diagonal * half_diagonal),
            tca: scale[0] != scale[1] || scale[2] != scale[1],
            scale,
            gain,
        })
    }

    /// Source positions of the three channels and the vignetting gain for a point of
    /// the corrected image.
    #[inline]
    pub fn map(&self, u: f32, v: f32) -> ([(f32, f32); 3], f32) {
        let (scales, gain) = self.local(u, v);
        let (dx, dy) = (u - self.cx, v - self.cy);
        (scales.map(|s| (self.cx + dx * s, self.cy + dy * s)), gain)
    }

    /// The radial scale of each channel and the vignetting gain at a point of the
    /// corrected image. Both vary slowly, so neighbouring points (the subsamples of a
    /// pixel) can reuse them: `(u, v)` reads at `centre + (u - centre) · scale`.
    #[inline]
    pub fn local(&self, u: f32, v: f32) -> ([f32; 3], f32) {
        let (dx, dy) = (u - self.cx, v - self.cy);
        let pos = ((dx * dx + dy * dy) * self.to_index).min(TABLE_SIZE as f32);
        let i = (pos as usize).min(TABLE_SIZE - 1);
        let t = pos - i as f32;
        let at = |table: &[f32]| table[i] + (table[i + 1] - table[i]) * t;
        ([at(&self.scale[0]), at(&self.scale[1]), at(&self.scale[2])], at(&self.gain))
    }

    pub fn centre(&self) -> (f32, f32) {
        (self.cx, self.cy)
    }

    /// Green's radial scale table and what indexes it: `(cx, cy, to_index, scale)`, for
    /// mirroring [`map_green`](Self::map_green) elsewhere (the editor's overlay).
    pub fn green_table(&self) -> (f32, f32, f32, &[f32]) {
        (self.cx, self.cy, self.to_index, &self.scale[1])
    }

    /// Inverse of [`map_green`](Self::map_green): the point of the corrected image whose
    /// green comes from source position `(x, y)`.
    pub fn unmap_green(&self, x: f32, y: f32) -> (f32, f32) {
        let (qx, qy) = (x - self.cx, y - self.cy);
        let target = qx.hypot(qy);
        if target == 0.0 {
            return (x, y);
        }
        // Solve r · scale(r²) = target by fixed-point iteration: the scale varies slowly.
        let scale_at = |r: f32| {
            let pos = (r * r * self.to_index).min(TABLE_SIZE as f32);
            let i = (pos as usize).min(TABLE_SIZE - 1);
            self.scale[1][i] + (self.scale[1][i + 1] - self.scale[1][i]) * (pos - i as f32)
        };
        let mut r = target;
        for _ in 0..24 {
            r = target / scale_at(r);
        }
        let k = r / target;
        (self.cx + qx * k, self.cy + qy * k)
    }

    /// Source position of green for a point of the corrected image.
    #[inline]
    pub fn map_green(&self, u: f32, v: f32) -> (f32, f32) {
        let (dx, dy) = (u - self.cx, v - self.cy);
        let pos = ((dx * dx + dy * dy) * self.to_index).min(TABLE_SIZE as f32);
        let i = (pos as usize).min(TABLE_SIZE - 1);
        let t = pos - i as f32;
        let s = self.scale[1][i] + (self.scale[1][i + 1] - self.scale[1][i]) * t;
        (self.cx + dx * s, self.cy + dy * s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(distortion: f32, ca_red: f32, vignetting: f32) -> LensProfile {
        LensProfile {
            source: LensSource::Sony,
            knots: vec![0.0, 1.0],
            distortion: vec![1.0, 1.0 + distortion],
            ca_red: vec![0.0, ca_red],
            ca_blue: vec![0.0, 0.0],
            vignetting: vec![0.0, vignetting],
        }
    }

    const FULL: Lens = Lens { distortion: 1.0, tca: 1.0, vignetting: 1.0 };

    #[test]
    fn interpolation_is_linear_and_clamped() {
        let (k, v) = ([0.2, 0.6, 1.0], [1.0, 2.0, 4.0]);
        assert_eq!(interpolate(&k, &v, 0.0), 1.0);
        assert_eq!(interpolate(&k, &v, 0.4), 1.5);
        assert_eq!(interpolate(&k, &v, 0.8), 3.0);
        assert_eq!(interpolate(&k, &v, 2.0), 4.0);
    }

    #[test]
    fn zero_strengths_are_a_no_op() {
        let off = Lens { distortion: 0.0, tca: 0.0, vignetting: 0.0 };
        assert!(Correction::new(&profile(-0.05, 0.001, 1.0), &off, 300.0, 200.0).is_none());
    }

    #[test]
    fn centre_is_fixed_and_corners_stay_inside() {
        // Pincushion correction pushes the corners out: the image must be zoomed in.
        for distortion in [-0.05, 0.05] {
            let c = Correction::new(&profile(distortion, 0.0, 0.0), &FULL, 300.0, 200.0).unwrap();
            let ([_, (u, v), _], gain) = c.map(150.0, 100.0);
            assert_eq!((u, v, gain), (150.0, 100.0, 1.0));
            for (x, y) in [(0.0, 0.0), (300.0, 200.0), (0.0, 100.0), (150.0, 0.0)] {
                let (u, v) = c.map_green(x, y);
                assert!((-0.01..=300.01).contains(&u) && (-0.01..=200.01).contains(&v), "{distortion}: ({x}, {y}) → ({u}, {v})");
            }
            // …and the tightest edge point lands exactly on the source's edge.
            let edge = [(0.0, 0.0), (0.0, 100.0), (150.0, 0.0)].map(|(x, y)| {
                let (u, v) = c.map_green(x, y);
                u.min(v).abs().min((300.0 - u).abs()).min((200.0 - v).abs())
            });
            assert!(edge.iter().any(|&d| d < 0.5), "{distortion}: {edge:?}");
        }
    }

    #[test]
    fn tca_moves_red_only() {
        let c = Correction::new(&profile(0.0, 0.002, 0.0), &FULL, 300.0, 200.0).unwrap();
        assert!(c.tca);
        let ([r, g, b], _) = c.map(10.0, 100.0);
        assert!(r.0 < g.0, "red is read further out: {r:?} {g:?}");
        assert_eq!(g, b);
    }

    #[test]
    fn vignetting_brightens_the_corners() {
        let half = Lens { vignetting: 0.5, ..FULL };
        // The corner of the source: 1 EV of falloff at the profile's last knot.
        let ev = |lens: &Lens| Correction::new(&profile(0.0, 0.0, 1.0), lens, 300.0, 200.0).unwrap().map(0.0, 0.0).1.log2();
        assert!((ev(&FULL) - 1.0).abs() < 0.01, "{}", ev(&FULL));
        assert!((ev(&half) - 0.5).abs() < 0.01);
    }
}
