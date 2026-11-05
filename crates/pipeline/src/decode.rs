//! RAW decoding (via [rawler]) into a [`RawPhoto`]: sensor data plus everything
//! needed to interpret it (levels, CFA layout, white balance, colour matrix).

use rawler::decoders::RawDecodeParams;
use rawler::imgop::xyz::Illuminant;
use rawler::rawimage::RawPhotometricInterpretation;
use rawler::rawsource::RawSource;
use rawler::{CFA, RawImage, RawImageData};

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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
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

pub struct RawPhoto {
    pub(crate) raw: RawImage,
    pub layout: Layout,
    /// Usable area of the sensor, in raw pixel coordinates.
    pub origin_x: usize,
    pub origin_y: usize,
    pub width: usize,
    pub height: usize,
    /// Black level per position in the black level repeat pattern.
    black: Vec<f32>,
    black_width: usize,
    black_height: usize,
    white: f32,
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
            raw,
            layout,
            origin_x,
            origin_y,
            width,
            height,
            black,
            black_width,
            black_height,
            white,
            wb,
            wb_reference,
            as_shot_illuminant,
            working_from_camera,
            orientation,
            metadata,
            lens: None,
        })
    }

    /// Normalised sample (0 = black, 1 = sensor saturation) at usable-area coordinates.
    /// `channel` is only relevant for 3-samples-per-pixel layouts.
    #[inline]
    pub fn sample(&self, x: usize, y: usize, channel: usize) -> f32 {
        let (rx, ry) = (x + self.origin_x, y + self.origin_y);
        let cpp = self.raw.cpp;
        let idx = (ry * self.raw.width + rx) * cpp + channel;
        let v = match &self.raw.data {
            RawImageData::Integer(d) => d[idx] as f32,
            RawImageData::Float(d) => d[idx],
        };
        let bcpp = if self.black.len() >= self.black_width * self.black_height * cpp { cpp } else { 1 };
        let bi = ((ry % self.black_height) * self.black_width + (rx % self.black_width)) * bcpp + channel.min(bcpp - 1);
        let black = self.black.get(bi).copied().unwrap_or(0.0);
        ((v - black) / (self.white - black)).max(0.0)
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

/// The xy chromaticity of the light the camera balanced for, if the file has colour.
pub(crate) fn as_shot_illuminant(raw: &RawImage) -> Option<[f32; 2]> {
    if raw.cpp == 1 && matches!(raw.photometric, RawPhotometricInterpretation::BlackIsZero) {
        return None;
    }
    color::illuminant_of_wb(&camera_matrix(raw), as_shot_wb(raw))
}
