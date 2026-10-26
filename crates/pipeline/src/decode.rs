//! RAW decoding (via [rawler]) into a [`RawPhoto`]: sensor data plus everything
//! needed to interpret it (levels, CFA layout, white balance, colour matrix).

use rawler::decoders::{Orientation, RawDecodeParams};
use rawler::rawimage::RawPhotometricInterpretation;
use rawler::rawsource::RawSource;
use rawler::{CFA, RawImage, RawImageData};

use crate::color::{self, Mat3};
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
    /// Camera RGB → linear Rec.2020.
    pub working_from_camera: Mat3,
    pub orientation: Orient,
    pub metadata: PhotoMetadata,
}

pub fn decode(bytes: &[u8]) -> Result<RawPhoto> {
    let source = RawSource::new_from_slice(bytes);
    let params = RawDecodeParams::default();
    let raw = rawler::decode(&source, &params).map_err(|e| Error::Decode(e.to_string()))?;
    let metadata = metadata::extract(&source, &raw);
    RawPhoto::new(raw, metadata)
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

        let wb = {
            let c = raw.wb_coeffs;
            let usable = c[..3].iter().all(|v| v.is_finite() && *v > 0.0);
            let c = if usable { c } else { raw.neutralwb() };
            let g = if c[1] > 0.0 { c[1] } else { 1.0 };
            [c[0] / g, 1.0, c[2] / g]
        };

        let working_from_camera = match layout {
            Layout::Mono => color::IDENTITY,
            _ => color::working_from_camera(&raw.xyz_to_cam),
        };

        let orientation = Orient::from_exif(match raw.orientation {
            Orientation::Unknown => metadata.orientation.unwrap_or(1),
            o => o.to_u16(),
        });

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
            working_from_camera,
            orientation,
            metadata,
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
