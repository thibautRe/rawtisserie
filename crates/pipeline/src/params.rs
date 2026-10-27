//! Edit parameters — the "recipe" applied to a RAW file.
//!
//! These are serialised as JSON (camelCase) and stored by the server next to each
//! photo; the TypeScript mirror lives in `packages/pipeline/src/params.ts`.
//! Every field has a default so that older/partial recipes keep deserialising.

use serde::{Deserialize, Serialize};

/// v2: the sigmoid tone mapper was replaced by filmic; shadows/highlights got their own section.
pub const CURRENT_VERSION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditParams {
    pub version: u32,
    pub exposure: Exposure,
    pub white_balance: WhiteBalance,
    pub color: Color,
    pub shadows_highlights: ShadowsHighlights,
    pub filmic: Filmic,
    pub sharpen: Sharpen,
    pub blur: Blur,
    pub geometry: Geometry,
}

impl Default for EditParams {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            exposure: Exposure::default(),
            white_balance: WhiteBalance::default(),
            color: Color::default(),
            shadows_highlights: ShadowsHighlights::default(),
            filmic: Filmic::default(),
            sharpen: Sharpen::default(),
            blur: Blur::default(),
            geometry: Geometry::default(),
        }
    }
}

impl EditParams {
    pub fn from_json(json: &str) -> crate::Result<Self> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        Ok(serde_json::from_str(json)?)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Exposure {
    /// Exposure compensation in EV. RAW files are usually exposed to protect
    /// highlights, so like Ansel we default to a small push.
    pub ev: f32,
    /// Scene-linear black level offset, subtracted before the exposure gain.
    pub black: f32,
}

impl Default for Exposure {
    fn default() -> Self {
        Self { ev: 0.7, black: 0.0 }
    }
}

/// Adjustments relative to the white balance recorded by the camera.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WhiteBalance {
    /// -1 (cooler/blue) … +1 (warmer/amber).
    pub warmth: f32,
    /// -1 (green) … +1 (magenta).
    pub tint: f32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Color {
    /// -1 (monochrome) … +1 (double chroma).
    pub saturation: f32,
    /// Like saturation, but favours muted colours. -1 … +1.
    pub vibrance: f32,
}

/// Global shadows/highlights: exposure gains driven by each pixel's luminance.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShadowsHighlights {
    /// Lifts (+) or crushes (-) shadows, -1 … +1.
    pub shadows: f32,
    /// Recovers (-) or boosts (+) highlights, -1 … +1.
    pub highlights: f32,
}

/// Filmic RGB tone mapping (scene-referred → display-referred), after Ansel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Filmic {
    pub enabled: bool,
    /// Scene exposure mapped to display white, in EV relative to middle grey.
    pub white_exposure: f32,
    /// Scene exposure mapped to display black, in EV relative to middle grey (negative).
    pub black_exposure: f32,
    /// Slope of the curve's linear part, 0 … 5.
    pub contrast: f32,
    /// Width of the linear part, in % of the room available around middle grey.
    pub latitude: f32,
    /// Shifts the linear part toward shadows (-) or highlights (+), -50 … +50 %.
    pub balance: f32,
    /// AgX hue recovery, -100 (keep the film-like hue drift) … +100 (original hues).
    pub hue_preservation: f32,
    /// How strongly bright saturated colours bleach toward white.
    pub bleach: Bleach,
    /// Widens (+) or narrows (-) the range found by auto-tune, in %, -50 … +200.
    pub dynamic_range_scaling: f32,
}

impl Default for Filmic {
    fn default() -> Self {
        // Ansel's defaults for RAW files, paired with its +0.7 EV exposure default.
        Self {
            enabled: true,
            white_exposure: 3.15,
            black_exposure: -8.85,
            contrast: 1.18,
            latitude: 10.0,
            balance: 0.0,
            hue_preservation: 0.0,
            bleach: Bleach::Medium,
            dynamic_range_scaling: 0.0,
        }
    }
}

/// The five Ansel v8 "AgX" colour science variants.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Bleach {
    None,
    Low,
    #[default]
    Medium,
    High,
    Extra,
}

/// Unsharp mask on luminance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sharpen {
    /// 0 disables sharpening; 0.5 is gentle, 2 is a lot.
    pub amount: f32,
    /// Gaussian sigma, in full-resolution pixels.
    pub radius: f32,
}

impl Default for Sharpen {
    fn default() -> Self {
        Self { amount: 0.0, radius: 1.0 }
    }
}

/// Gaussian blur.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Blur {
    /// Gaussian sigma, in full-resolution pixels. 0 disables the blur.
    pub radius: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Geometry {
    /// Additional clockwise quarter turns on top of the camera orientation (0…3).
    pub rotation: u8,
    /// Mirror horizontally, after rotation.
    pub flip_horizontal: bool,
    /// Straighten angle in degrees (clockwise positive), -45 … +45. The image is
    /// scaled up just enough that no empty corners appear.
    pub angle: f32,
    /// Crop rectangle, normalised to the oriented and straightened frame.
    pub crop: Crop,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            rotation: 0,
            flip_horizontal: false,
            angle: 0.0,
            crop: Crop::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Crop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Default for Crop {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }
}

impl Crop {
    /// Clamp the rectangle to the unit square, with a minimum size.
    pub fn sanitized(&self) -> Crop {
        const MIN: f32 = 0.01;
        let x = self.x.clamp(0.0, 1.0 - MIN);
        let y = self.y.clamp(0.0, 1.0 - MIN);
        Crop {
            x,
            y,
            width: self.width.clamp(MIN, 1.0 - x),
            height: self.height.clamp(MIN, 1.0 - y),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_json_uses_defaults() {
        let p = EditParams::from_json(r#"{"exposure":{"ev":1.5},"geometry":{"rotation":1}}"#).unwrap();
        assert_eq!(p.exposure.ev, 1.5);
        assert_eq!(p.exposure.black, 0.0);
        assert_eq!(p.geometry.rotation, 1);
        assert_eq!(p.geometry.crop, Crop::default());
        assert!(p.filmic.enabled);
        assert_eq!(p.filmic.bleach, Bleach::Medium);
    }

    #[test]
    fn version_1_recipes_still_load() {
        let p = EditParams::from_json(r#"{"version":1,"exposure":{"ev":1.0},"toneMap":{"contrast":2}}"#).unwrap();
        assert_eq!(p.exposure.ev, 1.0);
        assert_eq!(p.filmic, Filmic::default());
    }

    #[test]
    fn bleach_is_camel_case() {
        let p = EditParams::from_json(r#"{"filmic":{"bleach":"extra"}}"#).unwrap();
        assert_eq!(p.filmic.bleach, Bleach::Extra);
    }

    #[test]
    fn empty_json_is_default() {
        assert_eq!(EditParams::from_json("").unwrap(), EditParams::default());
        assert_eq!(EditParams::from_json("{}").unwrap(), EditParams::default());
    }
}
