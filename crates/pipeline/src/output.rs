//! Output colour spaces: where the pipeline's last stage (filmic, or a plain clip
//! without it) lands, and how its values are encoded in the file.
//!
//! Previews are always sRGB. Exports can target a wider gamut: filmic then maps
//! colours into that space's gamut rather than sRGB's (as Ansel does with the export
//! profile), and the file embeds the matching ICC profile (`export::icc`).
//!
//! Mirrored in `packages/pipeline/src/export.ts` (`COLOR_SPACES`).

use serde::{Deserialize, Serialize};

use crate::color::{self, IDENTITY, Mat3, REC709_FROM_REC2020, XYZ_FROM_REC709};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColorSpace {
    #[default]
    Srgb,
    DisplayP3,
    AdobeRgb,
    Rec2020,
}

/// CIE xy chromaticities of red, green and blue.
type Primaries = [[f64; 2]; 3];

const P3_PRIMARIES: Primaries = [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]];
const ADOBE_RGB_PRIMARIES: Primaries = [[0.640, 0.330], [0.210, 0.710], [0.150, 0.060]];

/// Adobe RGB (1998)'s gamma: 2 + 51/256.
const ADOBE_RGB_GAMMA: f32 = 563.0 / 256.0;

/// BT.709/BT.2020 transfer function constants (the 12-bit values of BT.2020).
const BT_ALPHA: f32 = 1.099_296_8;
const BT_BETA: f32 = 0.018_053_968;

impl ColorSpace {
    pub const ALL: [ColorSpace; 4] = [ColorSpace::Srgb, ColorSpace::DisplayP3, ColorSpace::AdobeRgb, ColorSpace::Rec2020];

    /// Human-readable name, also the ICC profile's description.
    pub fn name(self) -> &'static str {
        match self {
            ColorSpace::Srgb => "sRGB",
            ColorSpace::DisplayP3 => "Display P3",
            ColorSpace::AdobeRgb => "Adobe RGB (1998) compatible",
            ColorSpace::Rec2020 => "Rec. 2020",
        }
    }

    /// Linear RGB in this space → CIE XYZ (D65).
    pub fn xyz_from_rgb(self) -> Mat3 {
        match self {
            ColorSpace::Srgb => XYZ_FROM_REC709,
            ColorSpace::DisplayP3 => xyz_from_primaries(&P3_PRIMARIES),
            ColorSpace::AdobeRgb => xyz_from_primaries(&ADOBE_RGB_PRIMARIES),
            ColorSpace::Rec2020 => color::xyz_from_rec2020(),
        }
    }

    /// CIE XYZ (D65) → linear RGB in this space.
    pub fn rgb_from_xyz(self) -> Mat3 {
        color::invert(&self.xyz_from_rgb()).expect("primaries are independent")
    }

    /// The working space (linear Rec.2020) → linear RGB in this space.
    pub fn from_working(self) -> Mat3 {
        match self {
            // The constant the previews have always used.
            ColorSpace::Srgb => REC709_FROM_REC2020,
            ColorSpace::Rec2020 => IDENTITY,
            _ => color::mul(&self.rgb_from_xyz(), &color::xyz_from_rec2020()),
        }
    }

    /// Opto-electronic transfer function: linear → encoded, input clamped to [0, 1].
    #[inline]
    pub fn oetf(self, v: f32) -> f32 {
        match self {
            ColorSpace::Srgb | ColorSpace::DisplayP3 => color::srgb_oetf(v),
            ColorSpace::AdobeRgb => v.clamp(0.0, 1.0).powf(1.0 / ADOBE_RGB_GAMMA),
            ColorSpace::Rec2020 => {
                let v = v.clamp(0.0, 1.0);
                if v < BT_BETA { 4.5 * v } else { BT_ALPHA * v.powf(0.45) - (BT_ALPHA - 1.0) }
            }
        }
    }

    /// Inverse of [`oetf`](Self::oetf): encoded → linear, input clamped to [0, 1].
    #[inline]
    pub fn eotf(self, v: f32) -> f32 {
        let v = v.clamp(0.0, 1.0);
        match self {
            ColorSpace::Srgb | ColorSpace::DisplayP3 => {
                if v <= 0.040_45 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
            }
            ColorSpace::AdobeRgb => v.powf(ADOBE_RGB_GAMMA),
            ColorSpace::Rec2020 => {
                if v < 4.5 * BT_BETA { v / 4.5 } else { ((v + BT_ALPHA - 1.0) / BT_ALPHA).powf(1.0 / 0.45) }
            }
        }
    }

    /// The pure gamma of the transfer function, if it is one (Adobe RGB's).
    pub fn gamma(self) -> Option<f32> {
        (self == ColorSpace::AdobeRgb).then_some(ADOBE_RGB_GAMMA)
    }

    /// An sRGB colour (encoded, 0–1) in this space (encoded, 0–1). Exact for sRGB.
    pub fn from_srgb(self, rgb: [f32; 3]) -> [f32; 3] {
        if self == ColorSpace::Srgb {
            return rgb;
        }
        let linear = rgb.map(|v| ColorSpace::Srgb.eotf(v));
        let m = color::mul(&self.rgb_from_xyz(), &XYZ_FROM_REC709);
        color::mul_vec(&m, linear).map(|v| self.oetf(v))
    }
}

/// RGB → XYZ for these primaries, with the working space's white (D65 as
/// [`XYZ_FROM_REC709`] has it, so that white stays exactly neutral).
fn xyz_from_primaries(p: &Primaries) -> Mat3 {
    let white: [f64; 3] = std::array::from_fn(|i| XYZ_FROM_REC709[i].iter().map(|&v| f64::from(v)).sum());
    // Columns: each primary's XYZ for Y = 1, scaled so that they add up to white.
    let cols: [[f64; 3]; 3] = p.map(|[x, y]| [x / y, 1.0, (1.0 - x - y) / y]);
    let m = [0, 1, 2].map(|r| [0, 1, 2].map(|c| cols[c][r]));
    let s = solve(&m, white);
    [0, 1, 2].map(|r| [0, 1, 2].map(|c| (m[r][c] * s[c]) as f32))
}

/// `m · x = b`, by Cramer's rule.
fn solve(m: &[[f64; 3]; 3], b: [f64; 3]) -> [f64; 3] {
    let det = |m: &[[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d = det(m);
    [0, 1, 2].map(|c| {
        let mut mc = *m;
        for r in 0..3 {
            mc[r][c] = b[r];
        }
        det(&mc) / d
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::mul_vec;

    #[test]
    fn transfer_functions_round_trip() {
        for space in ColorSpace::ALL {
            for i in 0..=100 {
                let v = i as f32 / 100.0;
                let back = space.eotf(space.oetf(v));
                assert!((back - v).abs() < 1e-5, "{space:?} {v}: {back}");
            }
        }
    }

    #[test]
    fn white_stays_white() {
        for space in ColorSpace::ALL {
            let w = mul_vec(&space.from_working(), [1.0; 3]);
            assert!(w.iter().all(|v| (v - 1.0).abs() < 1e-4), "{space:?}: {w:?}");
        }
    }

    #[test]
    fn known_matrices() {
        // Display P3's published RGB → XYZ (red column).
        let m = ColorSpace::DisplayP3.xyz_from_rgb();
        assert!((m[0][0] - 0.486_57).abs() < 1e-4 && (m[1][0] - 0.228_97).abs() < 1e-4, "{m:?}");
        // Adobe RGB's (green column).
        let m = ColorSpace::AdobeRgb.xyz_from_rgb();
        assert!((m[0][1] - 0.185_56).abs() < 1e-4 && (m[1][1] - 0.627_44).abs() < 1e-4, "{m:?}");
        // Rec.2020 → Rec.2020 is exact.
        assert_eq!(ColorSpace::Rec2020.from_working(), IDENTITY);
    }

    #[test]
    fn srgb_colours_convert() {
        assert_eq!(ColorSpace::Srgb.from_srgb([0.2, 0.4, 0.6]), [0.2, 0.4, 0.6]);
        for space in ColorSpace::ALL {
            let white = space.from_srgb([1.0; 3]);
            assert!(white.iter().all(|v| (v - 1.0).abs() < 1e-3), "{space:?}: {white:?}");
            // Pure sRGB red is inside every wider gamut, so less saturated there.
            let [r, g, b] = space.from_srgb([1.0, 0.0, 0.0]);
            assert!(r <= 1.0 && (space == ColorSpace::Srgb || g > 0.0) && b >= 0.0, "{space:?}: {r} {g} {b}");
        }
    }
}
