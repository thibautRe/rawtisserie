//! Edit parameters — the "recipe" applied to a RAW file.
//!
//! These are serialised as JSON (camelCase) and stored by the server next to each
//! photo; the TypeScript mirror lives in `packages/pipeline/src/params.ts`.
//! Every field has a default so that older/partial recipes keep deserialising.

use serde::{Deserialize, Serialize};

pub const CURRENT_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditParams {
    pub version: u32,
    pub exposure: Exposure,
    pub white_balance: WhiteBalance,
    pub color: Color,
    pub tone_map: ToneMap,
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
            tone_map: ToneMap::default(),
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

/// Sigmoid tone mapper (scene-referred → display-referred).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToneMap {
    pub enabled: bool,
    /// Slope of the curve around middle grey, typically 1.0 … 3.0.
    pub contrast: f32,
    /// Lifts (+) or crushes (-) shadows, -1 … +1.
    pub shadows: f32,
    /// Recovers (-) or boosts (+) highlights, -1 … +1.
    pub highlights: f32,
}

impl Default for ToneMap {
    fn default() -> Self {
        Self {
            enabled: true,
            contrast: 1.5,
            shadows: 0.0,
            highlights: 0.0,
        }
    }
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
        assert!(p.tone_map.enabled);
    }

    #[test]
    fn empty_json_is_default() {
        assert_eq!(EditParams::from_json("").unwrap(), EditParams::default());
        assert_eq!(EditParams::from_json("{}").unwrap(), EditParams::default());
    }
}
