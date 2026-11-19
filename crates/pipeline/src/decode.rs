//! RAW decoding (via [rawler]) into a [`RawPhoto`]: sensor data plus everything
//! needed to interpret it (levels, CFA layout, white balance, colour matrix).

use rawler::decoders::RawDecodeParams;
use rawler::imgop::xyz::Illuminant;
use rawler::rawimage::RawPhotometricInterpretation;
use rawler::rawsource::RawSource;
use rawler::{CFA, RawImage, RawImageData};

use crate::bitmap::{self, Bitmap};
use crate::color::{self, Mat3};
use crate::lens::LensProfile;
use crate::metadata::{self, PhotoMetadata};
use crate::{Error, Result};

/// How the sensor samples are laid out.
#[derive(Clone, Debug)]
pub enum Layout {
    /// One sample per photosite behind a colour filter array (Bayer, X-Trans…).
    Mosaic(CFA),
    /// Already three samples per pixel (linear DNG, some phone RAWs).
    Rgb,
    /// One sample per pixel, no colour (monochrome sensors).
    Mono,
}

/// The `D4` transform that brings the sensor image upright: optionally mirror
/// horizontally, then rotate clockwise by `quarter_turns`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Orient {
    pub flip: bool,
    pub quarter_turns: u8,
}

impl Orient {
    pub fn from_exif(value: u16) -> Self {
        let (flip, quarter_turns) = match value {
            2 => (true, 0),
            3 => (false, 2),
            4 => (true, 2),
            5 => (true, 3),
            6 => (false, 1),
            7 => (true, 1),
            8 => (false, 3),
            _ => (false, 0),
        };
        Self { flip, quarter_turns }
    }

    /// Apply another transform (rotate `turns` clockwise, then optionally mirror) after this one.
    pub fn then(self, turns: u8, flip: bool) -> Self {
        let q = (self.quarter_turns + turns) % 4;
        if flip {
            // F ∘ R^q ∘ F^h = R^-q ∘ F^(h ⊕ 1)
            Self {
                flip: !self.flip,
                quarter_turns: (4 - q) % 4,
            }
        } else {
            Self {
                flip: self.flip,
                quarter_turns: q,
            }
        }
    }

    pub fn swaps_axes(self) -> bool {
        self.quarter_turns % 2 == 1
    }
}

/// Where the samples come from.
enum Source {
    /// A RAW file's sensor data, with its levels.
    Sensor {
        raw: RawImage,
        /// Black level per position in the black level repeat pattern.
        black: Vec<f32>,
        black_width: usize,
        black_height: usize,
        white: f32,
    },
    /// An image developed already (JPEG, PNG, TIFF, WebP), linearised as it's read.
    Bitmap(Bitmap),
    /// A RAW file's mosaic after raw denoise ([`crate::denoise`]): normalised samples
    /// of the usable area, row by row, and which photosites were saturated before (one
    /// bit each), as denoising moves values near the clipping point.
    Denoised { samples: Vec<f32>, saturated: Vec<u64> },
}

/// A decoded file: a RAW file's sensor data, or an image developed already (see
/// [`crate::bitmap`]) read the same way, as a plain RGB or grey layout.
pub struct RawPhoto {
    source: Source,
    pub layout: Layout,
    /// Usable area of the sensor, in raw pixel coordinates.
    pub origin_x: usize,
    pub origin_y: usize,
    pub width: usize,
    pub height: usize,
    /// As-shot white balance multipliers, normalised to green = 1.
    pub wb: [f32; 3],
    /// Multipliers applied in the base stage: the "camera reference" ones, which make
    /// D65 light neutral (colour calibration then adapts to the scene's light). The
    /// as-shot ones when the camera matrix can't give them, and 1 for monochrome.
    pub wb_reference: [f32; 3],
    /// The xy chromaticity of the as-shot light, in the working space; `None` when the
    /// base stage already makes it neutral (monochrome, or no usable camera matrix).
    pub as_shot_illuminant: Option<[f32; 2]>,
    /// Camera RGB → linear Rec.2020.
    pub working_from_camera: Mat3,
    pub orientation: Orient,
    pub metadata: PhotoMetadata,
    /// Lens correction data embedded in the file.
    pub lens: Option<LensProfile>,
}

pub fn decode(bytes: &[u8]) -> Result<RawPhoto> {
    if let Some(format) = bitmap::detect(bytes) {
        let (image, metadata) = bitmap::decode(bytes, format)?;
        return Ok(RawPhoto::from_bitmap(image, metadata));
    }
    let source = RawSource::new_from_slice(bytes);
    let params = RawDecodeParams::default();
    let raw = rawler::decode(&source, &params).map_err(|e| Error::Decode(e.to_string()))?;
    let (metadata, lens) = metadata::extract_with_lens(&source, &raw);
    let mut photo = RawPhoto::new(raw, metadata)?;
    photo.lens = lens;
    Ok(photo)
}

impl RawPhoto {
    fn new(raw: RawImage, metadata: PhotoMetadata) -> Result<Self> {
        let layout = match (&raw.photometric, raw.cpp) {
            (RawPhotometricInterpretation::Cfa(config), 1) => Layout::Mosaic(config.cfa.clone()),
            (_, 3) => Layout::Rgb,
            (RawPhotometricInterpretation::BlackIsZero, 1) => Layout::Mono,
            (p, cpp) => return Err(Error::Unsupported(format!("{p:?} with {cpp} samples per pixel"))),
        };
        if let Layout::Mosaic(cfa) = &layout {
            if !cfa.is_valid() {
                return Err(Error::Unsupported(format!("CFA pattern {}", cfa.name)));
            }
        }

        let area = raw.crop_area.or(raw.active_area);
        let (origin_x, origin_y, width, height) = match area {
            Some(r) if r.d.w > 0 && r.d.h > 0 && r.p.x + r.d.w <= raw.width && r.p.y + r.d.h <= raw.height => {
                (r.p.x, r.p.y, r.d.w, r.d.h)
            }
            _ => (0, 0, raw.width, raw.height),
        };

        let black = raw.blacklevel.as_vec();
        let (black_width, black_height) = (raw.blacklevel.width.max(1), raw.blacklevel.height.max(1));
        let white = raw.whitelevel.as_vec().into_iter().fold(0.0f32, f32::max).max(1.0);

        let wb = as_shot_wb(&raw);
        let xyz_to_cam = camera_matrix(&raw);
        let (working_from_camera, wb_reference, as_shot_illuminant) = match layout {
            Layout::Mono => (color::IDENTITY, [1.0; 3], None),
            _ => (
                color::working_from_camera(&xyz_to_cam),
                color::reference_wb(&xyz_to_cam).unwrap_or(wb),
                color::illuminant_of_wb(&xyz_to_cam, wb),
            ),
        };

        // Resolved from the decoder and the EXIF tag by `metadata::extract`.
        let orientation = Orient::from_exif(metadata.orientation.unwrap_or(1));

        Ok(Self {
            source: Source::Sensor { raw, black, black_width, black_height, white },
            layout,
            origin_x,
            origin_y,
            width,
            height,
            wb,
            wb_reference,
            as_shot_illuminant,
            working_from_camera,
            orientation,
            metadata,
            lens: None,
        })
    }

    /// An image developed already: plain RGB (or grey) in its own primaries, nothing to
    /// white balance, no as-shot light.
    fn from_bitmap(image: Bitmap, metadata: PhotoMetadata) -> Self {
        let layout = if image.channels == 1 { Layout::Mono } else { Layout::Rgb };
        Self {
            layout,
            origin_x: 0,
            origin_y: 0,
            width: image.width,
            height: image.height,
            wb: [1.0; 3],
            wb_reference: [1.0; 3],
            as_shot_illuminant: None,
            working_from_camera: image.working_from_image,
            orientation: Orient::from_exif(metadata.orientation.unwrap_or(1)),
            metadata,
            lens: None,
            source: Source::Bitmap(image),
        }
    }

    /// Whether this is an image developed already rather than a RAW file.
    pub fn is_bitmap(&self) -> bool {
        matches!(self.source, Source::Bitmap(_))
    }

    /// Whether its samples are a denoised mosaic ([`RawPhoto::with_denoised`]).
    pub fn is_denoised(&self) -> bool {
        matches!(self.source, Source::Denoised { .. })
    }

    /// The same photo with `samples` (a mosaic's, `width × height`, normalised) in
    /// place of its sensor data. Saturation is still the original's.
    pub fn with_denoised(&self, samples: Vec<f32>) -> RawPhoto {
        assert_eq!(samples.len(), self.width * self.height, "a sample per photosite");
        let mut saturated = vec![0u64; (self.width * self.height).div_ceil(64)];
        for y in 0..self.height {
            for x in 0..self.width {
                if self.saturated(x, y, 0) {
                    let i = y * self.width + x;
                    saturated[i / 64] |= 1 << (i % 64);
                }
            }
        }
        self.with_source(Source::Denoised { samples, saturated })
    }

    /// The same photo from denoised `samples` and the saturation bits a
    /// [`RawPhoto::denoised_parts`] gave: for a denoised mosaic kept apart from its RAW
    /// file. `None` if the sizes don't match.
    pub fn from_denoised_parts(&self, samples: Vec<f32>, saturated: Vec<u64>) -> Option<RawPhoto> {
        let n = self.width * self.height;
        (samples.len() == n && saturated.len() == n.div_ceil(64)).then(|| self.with_source(Source::Denoised { samples, saturated }))
    }

    /// A denoised photo's samples and saturation bits, `None` for any other.
    pub fn denoised_parts(&self) -> Option<(&[f32], &[u64])> {
        match &self.source {
            Source::Denoised { samples, saturated } => Some((samples, saturated)),
            _ => None,
        }
    }

    /// A denoised photo as a file, for keeping it apart from its RAW file (the browser
    /// keeps it in place of the original): a header with what decoding read (`key`
    /// says which denoise made it), then the samples as 16-bit floats and the
    /// saturation bits. `None` for a photo that isn't denoised.
    pub fn to_denoised_file(&self, key: &str) -> Option<Vec<u8>> {
        let (samples, saturated) = self.denoised_parts()?;
        let Layout::Mosaic(cfa) = &self.layout else { return None };
        let header = DenoisedHeader {
            key: key.to_string(),
            cfa: cfa.name.clone(),
            origin_x: self.origin_x,
            origin_y: self.origin_y,
            width: self.width,
            height: self.height,
            wb: self.wb,
            wb_reference: self.wb_reference,
            as_shot_illuminant: self.as_shot_illuminant,
            working_from_camera: self.working_from_camera,
            orientation: self.orientation,
            metadata: self.metadata.clone(),
            lens: self.lens.clone(),
        };
        let json = serde_json::to_vec(&header).ok()?;
        let padded = json.len().next_multiple_of(8);
        let mut out = Vec::with_capacity(16 + padded + samples.len() * 2 + saturated.len() * 8);
        out.extend_from_slice(DENOISED_MAGIC);
        out.extend_from_slice(&(padded as u32).to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&json);
        out.resize(16 + padded, b' ');
        for &v in samples {
            out.extend_from_slice(&f32_to_f16(v).to_le_bytes());
        }
        for &b in saturated {
            out.extend_from_slice(&b.to_le_bytes());
        }
        Some(out)
    }

    /// A photo from [`RawPhoto::to_denoised_file`]'s bytes, and its key.
    pub fn from_denoised_file(bytes: &[u8]) -> Result<(String, RawPhoto)> {
        let bad = |why: &str| Error::Decode(format!("denoised file: {why}"));
        if bytes.len() < 16 || &bytes[..8] != DENOISED_MAGIC {
            return Err(bad("not one"));
        }
        let len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let json = bytes.get(16..16 + len).ok_or_else(|| bad("truncated header"))?;
        let h: DenoisedHeader = serde_json::from_slice(json).map_err(|e| bad(&e.to_string()))?;
        let n = h.width * h.height;
        let data = &bytes[16 + len..];
        if h.width == 0 || h.height == 0 || data.len() != n * 2 + n.div_ceil(64) * 8 {
            return Err(bad("wrong size"));
        }
        let samples = data[..n * 2].chunks_exact(2).map(|b| f16_to_f32(u16::from_le_bytes([b[0], b[1]]))).collect();
        let saturated = data[n * 2..].chunks_exact(8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).collect();
        let photo = RawPhoto {
            source: Source::Denoised { samples, saturated },
            layout: Layout::Mosaic(CFA::new(&h.cfa)),
            origin_x: h.origin_x,
            origin_y: h.origin_y,
            width: h.width,
            height: h.height,
            wb: h.wb,
            wb_reference: h.wb_reference,
            as_shot_illuminant: h.as_shot_illuminant,
            working_from_camera: h.working_from_camera,
            orientation: h.orientation,
            metadata: h.metadata,
            lens: h.lens,
        };
        Ok((h.key, photo))
    }

    fn with_source(&self, source: Source) -> RawPhoto {
        RawPhoto {
            source,
            layout: self.layout.clone(),
            origin_x: self.origin_x,
            origin_y: self.origin_y,
            width: self.width,
            height: self.height,
            wb: self.wb,
            wb_reference: self.wb_reference,
            as_shot_illuminant: self.as_shot_illuminant,
            working_from_camera: self.working_from_camera,
            orientation: self.orientation,
            metadata: self.metadata.clone(),
            lens: self.lens.clone(),
        }
    }

    /// Whether the sample at usable-area coordinates is at the sensor's saturation
    /// (for a denoised mosaic, whether it was before denoising).
    #[inline]
    pub fn saturated(&self, x: usize, y: usize, channel: usize) -> bool {
        match &self.source {
            Source::Denoised { saturated, .. } => {
                let i = y * self.width + x;
                saturated[i / 64] >> (i % 64) & 1 != 0
            }
            _ => self.sample(x, y, channel) >= crate::demosaic::SENSOR_CLIP,
        }
    }

    /// Normalised sample (0 = black, 1 = sensor saturation, or linear light for an
    /// image) at usable-area coordinates. `channel` is only relevant for
    /// 3-samples-per-pixel layouts.
    #[inline]
    pub fn sample(&self, x: usize, y: usize, channel: usize) -> f32 {
        match &self.source {
            Source::Bitmap(image) => image.sample(x, y, channel),
            _ => self.sample_unclamped(x, y, channel).max(0.0),
        }
    }

    /// [`RawPhoto::sample`] without clamping at black: noise around black is
    /// symmetric, and raw denoise needs both sides of it.
    #[inline]
    pub fn sample_unclamped(&self, x: usize, y: usize, channel: usize) -> f32 {
        let (raw, black, black_width, black_height, white) = match &self.source {
            Source::Sensor { raw, black, black_width, black_height, white } => (raw, black, *black_width, *black_height, *white),
            Source::Bitmap(image) => return image.sample(x, y, channel),
            Source::Denoised { samples, .. } => return samples[y * self.width + x],
        };
        let (rx, ry) = (x + self.origin_x, y + self.origin_y);
        let cpp = raw.cpp;
        let idx = (ry * raw.width + rx) * cpp + channel;
        let v = match &raw.data {
            RawImageData::Integer(d) => d[idx] as f32,
            RawImageData::Float(d) => d[idx],
        };
        let bcpp = if black.len() >= black_width * black_height * cpp { cpp } else { 1 };
        let bi = ((ry % black_height) * black_width + (rx % black_width)) * bcpp + channel.min(bcpp - 1);
        let black = black.get(bi).copied().unwrap_or(0.0);
        (v - black) / (white - black)
    }

    /// CFA colour (0 = R, 1 = G, 2 = B) of the photosite at usable-area coordinates.
    #[inline]
    pub fn color_at(&self, cfa: &CFA, x: usize, y: usize) -> usize {
        match cfa.color_at(y + self.origin_y, x + self.origin_x) {
            c @ 0..=2 => c,
            _ => 1, // treat "emerald"/4th colour as green
        }
    }
}

const DENOISED_MAGIC: &[u8; 8] = b"RTDN1\0\0\0";

/// What [`RawPhoto::to_denoised_file`] keeps of the decoding.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DenoisedHeader {
    key: String,
    cfa: String,
    origin_x: usize,
    origin_y: usize,
    width: usize,
    height: usize,
    wb: [f32; 3],
    wb_reference: [f32; 3],
    as_shot_illuminant: Option<[f32; 2]>,
    working_from_camera: Mat3,
    orientation: Orient,
    metadata: PhotoMetadata,
    lens: Option<LensProfile>,
}

/// IEEE half precision, rounded to nearest even (no `f16` in stable Rust yet).
pub(crate) fn f32_to_f16(x: f32) -> u16 {
    let b = x.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let exp = ((b >> 23) & 0xff) as i32;
    let mant = b & 0x7f_ffff;
    if exp == 0xff {
        return sign | 0x7c00 | if mant != 0 { 0x200 } else { 0 };
    }
    let e = exp - 127 + 15;
    if e >= 0x1f {
        return sign | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return sign;
        }
        let m = mant | 0x80_0000;
        let shift = (14 - e) as u32;
        let rounded = m + (1 << (shift - 1)) - 1 + ((m >> shift) & 1);
        return sign | (rounded >> shift) as u16;
    }
    let rounded = mant + 0xfff + ((mant >> 13) & 1);
    let (e, rounded) = if rounded & 0x80_0000 != 0 { (e + 1, 0) } else { (e, rounded) };
    if e >= 0x1f {
        return sign | 0x7c00;
    }
    sign | ((e as u16) << 10) | (rounded >> 13) as u16
}

pub(crate) fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h & 0x8000) as u32) << 16;
    let exp = ((h >> 10) & 0x1f) as u32;
    let mant = (h & 0x3ff) as u32;
    match exp {
        // Subnormal: mant · 2⁻²⁴, exact in f32.
        0 => f32::from_bits(sign) + if sign != 0 { -(mant as f32) } else { mant as f32 } * f32::from_bits(0x3380_0000),
        0x1f => f32::from_bits(sign | 0x7f80_0000 | (mant << 13)),
        _ => f32::from_bits(sign | ((exp + 112) << 23) | (mant << 13)),
    }
}

#[cfg(test)]
mod half_tests {
    use super::*;

    #[test]
    fn half_floats_round_trip() {
        for h in 0..=u16::MAX {
            let f = f16_to_f32(h);
            if !f.is_nan() {
                assert_eq!(f32_to_f16(f), h, "{h:#x} → {f}");
            }
        }
        // Rounded to nearest, within half a step.
        for &x in &[0.1f32, 0.5, 0.999, 1.7, -0.003, 1e-6, 3e-5, 65504.0] {
            let y = f16_to_f32(f32_to_f16(x));
            assert!((y - x).abs() <= x.abs() * 2f32.powi(-11) + 2f32.powi(-25), "{x} → {y}");
        }
        assert!(f16_to_f32(f32_to_f16(1e6)).is_infinite());
    }
}

/// The camera's XYZ → camera RGB matrix for D65 light (Adobe's, or the DNG's), or the
/// closest daylight one. rawler keeps them by calibration illuminant; its old
/// `xyz_to_cam` field is left empty.
fn camera_matrix(raw: &RawImage) -> [[f32; 3]; 4] {
    let preferred = [Illuminant::D65, Illuminant::D55, Illuminant::Daylight, Illuminant::FineWeather, Illuminant::D75, Illuminant::Flash, Illuminant::D50];
    let flat = raw.color_matrix_find_first(preferred).map(|(_, m)| m).or_else(|| raw.color_matrix.values().next().cloned());
    let Some(flat) = flat.filter(|m| m.len() >= 9 && m.len() % 3 == 0) else {
        return raw.xyz_to_cam;
    };
    let mut m = [[0.0; 3]; 4];
    for (i, row) in flat.chunks_exact(3).take(4).enumerate() {
        m[i].copy_from_slice(row);
    }
    m
}

/// As-shot white balance multipliers, normalised to green = 1.
fn as_shot_wb(raw: &RawImage) -> [f32; 3] {
    let c = raw.wb_coeffs;
    let usable = c[..3].iter().all(|v| v.is_finite() && *v > 0.0);
    let c = if usable { c } else { raw.neutralwb() };
    let g = if c[1] > 0.0 { c[1] } else { 1.0 };
    [c[0] / g, 1.0, c[2] / g]
}

/// The as-shot and D65 reference white balance multipliers, and CIE XYZ from camera RGB
/// balanced with the reference, if the file has colour (`metadata::CameraWhite`).
pub(crate) fn camera_white(raw: &RawImage) -> Option<([f32; 3], [f32; 3], color::Mat3)> {
    if raw.cpp == 1 && matches!(raw.photometric, RawPhotometricInterpretation::BlackIsZero) {
        return None;
    }
    let xyz_to_cam = camera_matrix(raw);
    let reference = color::reference_wb(&xyz_to_cam)?;
    let m = color::mul(&color::xyz_from_rec2020(), &color::working_from_camera(&xyz_to_cam));
    Some((as_shot_wb(raw), reference, m))
}

/// The xy chromaticity of the light the camera balanced for, if the file has colour.
pub(crate) fn as_shot_illuminant(raw: &RawImage) -> Option<[f32; 2]> {
    if raw.cpp == 1 && matches!(raw.photometric, RawPhotometricInterpretation::BlackIsZero) {
        return None;
    }
    color::illuminant_of_wb(&camera_matrix(raw), as_shot_wb(raw))
}
