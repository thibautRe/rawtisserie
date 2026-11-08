//! v1/v2 recipes: one fixed section per module. Read only, to migrate them to v3.
//!
//! v1 had a sigmoid tone mapper (`toneMap`); it is ignored, so v1 recipes get
//! filmic's defaults. Their white balance (warmth/tint) is taken out beforehand and
//! becomes colour calibration, as for v3–v5, and their colour and shadows/highlights
//! sections become colour balance, as for v3–v6. Must match `migrateV2` in
//! `packages/pipeline/src/params.ts`.

use serde::Deserialize;

use super::{Blur, ColorBalance, Exposure, Filmic, Geometry, Module, ModuleInstance, Sharpen};

/// v1–v6 colour section: saturation and vibrance. Becomes colour balance.
#[derive(Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(default)]
struct Color {
    saturation: f32,
    vibrance: f32,
}

/// v2–v6 shadows/highlights section. Becomes colour balance.
#[derive(Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(default)]
struct ShadowsHighlights {
    shadows: f32,
    highlights: f32,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct EditParams {
    exposure: Exposure,
    color: Color,
    shadows_highlights: ShadowsHighlights,
    filmic: FilmicV2,
    sharpen: Sharpen,
    blur: Blur,
    geometry: Geometry,
}

/// Filmic could be switched off in v2; v3 disables the instance instead.
#[derive(Deserialize)]
#[serde(default)]
struct FilmicV2 {
    enabled: bool,
    #[serde(flatten)]
    params: Filmic,
}

impl Default for FilmicV2 {
    fn default() -> Self {
        Self { enabled: true, params: Filmic::default() }
    }
}

/// Exposure and filmic always become instances (they are part of the default
/// recipe); the other sections only when they differ from their defaults.
impl From<EditParams> for super::EditParams {
    fn from(v2: EditParams) -> Self {
        let mut modules = Vec::new();
        let mut push = |enabled: bool, module: Module| modules.push(ModuleInstance { id: String::new(), label: None, enabled, module, mask: None });
        if v2.geometry != Geometry::default() {
            push(true, v2.geometry.into());
        }
        if v2.blur != Blur::default() {
            push(true, v2.blur.into());
        }
        if v2.sharpen != Sharpen::default() {
            push(true, v2.sharpen.into());
        }
        push(true, v2.exposure.into());
        // As in v3–v6 recipes (`migrate_color_balance`).
        if v2.color != Color::default() {
            push(true, ColorBalance::from_color(v2.color.saturation, v2.color.vibrance).into());
        }
        let sh = v2.shadows_highlights;
        if sh != ShadowsHighlights::default() {
            push(true, ColorBalance::from_shadows_highlights(sh.shadows, sh.highlights).into());
        }
        push(v2.filmic.enabled, v2.filmic.params.into());
        super::EditParams { version: super::CURRENT_VERSION, modules, shapes: Default::default() }
    }
}
