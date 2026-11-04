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
//!
//! The working space is linear Rec.2020 with a D65 white. The base image is balanced
//! for D65 light, so every recipe since v6 starts with a colour calibration instance
//! that adapts it to the scene's light ("as shot" by default).

mod v2;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::metadata::PhotoMetadata;
pub use crate::shapes::Shape;

/// v2: the sigmoid tone mapper was replaced by filmic; shadows/highlights got their own section.
/// v3: a list of module instances instead of one section per module.
/// v4: filmic's latitude/balance became independent toe/shoulder sizes.
/// v5: filmic's toe/shoulder measure the linear share instead of the curved one.
/// v6: colour calibration replaces warmth/tint, and does the white balance.
pub const CURRENT_VERSION: u32 = 6;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "Value")]
pub struct EditParams {
    pub version: u32,
    /// In pipeline order (see [`EditParams::normalize`]).
    pub modules: Vec<ModuleInstance>,
    /// Drawn shapes by id, referenced by retouch spots (and later masks). Only the
    /// referenced ones are kept; left out of the JSON when there are none.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub shapes: BTreeMap<String, Shape>,
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
    /// Spot removal, on the base image (sensor frame), before lens correction.
    Retouch,
    /// Lens correction (distortion, TCA, vignetting), in the geometry stage. Single instance.
    Lens,
    /// Geometry stage: orientation, straighten, crop, resample. Single instance.
    Geometry,
    /// Spatial stage.
    Blur,
    Sharpen,
    ContrastEqualizer,
    /// Point stage (one fused pass), in linear Rec.2020.
    Exposure,
    /// White balance (chromatic adaptation) and channel mixing.
    ColorCalibration,
    Color,
    ShadowsHighlights,
    ColorPrimaries,
    /// Scene-referred → display-referred. Single instance.
    Filmic,
}

impl ModuleKind {
    /// Kinds whose extra instances are dropped on load.
    pub fn single_instance(self) -> bool {
        matches!(self, ModuleKind::Lens | ModuleKind::Geometry | ModuleKind::Filmic)
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
/// exposure push, white balance as shot (colour calibration) and filmic.
impl Default for EditParams {
    fn default() -> Self {
        let mut params = Self { version: CURRENT_VERSION, modules: Vec::new(), shapes: BTreeMap::new() };
        params.add(Exposure::default());
        params.add(ColorCalibration::default());
        params.add(Filmic::default());
        params
    }
}

impl EditParams {
    /// The recipe a new image starts with, given what its file contains: the default
    /// recipe, plus lens correction when the file embeds correction data. Must match
    /// `defaultRecipe` in TS.
    pub fn default_for(metadata: &PhotoMetadata) -> Self {
        let mut params = Self::default();
        if metadata.lens_correction.is_some() {
            params.add(Lens::default());
        }
        params
    }

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
    /// kinds (the first), pipeline order, no spots without their shape and no shapes
    /// that nothing uses. Must match `normalizeEditParams` in TS.
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

        let shapes = &self.shapes;
        for m in &mut self.modules {
            if let Module::Retouch(r) = &mut m.module {
                r.spots.retain(|s| shapes.contains_key(&s.shape));
            }
        }
        let used: std::collections::HashSet<String> = self.shape_refs().map(str::to_owned).collect();
        self.shapes.retain(|id, _| used.contains(id));
    }

    /// The ids of the shapes the modules refer to (enabled or not), in order, with repeats.
    pub fn shape_refs(&self) -> impl Iterator<Item = &str> {
        self.modules.iter().flat_map(|m| match &m.module {
            Module::Retouch(r) => r.spots.iter().map(|s| s.shape.as_str()).collect::<Vec<_>>(),
            _ => Vec::new(),
        })
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

    fn try_from(mut json: Value) -> Result<Self, Self::Error> {
        migrate_filmic(&mut json);
        let version = json.get("version").and_then(Value::as_u64).unwrap_or(0);
        let white_balance = if version < 6 { take_white_balance(&mut json) } else { Vec::new() };
        let mut params = if version >= 3 || json.get("modules").is_some() {
            let raw = match json.get("modules") {
                Some(modules) => Vec::<RawInstance>::deserialize(modules)?,
                None => Vec::new(),
            };
            let modules = raw
                .into_iter()
                .map(|m| Ok(ModuleInstance { id: m.id, label: m.label, enabled: m.enabled, module: Module::from_json(m.kind, m.params)? }))
                .collect::<serde_json::Result<_>>()?;
            let shapes = match json.get("shapes") {
                Some(Value::Null) | None => BTreeMap::new(),
                Some(shapes) => BTreeMap::<String, Shape>::deserialize(shapes)?,
            };
            EditParams { version: CURRENT_VERSION, modules, shapes }
        } else {
            serde_json::from_value::<v2::EditParams>(json)?.into()
        };
        if version < 6 {
            // The base image used to be balanced as shot; now colour calibration does it.
            let calibration = ColorCalibration::from_white_balance(&white_balance);
            params.modules.push(ModuleInstance { id: String::new(), label: None, enabled: true, module: calibration.into() });
        }
        params.normalize();
        Ok(params)
    }
}

/// Remove the warmth/tint white balance of a v1–v5 recipe; returns the enabled ones'
/// `(warmth, tint)`, in pipeline order. Must match `takeWhiteBalance` in TS.
fn take_white_balance(json: &mut Value) -> Vec<(f32, f32)> {
    let read = |params: Option<&Value>| {
        let get = |key: &str| params.and_then(|p| p.get(key)).and_then(Value::as_f64).unwrap_or(0.0) as f32;
        (get("warmth"), get("tint"))
    };
    if let Some(modules) = json.get_mut("modules").and_then(Value::as_array_mut) {
        let is_wb = |m: &Value| m.get("kind").and_then(Value::as_str) == Some("whiteBalance");
        let found = modules.iter().filter(|m| is_wb(m) && m.get("enabled").and_then(Value::as_bool) != Some(false)).map(|m| read(m.get("params"))).collect();
        modules.retain(|m| !is_wb(m));
        found
    } else {
        json.as_object_mut().and_then(|o| o.remove("whiteBalance")).map(|wb| vec![read(Some(&wb))]).unwrap_or_default()
    }
}

/// Filmic's toe and shoulder (v5: linear share of each side of middle grey, %) from
/// * v1–v3 `latitude` (width of the linear part, %) and `balance` (its shift,
///   -50 … +50 %). Exact when balance is 0; otherwise it assumes equal room on both
///   sides of grey, since the old balance mixed the two.
/// * v4 `toe`/`shoulder`, which were the curved share (100 % minus the v5 value).
///
/// Must match `migrateFilmic` in TS.
fn migrate_filmic(json: &mut Value) {
    let version = json.get("version").and_then(Value::as_u64).unwrap_or(0);
    let round = |v: f64| (v.clamp(0.0, 1.0) * 10_000.0).round() / 100.0;
    let fix = |params: &mut Value| {
        let Some(p) = params.as_object_mut() else { return };
        if p.contains_key("latitude") || p.contains_key("balance") {
            let latitude = p.remove("latitude").and_then(|v| v.as_f64()).unwrap_or(10.0).clamp(0.0, 100.0) / 100.0;
            let balance = p.remove("balance").and_then(|v| v.as_f64()).unwrap_or(0.0).clamp(-50.0, 50.0) / 100.0;
            p.entry("toe").or_insert_with(|| round(latitude * (1.0 + 2.0 * balance)).into());
            p.entry("shoulder").or_insert_with(|| round(latitude * (1.0 - 2.0 * balance)).into());
        } else if version == 4 {
            for key in ["toe", "shoulder"] {
                if let Some(curved) = p.get(key).and_then(Value::as_f64) {
                    p.insert(key.into(), round(1.0 - curved / 100.0).into());
                }
            }
        }
    };
    if let Some(modules) = json.get_mut("modules").and_then(Value::as_array_mut) {
        for m in modules.iter_mut().filter(|m| m.get("kind").and_then(Value::as_str) == Some("filmic")) {
            if let Some(params) = m.get_mut("params") {
                fix(params);
            }
        }
    } else if let Some(filmic) = json.get_mut("filmic") {
        fix(filmic);
    }
}

/// Spot removal (roadmap 4.4), after Ansel's `retouch.c` (see [`crate::ops::retouch`]):
/// each spot is a shape of the recipe and what to do inside it, applied in list order.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Retouch {
    pub spots: Vec<Spot>,
}

impl Retouch {
    pub fn is_identity(&self) -> bool {
        self.spots.is_empty()
    }
}

/// A retouch spot: shape `shape` of the recipe, filled according to `mode`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Spot {
    /// Id of the shape in `EditParams::shapes`.
    pub shape: String,
    pub mode: SpotMode,
    /// Heal and clone: where the pixels come from, as an offset from the shape in
    /// normalised sensor coordinates.
    pub source: [f32; 2],
    /// 0 … 1, on top of the shape's own opacity.
    pub opacity: f32,
    /// Fill: the colour, linear Rec.2020 (the base image's, balanced for D65 light).
    pub color: [f32; 3],
    /// Blur: Gaussian sigma in full-resolution pixels.
    pub radius: f32,
}

impl Default for Spot {
    fn default() -> Self {
        Self { shape: String::new(), mode: SpotMode::Heal, source: [0.0, 0.0], opacity: 1.0, color: [0.18, 0.18, 0.18], radius: 4.0 }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpotMode {
    /// Copy the source, then match it to the target's surroundings (Poisson blend).
    #[default]
    Heal,
    /// Copy the source as it is.
    Clone,
    /// Paint `color`.
    Fill,
    /// Blur what is there.
    Blur,
}

/// Lens correction from the data embedded in the file (see [`crate::lens`]). Each
/// strength scales the camera's correction: 0 is off, 1 as specified, up to 2.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Lens {
    pub distortion: f32,
    /// Transverse chromatic aberration.
    pub tca: f32,
    pub vignetting: f32,
}

impl Default for Lens {
    fn default() -> Self {
        Self { distortion: 1.0, tca: 1.0, vignetting: 1.0 }
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

/// Colour calibration, after Ansel's `channelmixerrgb.c` (see [`crate::ops::calibration`]):
/// chromatic adaptation from the scene's light to the working space's white (D65),
/// gamut compression, then mixing in the adaptation's space (RGB channels,
/// colourfulness, brightness and grey). Units are Ansel's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ColorCalibration {
    /// The light to adapt from.
    pub illuminant: Illuminant,
    /// Correlated colour temperature of the daylight and black body illuminants, in
    /// kelvin, 1667 … 25000.
    pub temperature: f32,
    pub fluorescent: Fluorescent,
    pub led: Led,
    /// Chromaticity of the custom illuminant (CIE 1931 xy).
    pub x: f32,
    pub y: f32,
    /// The space the light is adapted and colours are mixed in. "As shot" always uses CAT16.
    pub adaptation: Adaptation,
    /// Gamut compression, 0 … 12 (0 = off): pulls the most saturated bright colours
    /// toward white.
    pub gamut: f32,
    /// Clip negative values (colours outside the spectral locus) at each step.
    pub clip: bool,
    /// Output channels as a mix of the input ones, -2 … 2 each.
    pub red: [f32; 3],
    pub green: [f32; 3],
    pub blue: [f32; 3],
    /// Scale each mix so that its coefficients add up to 1 (greys stay grey).
    pub normalize_red: bool,
    pub normalize_green: bool,
    pub normalize_blue: bool,
    /// Colourfulness of colours along each channel, -1 … 1.
    pub colorfulness: [f32; 3],
    /// Make the colourfulness changes add up to 0.
    pub normalize_colorfulness: bool,
    /// Brightness of colours along each channel, -1 … 1.
    pub brightness: [f32; 3],
    pub normalize_brightness: bool,
    /// Monochrome: the output is this mix of the channels when any is non-zero, -2 … 2.
    pub grey: [f32; 3],
    pub normalize_grey: bool,
}

impl Default for ColorCalibration {
    fn default() -> Self {
        let [x, y] = crate::color::white_xy().map(|v| (v * 1e4).round() / 1e4);
        Self {
            illuminant: Illuminant::AsShot,
            // The working space's white, D65 (Ansel's 5003 K is its D50).
            temperature: 6504.0,
            fluorescent: Fluorescent::F3,
            led: Led::B5,
            x,
            y,
            adaptation: Adaptation::Cat16,
            gamut: 1.0,
            clip: true,
            red: [1.0, 0.0, 0.0],
            green: [0.0, 1.0, 0.0],
            blue: [0.0, 0.0, 1.0],
            normalize_red: true,
            normalize_green: true,
            normalize_blue: true,
            colorfulness: [0.0; 3],
            normalize_colorfulness: false,
            brightness: [0.0; 3],
            normalize_brightness: false,
            grey: [0.0; 3],
            normalize_grey: false,
        }
    }
}

impl ColorCalibration {
    /// The default, with the gains of v1–v5 warmth/tint instances (`(warmth, tint)`,
    /// applied after the white balance) folded into the channel mix. Must match
    /// `fromWhiteBalance` in TS.
    pub fn from_white_balance(instances: &[(f32, f32)]) -> Self {
        let mut p = Self::default();
        let mut gains = [1.0f64; 3];
        for &(warmth, tint) in instances {
            let warmth = warmth.clamp(-1.0, 1.0) as f64 * 0.5;
            let tint = tint.clamp(-1.0, 1.0) as f64 * 0.35;
            let wb = [warmth.exp2(), (-tint).exp2(), (-warmth).exp2()];
            // They preserved luminance.
            let luma = crate::color::LUMA_REC2020.map(f64::from);
            let y = wb[0] * luma[0] + wb[1] * luma[1] + wb[2] * luma[2];
            gains = [0, 1, 2].map(|c| gains[c] * (wb[c] / y));
        }
        if gains != [1.0; 3] {
            let round = |v: f64| ((v * 1e6).round() / 1e6 + 0.0) as f32;
            let mix = crate::ops::calibration::mix_for_rgb_gains(gains).map(|row| row.map(round));
            [p.red, p.green, p.blue] = mix;
            (p.normalize_red, p.normalize_green, p.normalize_blue) = (false, false, false);
        }
        p
    }
}

/// The light colour calibration adapts from. Ansel's, without the auto-detection
/// modes (a one-shot action here; it sets a daylight, black body or custom illuminant).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Illuminant {
    /// What the camera's white balance was set for.
    #[default]
    AsShot,
    /// The working space's white (D65): no adaptation.
    Pipeline,
    /// CIE daylight at `temperature` (black body below 4000 K).
    Daylight,
    /// Planckian (black body) radiator at `temperature`.
    BlackBody,
    /// CIE A (incandescent).
    A,
    /// CIE E (equal energy).
    E,
    Fluorescent,
    Led,
    /// `x`, `y`.
    Custom,
}

/// CIE fluorescent illuminants.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fluorescent {
    F1,
    F2,
    #[default]
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
}

/// CIE LED illuminants.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Led {
    B1,
    B2,
    B3,
    B4,
    #[default]
    B5,
    Bh1,
    Rgb1,
    V1,
    V2,
}

/// Chromatic adaptation transform. Ansel's non-linear Bradford is left out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Adaptation {
    /// CIECAM16's (the most accurate).
    #[default]
    Cat16,
    /// Bradford, as in ICC v4.
    LinearBradford,
    /// Von Kries scaling in XYZ.
    Xyz,
    /// None: mix in linear Rec.2020 and leave the light alone.
    None,
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

/// Colour primaries, after Ansel's `colorprimaries.c`: moves the six primary and
/// secondary colours of a recessed Rec.2020 gamut, and spreads those edits smoothly
/// over all colours. Units are Ansel's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ColorPrimaries {
    pub red: Primary,
    pub yellow: Primary,
    pub green: Primary,
    pub cyan: Primary,
    pub blue: Primary,
    pub magenta: Primary,
    /// Scene exposure of the brightest colour the edits reach, in EV, -2 … 16. Brighter
    /// pixels keep the edit at the gamut boundary.
    pub white_level: f32,
    /// How saturated the control colours are, 0 … 100 % of the Rec.2020 gamut.
    pub gamut_coverage: f32,
    /// Reach of each edit along brightness, 1 … 100 %.
    pub brightness_smoothing: f32,
    /// Reach of each edit along saturation, 0.01 … 2.
    pub saturation_smoothing: f32,
    /// Reach of each edit around the hue circle, in radians, 0.01 … 2π.
    pub hue_smoothing: f32,
    /// Saturation below which edits fade out, so greys stay grey; 0 … 2 (0 = off).
    pub neutral_protection: f32,
}

impl Default for ColorPrimaries {
    fn default() -> Self {
        Self {
            red: Primary::default(),
            yellow: Primary::default(),
            green: Primary::default(),
            cyan: Primary::default(),
            blue: Primary::default(),
            magenta: Primary::default(),
            white_level: 1.0,
            gamut_coverage: 67.0,
            brightness_smoothing: 100.0,
            // Ansel's 1/√2.
            saturation_smoothing: 0.7071,
            hue_smoothing: 0.7071,
            neutral_protection: 0.0,
        }
    }
}

impl ColorPrimaries {
    /// Red, yellow, green, cyan, blue, magenta.
    pub fn nodes(&self) -> [&Primary; 6] {
        [&self.red, &self.yellow, &self.green, &self.cyan, &self.blue, &self.magenta]
    }

    /// Whether any colour is moved; otherwise the module does nothing.
    pub fn is_identity(&self) -> bool {
        self.nodes().iter().all(|n| **n == Primary::default())
    }
}

/// The edit of one colour primary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Primary {
    /// Hue rotation in degrees, -180 … 180.
    pub hue: f32,
    /// Saturation shift in %, -100 … 100.
    pub saturation: f32,
    /// Brightness shift, -0.25 … 0.25.
    pub brightness: f32,
}

/// Number of control nodes of each contrast equalizer curve.
pub const EQUALIZER_NODES: usize = 6;

/// Contrast equalizer, after Ansel's `atrous.c`: local contrast and denoising per
/// detail size, from coarse (first node, about a fifth of the image) to fine (last
/// node, a few full-resolution pixels). Each curve passes through its six nodes,
/// evenly spaced; values are 0 … 1, as in Ansel.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContrastEqualizer {
    /// Luminance detail gain, `(2y)²`: 0.5 leaves the image alone, 1 is ×4.
    pub luma: [f32; EQUALIZER_NODES],
    /// Colour detail gain, like `luma`.
    pub chroma: [f32; EQUALIZER_NODES],
    /// Edge awareness: higher values keep strong edges out of the coarser sizes, which
    /// avoids halos. 0.5 by default.
    pub edges: [f32; EQUALIZER_NODES],
    /// Luminance noise threshold: detail weaker than this is removed. 0 = off.
    pub luma_denoise: [f32; EQUALIZER_NODES],
    /// Colour noise threshold, like `luma_denoise`.
    pub chroma_denoise: [f32; EQUALIZER_NODES],
    /// Strength of the curves relative to their defaults, -2 … 2 (1 = as drawn).
    pub mix: f32,
}

impl Default for ContrastEqualizer {
    fn default() -> Self {
        Self {
            luma: [0.5; EQUALIZER_NODES],
            chroma: [0.5; EQUALIZER_NODES],
            edges: [0.5; EQUALIZER_NODES],
            luma_denoise: [0.0; EQUALIZER_NODES],
            chroma_denoise: [0.0; EQUALIZER_NODES],
            mix: 1.0,
        }
    }
}

impl ContrastEqualizer {
    /// Whether the curves change the image (the edges curve alone doesn't).
    pub fn is_identity(&self) -> bool {
        let d = Self::default();
        self.mix == 0.0 || (self.luma == d.luma && self.chroma == d.chroma && self.luma_denoise == d.luma_denoise && self.chroma_denoise == d.chroma_denoise)
    }
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
    /// Toe: the linear share of the range between black and middle grey, 0 … 100 %
    /// (the rest is the curved toe). Higher is more contrast in the shadows.
    pub toe: f32,
    /// Shoulder: the linear share of the range between middle grey and white,
    /// 0 … 100 % (the rest is the curved shoulder).
    pub shoulder: f32,
    /// AgX hue recovery, -100 (keep the film-like hue drift) … +100 (original hues).
    pub hue_preservation: f32,
    /// How strongly bright saturated colours bleach toward white.
    pub bleach: Bleach,
    /// How much the white/black range is widened (+) or narrowed (-) from the unscaled
    /// one, in %, -50 … +200. Auto-tune applies it to the measured range; the editor
    /// keeps it in step with the white and black exposures.
    pub dynamic_range_scaling: f32,
}

impl Default for Filmic {
    fn default() -> Self {
        // Ansel's defaults for RAW files, paired with its +0.7 EV exposure default.
        Self {
            white_exposure: 3.15,
            black_exposure: -8.85,
            contrast: 1.18,
            // Ansel's latitude 10 %, balance 0.
            toe: 10.0,
            shoulder: 10.0,
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
    fn default_is_exposure_calibration_and_filmic() {
        let p = EditParams::default();
        assert_eq!(kinds(&p), [ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::Filmic]);
        assert_eq!(p.modules[1].id, "colorCalibration");
        assert_eq!(p.modules[0].id, "exposure");
        assert_eq!(p.get::<Exposure>().unwrap().ev, 0.7);
        assert_eq!(p.get::<Filmic>(), Some(&Filmic::default()));
    }

    #[test]
    fn default_for_adds_lens_correction_when_available() {
        let plain = PhotoMetadata::default();
        assert_eq!(EditParams::default_for(&plain), EditParams::default());
        let sony = PhotoMetadata { lens_correction: Some("sony".into()), ..Default::default() };
        let p = EditParams::default_for(&sony);
        assert_eq!(kinds(&p), [ModuleKind::Lens, ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::Filmic]);
        assert_eq!(p.modules[0].id, "lens");
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
        assert!(json.starts_with(r#"{"version":6,"modules":[{"id":"sharpen","label":null,"enabled":true,"kind":"sharpen","params":"#), "{json}");
        assert_eq!(EditParams::from_json(&json).unwrap(), p);
    }

    #[test]
    fn v3_partial_json_uses_defaults() {
        let p = EditParams::from_json(
            r#"{"version":3,"modules":[{"kind":"filmic","params":{"bleach":"extra"}},{"kind":"exposure","params":{"black":0.01}},{"kind":"blur"}]}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Blur, ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::Filmic]);
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
        assert_eq!(ids, ["a", "exposure", "exposure-3", "colorCalibration", "exposure-2", "filmic"]);
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
        assert!(EditParams::from_json(r#"{"version":6,"modules":[{"kind":"whiteBalance"}]}"#).is_err());
    }

    #[test]
    fn v6_recipes_are_left_alone() {
        let p = EditParams::from_json(r#"{"version":6,"modules":[{"kind":"exposure"}]}"#).unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Exposure]);
    }

    #[test]
    fn migrates_white_balance_to_calibration() {
        let p = EditParams::from_json(r#"{"version":5,"modules":[{"kind":"exposure"},{"kind":"filmic"}]}"#).unwrap();
        assert_eq!(p, EditParams::default());

        let p = EditParams::from_json(
            r#"{"version":5,"modules":[{"kind":"whiteBalance","params":{"warmth":0.4}},{"kind":"whiteBalance","enabled":false,"params":{"tint":1}},{"kind":"whiteBalance","params":{"tint":-0.2}}]}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::ColorCalibration]);
        let c = p.get::<ColorCalibration>().unwrap();
        assert_eq!((c.illuminant, c.normalize_red), (Illuminant::AsShot, false));
        // The same as warmth/tint gains in Rec.2020 after the white balance.
        let wb = |w: f32, t: f32| {
            let g = [(w * 0.5).exp2(), (-t * 0.35).exp2(), (-w * 0.5).exp2()];
            let y = crate::color::luminance(g);
            g.map(|v| v / y)
        };
        let (a, b) = (wb(0.4, 0.0), wb(0.0, -0.2));
        let gains = [0, 1, 2].map(|c| a[c] * b[c]);
        let mix = crate::ops::calibration::mix_for_rgb_gains(gains.map(f64::from));
        for (row, want) in [c.red, c.green, c.blue].iter().zip(mix) {
            for (got, want) in row.iter().zip(want) {
                assert!((*got as f64 - want).abs() < 2e-6, "{row:?}");
            }
        }

        let p = EditParams::from_json(r#"{"version":2,"whiteBalance":{"warmth":0.3}}"#).unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::Filmic]);
        assert_ne!(p.get::<ColorCalibration>(), Some(&ColorCalibration::default()));
    }

    #[test]
    fn migrates_v2() {
        let p = EditParams::from_json(
            r#"{"version":2,"exposure":{"ev":1.5},"geometry":{"rotation":1},"filmic":{"enabled":false,"bleach":"extra"},"sharpen":{"amount":0}}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Geometry, ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::Filmic]);
        assert_eq!(p.get::<Geometry>().unwrap().rotation, 1);
        assert_eq!(p.get::<Exposure>(), Some(&Exposure { ev: 1.5, black: 0.0 }));
        assert_eq!(p.get::<Filmic>(), None);
        let filmic = &p.modules[3];
        assert!(!filmic.enabled);
        assert_eq!(Filmic::get(&filmic.module).unwrap().bleach, Bleach::Extra);
    }

    #[test]
    fn migrates_filmic_latitude_to_toe_and_shoulder() {
        let filmic = |json: &str| EditParams::from_json(json).unwrap().get::<Filmic>().cloned().unwrap();
        let f = filmic(r#"{"version":3,"modules":[{"kind":"filmic","params":{"latitude":10,"balance":0}}]}"#);
        assert_eq!((f.toe, f.shoulder), (10.0, 10.0));
        let f = filmic(r#"{"version":3,"modules":[{"kind":"filmic","params":{"latitude":20,"balance":25}}]}"#);
        assert_eq!((f.toe, f.shoulder), (30.0, 10.0));
        let f = filmic(r#"{"version":2,"filmic":{"latitude":30}}"#);
        assert_eq!((f.toe, f.shoulder), (30.0, 30.0));
    }

    #[test]
    fn migrates_v4_curved_toe_and_shoulder() {
        let filmic = |json: &str| EditParams::from_json(json).unwrap().get::<Filmic>().cloned().unwrap();
        let f = filmic(r#"{"version":4,"modules":[{"kind":"filmic","params":{"toe":90,"shoulder":62.5}}]}"#);
        assert_eq!((f.toe, f.shoulder), (10.0, 37.5));
        let f = filmic(r#"{"version":5,"modules":[{"kind":"filmic","params":{"toe":90}}]}"#);
        assert_eq!((f.toe, f.shoulder), (90.0, 10.0));
    }

    #[test]
    fn migrates_v1() {
        let p = EditParams::from_json(r#"{"version":1,"exposure":{"ev":1.0},"toneMap":{"contrast":2}}"#).unwrap();
        assert_eq!(p.get::<Exposure>().unwrap().ev, 1.0);
        assert_eq!(p.get::<Filmic>(), Some(&Filmic::default()));
    }
}
