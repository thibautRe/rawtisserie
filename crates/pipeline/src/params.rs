//! Edit parameters — the "recipe" applied to a RAW file.
//!
//! A recipe is a list of module instances. The pipeline order is fixed by module
//! kind (the declaration order of [`ModuleKind`]); instances of the same kind run in
//! list order. A kind with no enabled instance is skipped, so an empty list renders
//! the camera's colours without exposure or tone mapping.
//!
//! Recipes are serialised as JSON (camelCase) and stored by the server next to each
//! photo; the TypeScript mirror lives in `packages/pipeline/src/params.ts`. Every
//! field has a default so that older/partial recipes keep deserialising, and v1/v2
//! recipes (one fixed section per module) are migrated on load.

mod v2;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// v2: the sigmoid tone mapper was replaced by filmic; shadows/highlights got their own section.
/// v3: a list of module instances instead of one section per module.
pub const CURRENT_VERSION: u32 = 3;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "Value")]
pub struct EditParams {
    pub version: u32,
    /// In pipeline order (see [`EditParams::normalize`]).
    pub modules: Vec<ModuleInstance>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModuleInstance {
    /// Unique within the recipe; stable across edits (history entries refer to it).
    pub id: String,
    /// Shown next to the module name, to tell instances apart ("sky").
    pub label: Option<String>,
    pub enabled: bool,
    /// Serialised as `"kind"` and `"params"`.
    #[serde(flatten)]
    pub module: Module,
}

/// Implemented by the parameters of each module kind.
pub trait ModuleParams: Default + Into<Module> + 'static {
    const KIND: ModuleKind;
    fn get(module: &Module) -> Option<&Self>;
    fn get_mut(module: &mut Module) -> Option<&mut Self>;
}

macro_rules! modules {
    ($($(#[$doc:meta])* $kind:ident),* $(,)?) => {
        /// A module and its parameters.
        #[derive(Clone, Debug, PartialEq, Serialize)]
        #[serde(tag = "kind", content = "params", rename_all = "camelCase")]
        pub enum Module {
            $($kind($kind)),*
        }

        /// Module kinds, in pipeline order.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum ModuleKind {
            $($(#[$doc])* $kind),*
        }

        impl ModuleKind {
            pub const ALL: &[ModuleKind] = &[$(ModuleKind::$kind),*];
        }

        impl Module {
            pub fn kind(&self) -> ModuleKind {
                match self {
                    $(Module::$kind(_) => ModuleKind::$kind),*
                }
            }

            /// A module with default parameters.
            pub fn default_for(kind: ModuleKind) -> Self {
                match kind {
                    $(ModuleKind::$kind => Module::$kind($kind::default())),*
                }
            }

            /// Missing (`null`) parameters are the defaults, and so are missing fields.
            fn from_json(kind: ModuleKind, params: Value) -> serde_json::Result<Self> {
                if params.is_null() {
                    return Ok(Self::default_for(kind));
                }
                Ok(match kind {
                    $(ModuleKind::$kind => Module::$kind(serde_json::from_value(params)?)),*
                })
            }
        }

        $(
            impl ModuleParams for $kind {
                const KIND: ModuleKind = ModuleKind::$kind;

                fn get(module: &Module) -> Option<&Self> {
                    match module {
                        Module::$kind(p) => Some(p),
                        #[allow(unreachable_patterns)]
                        _ => None,
                    }
                }

                fn get_mut(module: &mut Module) -> Option<&mut Self> {
                    match module {
                        Module::$kind(p) => Some(p),
                        #[allow(unreachable_patterns)]
                        _ => None,
                    }
                }
            }

            impl From<$kind> for Module {
                fn from(p: $kind) -> Self {
                    Module::$kind(p)
                }
            }
        )*
    };
}

modules! {
    /// Geometry stage: orientation, straighten, crop, resample. Single instance.
    Geometry,
    /// Spatial stage.
    Blur,
    Sharpen,
    /// Point stage (one fused pass), in linear Rec.2020.
    Exposure,
    WhiteBalance,
    Color,
    ShadowsHighlights,
    /// Scene-referred → display-referred. Single instance.
    Filmic,
}

impl ModuleKind {
    /// Kinds whose extra instances are dropped on load.
    pub fn single_instance(self) -> bool {
        matches!(self, ModuleKind::Geometry | ModuleKind::Filmic)
    }

    /// The camelCase name used in JSON, also the id of the first instance.
    pub fn name(self) -> String {
        match serde_json::to_value(self) {
            Ok(Value::String(s)) => s,
            _ => unreachable!("module kinds serialise as strings"),
        }
    }
}

/// The recipe a new image starts with: Ansel's defaults for RAW files, a +0.7 EV
/// exposure push and filmic.
impl Default for EditParams {
    fn default() -> Self {
        let mut params = Self { version: CURRENT_VERSION, modules: Vec::new() };
        params.add(Exposure::default());
        params.add(Filmic::default());
        params
    }
}

impl EditParams {
    pub fn from_json(json: &str) -> crate::Result<Self> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        Ok(serde_json::from_str(json)?)
    }

    /// Enabled instances of a kind, in pipeline order.
    pub fn all<T: ModuleParams>(&self) -> impl Iterator<Item = &T> {
        self.modules.iter().filter(|m| m.enabled).filter_map(|m| T::get(&m.module))
    }

    /// The first enabled instance of a kind.
    pub fn get<T: ModuleParams>(&self) -> Option<&T> {
        self.all().next()
    }

    /// The first instance of a kind, enabled, or a new one with default parameters.
    pub fn get_mut<T: ModuleParams>(&mut self) -> &mut T {
        let i = match self.modules.iter().position(|m| m.module.kind() == T::KIND) {
            Some(i) => i,
            None => self.add(T::default()),
        };
        let instance = &mut self.modules[i];
        instance.enabled = true;
        T::get_mut(&mut instance.module).expect("instance has the right kind")
    }

    /// Remove all instances of a kind.
    pub fn remove(&mut self, kind: ModuleKind) {
        self.modules.retain(|m| m.module.kind() != kind);
    }

    /// Append an enabled instance after the others of its kind; returns its index.
    pub fn add(&mut self, module: impl Into<Module>) -> usize {
        let module = module.into();
        let kind = module.kind();
        let id = self.fresh_id(kind, |_| false);
        let i = self.modules.partition_point(|m| m.module.kind() <= kind);
        self.modules.insert(i, ModuleInstance { id, label: None, enabled: true, module });
        i
    }

    /// `kind`, or `kind-2`, `kind-3`… : the first id that isn't taken.
    fn fresh_id(&self, kind: ModuleKind, taken: impl Fn(&str) -> bool) -> String {
        let name = kind.name();
        let free = |id: &str| !taken(id) && !self.modules.iter().any(|m| m.id == id);
        if free(&name) {
            return name;
        }
        (2..).map(|n| format!("{name}-{n}")).find(|id| free(id)).expect("unbounded")
    }

    /// Make a recipe valid: unique non-empty ids, one instance of single-instance
    /// kinds (the first), and pipeline order. Must match `normalizeEditParams` in TS.
    pub fn normalize(&mut self) {
        self.version = CURRENT_VERSION;
        let mut seen = std::collections::HashSet::new();
        self.modules.retain(|m| !m.module.kind().single_instance() || seen.insert(m.module.kind()));
        self.modules.sort_by_key(|m| m.module.kind()); // stable

        let mut ids = std::collections::HashSet::new();
        for i in 0..self.modules.len() {
            if self.modules[i].id.is_empty() || ids.contains(&self.modules[i].id) {
                let kind = self.modules[i].module.kind();
                self.modules[i].id = String::new();
                self.modules[i].id = self.fresh_id(kind, |id| ids.contains(id));
            }
            ids.insert(self.modules[i].id.clone());
        }
    }
}

/// A module instance as stored, before validation.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInstance {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default = "yes")]
    enabled: bool,
    kind: ModuleKind,
    #[serde(default)]
    params: Value,
}

fn yes() -> bool {
    true
}

impl TryFrom<Value> for EditParams {
    type Error = serde_json::Error;

    fn try_from(json: Value) -> Result<Self, Self::Error> {
        let version = json.get("version").and_then(Value::as_u64).unwrap_or(0);
        let mut params = if version >= 3 || json.get("modules").is_some() {
            let raw = match json.get("modules") {
                Some(modules) => Vec::<RawInstance>::deserialize(modules)?,
                None => Vec::new(),
            };
            let modules = raw
                .into_iter()
                .map(|m| Ok(ModuleInstance { id: m.id, label: m.label, enabled: m.enabled, module: Module::from_json(m.kind, m.params)? }))
                .collect::<serde_json::Result<_>>()?;
            EditParams { version: CURRENT_VERSION, modules }
        } else {
            serde_json::from_value::<v2::EditParams>(json)?.into()
        };
        params.normalize();
        Ok(params)
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

    fn kinds(p: &EditParams) -> Vec<ModuleKind> {
        p.modules.iter().map(|m| m.module.kind()).collect()
    }

    #[test]
    fn default_is_exposure_and_filmic() {
        let p = EditParams::default();
        assert_eq!(kinds(&p), [ModuleKind::Exposure, ModuleKind::Filmic]);
        assert_eq!(p.modules[0].id, "exposure");
        assert_eq!(p.get::<Exposure>().unwrap().ev, 0.7);
        assert_eq!(p.get::<Filmic>(), Some(&Filmic::default()));
    }

    #[test]
    fn empty_json_is_default() {
        assert_eq!(EditParams::from_json("").unwrap(), EditParams::default());
        assert_eq!(EditParams::from_json("{}").unwrap(), EditParams::default());
    }

    #[test]
    fn round_trips() {
        let mut p = EditParams::default();
        p.get_mut::<Sharpen>().amount = 0.5;
        p.add(Exposure { ev: -1.0, black: 0.0 });
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.starts_with(r#"{"version":3,"modules":[{"id":"sharpen","label":null,"enabled":true,"kind":"sharpen","params":"#), "{json}");
        assert_eq!(EditParams::from_json(&json).unwrap(), p);
    }

    #[test]
    fn v3_partial_json_uses_defaults() {
        let p = EditParams::from_json(
            r#"{"version":3,"modules":[{"kind":"filmic","params":{"bleach":"extra"}},{"kind":"exposure","params":{"black":0.01}},{"kind":"blur"}]}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Blur, ModuleKind::Exposure, ModuleKind::Filmic]);
        assert_eq!(p.get::<Exposure>(), Some(&Exposure { ev: 0.7, black: 0.01 }));
        assert_eq!(p.get::<Filmic>().unwrap().bleach, Bleach::Extra);
        assert!(p.modules.iter().all(|m| m.enabled && m.label.is_none()));
    }

    #[test]
    fn normalize_fixes_ids_and_single_instances() {
        let p = EditParams::from_json(
            r#"{"version":3,"modules":[
                {"id":"a","kind":"exposure"},{"id":"a","kind":"exposure"},{"kind":"exposure"},
                {"id":"exposure-2","kind":"color"},
                {"kind":"filmic","params":{"contrast":2}},{"kind":"filmic","params":{"contrast":3}}]}"#,
        )
        .unwrap();
        let ids: Vec<_> = p.modules.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["a", "exposure", "exposure-3", "exposure-2", "filmic"]);
        assert_eq!(p.get::<Filmic>().unwrap().contrast, 2.0);
    }

    #[test]
    fn disabled_instances_are_skipped() {
        let p = EditParams::from_json(r#"{"modules":[{"kind":"exposure","enabled":false,"params":{"ev":2}},{"kind":"exposure","params":{"ev":1}}]}"#).unwrap();
        assert_eq!(p.all::<Exposure>().map(|e| e.ev).collect::<Vec<_>>(), [1.0]);
    }

    #[test]
    fn unknown_kinds_are_an_error() {
        assert!(EditParams::from_json(r#"{"version":3,"modules":[{"kind":"teleport"}]}"#).is_err());
    }

    #[test]
    fn migrates_v2() {
        let p = EditParams::from_json(
            r#"{"version":2,"exposure":{"ev":1.5},"geometry":{"rotation":1},"filmic":{"enabled":false,"bleach":"extra"},"sharpen":{"amount":0}}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Geometry, ModuleKind::Exposure, ModuleKind::Filmic]);
        assert_eq!(p.get::<Geometry>().unwrap().rotation, 1);
        assert_eq!(p.get::<Exposure>(), Some(&Exposure { ev: 1.5, black: 0.0 }));
        assert_eq!(p.get::<Filmic>(), None);
        let filmic = &p.modules[2];
        assert!(!filmic.enabled);
        assert_eq!(Filmic::get(&filmic.module).unwrap().bleach, Bleach::Extra);
    }

    #[test]
    fn migrates_v1() {
        let p = EditParams::from_json(r#"{"version":1,"exposure":{"ev":1.0},"toneMap":{"contrast":2}}"#).unwrap();
        assert_eq!(p.get::<Exposure>().unwrap().ev, 1.0);
        assert_eq!(p.get::<Filmic>(), Some(&Filmic::default()));
    }
}
