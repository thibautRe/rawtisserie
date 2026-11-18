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
/// v7: colour balance replaces colour (saturation/vibrance) and shadows/highlights.
/// v8: colour balance's global chroma, saturation and brilliance are added to each
///     range's (the ranges' weights add up to 1, so it looks the same).
pub const CURRENT_VERSION: u32 = 8;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "Value")]
pub struct EditParams {
    pub version: u32,
    /// In pipeline order (see [`EditParams::normalize`]).
    pub modules: Vec<ModuleInstance>,
    /// Drawn shapes by id, referenced by retouch spots and masks. Only the referenced
    /// ones are kept; left out of the JSON when there are none.
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
    /// Where the instance applies (roadmap 4.5); everywhere without one. Only kinds that
    /// [`ModuleKind::maskable`] keep theirs. Left out of the JSON when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask: Option<Mask>,
    /// Its auto-tune is to run (roadmap 8.7: a preset or style asked for it), and hasn't
    /// yet: the renderer that resolves it (in TS) writes the values and drops the flag.
    /// Rendering ignores it. Only kinds that [`ModuleKind::auto_tunable`] keep it; left
    /// out of the JSON when false.
    #[serde(rename = "autoTune", skip_serializing_if = "std::ops::Not::not")]
    pub auto_tune: bool,
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
    /// Raw denoise (AI), on the sensor's mosaic before demosaicing. Single instance, RAW
    /// files only.
    RawDenoise,
    /// Spot removal, on the base image (sensor frame), before lens correction.
    Retouch,
    /// Lens correction (distortion, TCA, vignetting), in the geometry stage. Single instance.
    Lens,
    /// Geometry stage: orientation, straighten, crop, resample. Single instance.
    Geometry,
    /// Spatial stage. Diffuse or sharpen first: deblurring wants the unblurred image.
    Diffuse,
    ContrastEqualizer,
    /// Light spreading from the highlights (bloom, halation), added to the image.
    Glow,
    /// Point stage (one fused pass), in linear Rec.2020.
    Exposure,
    /// White balance (chromatic adaptation) and channel mixing.
    ColorCalibration,
    /// Grading by tonal range: chroma, saturation and brilliance (Ansel's colour balance
    /// rgb), and a light correction and channel mix per range (its split-toning rgb).
    ColorBalance,
    ColorPrimaries,
    ToneCurve,
    /// Scene-referred → display-referred. Single instance.
    Filmic,
    /// Display-referred, after filmic: creative 3D LUTs.
    Lut,
}

impl ModuleKind {
    /// Kinds whose extra instances are dropped on load.
    pub fn single_instance(self) -> bool {
        matches!(self, ModuleKind::RawDenoise | ModuleKind::Lens | ModuleKind::Geometry | ModuleKind::Filmic)
    }

    /// Kinds with an auto-tune a preset or style can ask for: filmic's white and black
    /// exposure, the tone curve's node range. Must match `AUTO_TUNE_KINDS` in TS.
    pub fn auto_tunable(self) -> bool {
        matches!(self, ModuleKind::Filmic | ModuleKind::ToneCurve)
    }

    /// Kinds whose instances can have a [`Mask`]: the spatial and point modules before
    /// filmic, and the creative LUTs after it. Must match `MASKABLE_KINDS` in TS.
    pub fn maskable(self) -> bool {
        matches!(
            self,
            ModuleKind::Diffuse
                | ModuleKind::ContrastEqualizer
                | ModuleKind::Glow
                | ModuleKind::Exposure
                | ModuleKind::ColorCalibration
                | ModuleKind::ColorBalance
                | ModuleKind::ColorPrimaries
                | ModuleKind::ToneCurve
                | ModuleKind::Lut
        )
    }

    /// Whether the kind blends display-referred (after filmic, on encoded sRGB) rather
    /// than scene-referred (see [`crate::ops::blend`]).
    pub fn display_referred(self) -> bool {
        self > ModuleKind::Filmic
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
/// exposure push, white balance as shot (colour calibration), colour balance's
/// "Colorfulness: standard" preset and filmic, marked for its auto-tune (whoever has
/// the image runs it; renderers ignore the mark). Must match `defaultEditParams` in TS.
impl Default for EditParams {
    fn default() -> Self {
        let mut params = Self { version: CURRENT_VERSION, modules: Vec::new(), shapes: BTreeMap::new() };
        params.add(Exposure::default());
        params.add(ColorCalibration::default());
        params.add(ColorBalance { saturation: [0.45, 0.2, 0.2], ..ColorBalance::default() });
        let filmic = params.add(Filmic::default());
        params.modules[filmic].auto_tune = true;
        params
    }
}

impl EditParams {
    /// The recipe a new image starts with, given what its file contains: the default
    /// recipe, plus lens correction when the file embeds correction data; nothing for
    /// an image that isn't a RAW file (it's developed already). Must match
    /// `defaultRecipe` in TS.
    pub fn default_for(metadata: &PhotoMetadata) -> Self {
        if metadata.image_format.is_some() {
            return Self { modules: Vec::new(), ..Self::default() };
        }
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
        self.modules.insert(i, ModuleInstance { id, label: None, enabled: true, module, mask: None, auto_tune: false });
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
    /// kinds (the first), pipeline order, masks only on maskable kinds, no spots or
    /// drawn mask parts without their shape, and no shapes that nothing uses. Must match
    /// `normalizeEditParams` in TS.
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
            if !m.module.kind().maskable() {
                m.mask = None;
            }
            m.auto_tune &= m.module.kind().auto_tunable();
            if let Some(mask) = &mut m.mask {
                mask.drawn.retain(|d| shapes.contains_key(&d.shape));
            }
        }
        let used: std::collections::HashSet<String> = self.shape_refs().map(str::to_owned).collect();
        self.shapes.retain(|id, _| used.contains(id));
    }

    /// The ids of the shapes the modules refer to (enabled or not), in order, with
    /// repeats: retouch spots, then the instance's mask.
    pub fn shape_refs(&self) -> impl Iterator<Item = &str> {
        self.modules.iter().flat_map(|m| {
            let spots = match &m.module {
                Module::Retouch(r) => r.spots.iter().map(|s| s.shape.as_str()).collect::<Vec<_>>(),
                _ => Vec::new(),
            };
            let mask = m.mask.iter().flat_map(|mask| mask.drawn.iter().map(|d| d.shape.as_str()));
            spots.into_iter().chain(mask).collect::<Vec<_>>()
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
    #[serde(default)]
    mask: Option<Mask>,
    /// Only `true` counts: anything else is no auto-tune, rather than an invalid recipe.
    #[serde(default, deserialize_with = "is_true")]
    auto_tune: bool,
}

fn yes() -> bool {
    true
}

fn is_true<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(d)? == Value::Bool(true))
}

impl TryFrom<Value> for EditParams {
    type Error = serde_json::Error;

    fn try_from(mut json: Value) -> Result<Self, Self::Error> {
        migrate_filmic(&mut json);
        let version = json.get("version").and_then(Value::as_u64).unwrap_or(0);
        let white_balance = if version < 6 { take_white_balance(&mut json) } else { Vec::new() };
        if version < 7 {
            migrate_color_balance(&mut json);
        }
        let mut params = if version >= 3 || json.get("modules").is_some() {
            let raw = match json.get("modules") {
                Some(modules) => Vec::<RawInstance>::deserialize(&retire_kinds(modules))?,
                None => Vec::new(),
            };
            let modules = raw
                .into_iter()
                .map(|m| Ok(ModuleInstance {
                        id: m.id,
                        label: m.label,
                        enabled: m.enabled,
                        module: Module::from_json(m.kind, m.params)?,
                        mask: m.mask,
                        auto_tune: m.auto_tune,
                    }))
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
            params.modules.push(ModuleInstance { id: String::new(), label: None, enabled: true, module: calibration.into(), mask: None, auto_tune: false });
        }
        params.normalize();
        Ok(params)
    }
}

/// Kinds that were removed, and whose instances are dropped on load (without
/// migrating them): the blur and the unsharp mask, which diffuse or sharpen replaces.
/// (TS drops every unknown kind.)
const RETIRED_KINDS: [&str; 2] = ["blur", "sharpen"];

/// `modules` without the instances of retired kinds.
fn retire_kinds(modules: &Value) -> Value {
    match modules {
        Value::Array(list) => Value::Array(
            list.iter().filter(|m| !m.get("kind").and_then(Value::as_str).is_some_and(|k| RETIRED_KINDS.contains(&k))).cloned().collect(),
        ),
        other => other.clone(),
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

/// v1–v6 colour (saturation/vibrance) and shadows/highlights instances become colour
/// balance instances, keeping their id, label, switch and mask (v1/v2 sections are
/// handled in `v2.rs`). The look is only approximated. Must match `migrateColorBalance`
/// in TS.
fn migrate_color_balance(json: &mut Value) {
    let Some(modules) = json.get_mut("modules").and_then(Value::as_array_mut) else { return };
    for m in modules.iter_mut() {
        let kind = m.get("kind").and_then(Value::as_str);
        let get = |key: &str| m.get("params").and_then(|p| p.get(key)).and_then(Value::as_f64).unwrap_or(0.0) as f32;
        let params = match kind {
            Some("color") => ColorBalance::from_color(get("saturation"), get("vibrance")),
            Some("shadowsHighlights") => ColorBalance::from_shadows_highlights(get("shadows"), get("highlights")),
            _ => continue,
        };
        m["kind"] = "colorBalance".into();
        m["params"] = serde_json::to_value(params).expect("colour balance serialises");
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

/// Where a module instance applies (roadmap 4.5), 0 … 1 per pixel: its output is
/// blended with its input by this amount. See [`crate::ops::mask`] for how it's evaluated.
///
/// The mask is the drawn part (shapes) times the parametric part (ranges measured on
/// the module's input), feathered, then inverted if asked, times `opacity`. Without
/// drawn shapes the drawn part is 1 everywhere; a range left out selects everything.
/// Switched off, the instance applies everywhere.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Mask {
    pub enabled: bool,
    /// Shapes of the recipe, combined in order: the first one as it is, each next one
    /// with its `op`.
    pub drawn: Vec<DrawnShape>,
    /// Feathered range `[a, b, c, d]` of luminance, in EV relative to middle grey: 0
    /// below `a`, rising to 1 at `b`, 1 up to `c`, falling to 0 at `d`.
    pub luminance: Option<[f32; 4]>,
    /// The same on saturation: distance from white in CIE 1976 u′v′ (×13, as CIELUV's
    /// s_uv); about 0.2 for skin, 1 for a saturated sky, 0 for greys.
    pub saturation: Option<[f32; 4]>,
    /// The same on hue, in degrees around white in u′v′ (red ≈ 10, yellow ≈ 80, green ≈
    /// 130, blue ≈ 265); wraps around, so `[340, 350, 10, 20]` is a range. Greys have
    /// no hue: they fade out below a saturation of 0.05.
    pub hue: Option<[f32; 4]>,
    /// The same on each channel of the working space (linear Rec.2020), in EV relative
    /// to middle grey, like `luminance`.
    pub red: Option<[f32; 4]>,
    pub green: Option<[f32; 4]>,
    pub blue: Option<[f32; 4]>,
    /// Softens the mask's edges, in full-resolution pixels (0 = none).
    pub feather: f32,
    /// Feathering follows the image's edges (a guided filter), rather than a blur.
    pub edge_aware: bool,
    pub invert: bool,
    /// 0 … 1.
    pub opacity: f32,
    /// How the instance's output combines with its input where the mask applies (see
    /// [`crate::ops::blend`]).
    pub blend: BlendMode,
    /// The value some blend modes leave unchanged, in EV relative to middle grey
    /// (modules before filmic only): multiply, divide, screen, overlay, soft and hard light.
    pub blend_fulcrum: f32,
}

/// How a module's output `b` combines with its input `a` (roadmap 4.11), before the
/// mask mixes the result with `a`. Must match `BLEND_MODES` in TS.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    /// `b`.
    #[default]
    Normal,
    /// `max(a, b)` per channel.
    Lighten,
    /// `min(a, b)` per channel.
    Darken,
    /// `a · b / fulcrum`.
    Multiply,
    /// `a · fulcrum / b`.
    Divide,
    /// `a + b`.
    Addition,
    /// `max(a − b, 0)`.
    Subtraction,
    /// `|a − b|`.
    Difference,
    /// `(a + b) / 2`.
    Average,
    /// `√(a · b)`.
    GeometricMean,
    /// `2ab / (a + b)`.
    HarmonicMean,
    /// The usual display formulas, on values mapped so that the fulcrum is 50 %.
    Screen,
    Overlay,
    SoftLight,
    HardLight,
    /// `a`'s norm with `b`'s chromaticity.
    Chroma,
    /// `b`'s norm with `a`'s chromaticity.
    Luminance,
    /// `a` with `b`'s red, green or blue channel.
    Red,
    Green,
    Blue,
}

impl BlendMode {
    /// Whether it reads the fulcrum (when blending scene-referred).
    pub fn uses_fulcrum(self) -> bool {
        matches!(
            self,
            BlendMode::Multiply | BlendMode::Divide | BlendMode::Screen | BlendMode::Overlay | BlendMode::SoftLight | BlendMode::HardLight
        )
    }
}

impl Default for Mask {
    fn default() -> Self {
        Self {
            enabled: true,
            drawn: Vec::new(),
            luminance: None,
            saturation: None,
            hue: None,
            red: None,
            green: None,
            blue: None,
            feather: 0.0,
            edge_aware: true,
            invert: false,
            opacity: 1.0,
            blend: BlendMode::Normal,
            blend_fulcrum: 0.0,
        }
    }
}

impl Mask {
    /// Whether the mask selects everything fully with the normal blend (the instance
    /// applies as if unmasked).
    pub fn is_identity(&self) -> bool {
        !self.enabled
            || (self.drawn.is_empty() && !self.has_ranges() && !self.invert && self.opacity >= 1.0 && self.blend == BlendMode::Normal)
    }

    /// The same mask with the normal blend: what selects where it applies, without how.
    pub fn selection(&self) -> Self {
        Self { blend: BlendMode::Normal, blend_fulcrum: 0.0, ..self.clone() }
    }

    pub fn has_ranges(&self) -> bool {
        self.luminance.is_some() || self.saturation.is_some() || self.hue.is_some() || self.channels().iter().any(Option::is_some)
    }

    /// The red, green and blue ranges.
    pub fn channels(&self) -> [Option<[f32; 4]>; 3] {
        [self.red, self.green, self.blue]
    }

    /// Whether the feather applies to the parametric part too, so that the whole mask is
    /// computed with the spatial stages (see `crate::ops::mask`).
    pub fn feathers_whole(&self) -> bool {
        self.feather > 0.0 && self.has_ranges()
    }
}

/// A shape of a mask's drawn part.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DrawnShape {
    /// Id of the shape in `EditParams::shapes`.
    pub shape: String,
    /// How it combines with the shapes before it (ignored for the first one).
    pub op: ShapeOp,
}

/// How a drawn shape combines with what the shapes before it give (`a`, with the
/// shape's alpha `b`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeOp {
    /// `max(a, b)`.
    #[default]
    Union,
    /// `a · b`.
    Intersection,
    /// `a · (1 − b)`.
    Difference,
    /// `a + b − 2ab`: one or the other, not both.
    Exclusion,
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

/// Lens correction (see [`crate::lens`]): from the data embedded in the file, or from
/// lensfun's database (`lensfun`). Each strength scales the correction: 0 is off, 1 as
/// specified, up to 2.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Lens {
    pub distortion: f32,
    /// Transverse chromatic aberration.
    pub tca: f32,
    pub vignetting: f32,
    /// Lensfun's correction for this shot, used instead of the file's embedded data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lensfun: Option<LensfunProfile>,
}

impl Default for Lens {
    fn default() -> Self {
        Self { distortion: 1.0, tca: 1.0, vignetting: 1.0, lensfun: None }
    }
}

/// Lensfun's correction for one shot (roadmap 3.6): a lens of its database, matched (or
/// chosen) and interpolated for the shot's focal length and aperture by the app
/// (`lensfun.ts`). Kept in the recipe, so renders don't need the database and an update
/// of it doesn't move edits. Coefficients are lensfun's, in its own units: see
/// [`crate::lens::LensProfile::from_lensfun`]. Mirrors `LensfunProfile` in TS.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LensfunProfile {
    /// The lens's model name in lensfun's database.
    pub lens: String,
    /// The camera's crop factor (a full-frame diagonal over its sensor's).
    pub crop_factor: f32,
    /// The crop factor and aspect ratio of the sensor the lens was calibrated with.
    pub calib_crop_factor: f32,
    pub calib_aspect_ratio: f32,
    /// What the coefficients were interpolated for (the shot's): mm, and the f-number.
    pub focal_length: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f_number: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distortion: Option<LensfunTerms<DistortionModel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tca: Option<LensfunTerms<TcaModel>>,
    /// Lensfun's `pa` model: k1, k2, k3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vignetting: Option<[f32; 3]>,
}

/// A lensfun model and its terms, in the database's order (missing ones are 0).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LensfunTerms<M> {
    pub model: M,
    pub terms: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistortionModel {
    /// k1
    Poly3,
    /// k1, k2
    Poly5,
    /// a, b, c
    Ptlens,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TcaModel {
    /// kr, kb
    Linear,
    /// vr, vb, cr, cb, br, bb
    Poly3,
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

/// The colour temperature colour balance's mixers leave alone: the working space's
/// white, D65 (Ansel's 5003 K is its D50).
pub const NEUTRAL_TEMPERATURE: f32 = 6504.0;

/// Colour balance, after Ansel's `colorbalancergb.c` (the master tab) and
/// `splittoningrgb.c` (a light correction and channel mix per range); see
/// [`crate::ops::color_balance`]. The image is split into shadows, mid-tones and
/// highlights by luminance, with weights that always add up to 1.
///
/// The grading arrays hold `[shadows, mid-tones, highlights]`. The weights adding up
/// to 1, the same value in all three acts everywhere: what v7's separate global value
/// did (read from a 4-value array, it's added to each).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ColorBalance {
    /// Rotation of every hue, in degrees, -180 … 180.
    pub hue_shift: f32,
    /// Chroma for the muted colours more than for the saturated ones, -1 … 1.
    pub vibrance: f32,
    /// Linear chroma, -2 … 2 (-1: grey, 1: double).
    #[serde(deserialize_with = "grading")]
    pub chroma: [f32; 3],
    /// Perceptual saturation (dt UCS), -2 … 2.
    #[serde(deserialize_with = "grading")]
    pub saturation: [f32; 3],
    /// Perceptual brilliance (dt UCS), -2 … 2.
    #[serde(deserialize_with = "grading")]
    pub brilliance: [f32; 3],
    /// The light correction and channel mix of each range.
    pub shadows: ToneMixer,
    pub midtones: ToneMixer,
    pub highlights: ToneMixer,
    /// Centre of the mid-tones, EV relative to middle grey.
    pub fulcrum: f32,
    /// Width of the mid-tones, EV between the half-way points of their two edges, ≥ 0.
    pub midtones_range: f32,
    /// How gradually the shadows turn into the mid-tones: the EV over which the
    /// shadows' weight goes from 90 % to 10 %, ≥ 0.01.
    pub shadows_falloff: f32,
    /// The same, between the mid-tones and the highlights.
    pub highlights_falloff: f32,
    /// Luminance taken as white by saturation and brilliance, EV relative to middle grey.
    pub white_fulcrum: f32,
}

impl Default for ColorBalance {
    fn default() -> Self {
        Self {
            hue_shift: 0.0,
            vibrance: 0.0,
            chroma: [0.0; 3],
            saturation: [0.0; 3],
            brilliance: [0.0; 3],
            shadows: ToneMixer::default(),
            midtones: ToneMixer::default(),
            highlights: ToneMixer::default(),
            // Wide shadows and highlights, centred a little under middle grey: narrower
            // ones left most of a typical photo to the mid-tones.
            fulcrum: -1.0,
            midtones_range: 3.0,
            shadows_falloff: 4.0,
            highlights_falloff: 4.0,
            // Ansel's default, 1 EV (a luminance of 2): log₂(2 / 0.1845).
            white_fulcrum: 3.44,
        }
    }
}

impl ColorBalance {
    /// The mixers of the shadows, mid-tones and highlights.
    pub fn mixers(&self) -> [&ToneMixer; 3] {
        [&self.shadows, &self.midtones, &self.highlights]
    }

    /// The defaults with the tonal ranges v7 recipes started with, which migrated
    /// recipes keep (`brilliance` by range depends on them). Must match `legacyRanges` in TS.
    pub(crate) fn with_v7_ranges() -> Self {
        Self { fulcrum: 0.0, midtones_range: 4.0, shadows_falloff: 2.0, highlights_falloff: 2.0, ..Self::default() }
    }

    /// What a v1–v6 colour instance (saturation and vibrance, -1 … 1) becomes,
    /// approximately. Must match `fromColor` in TS.
    pub fn from_color(saturation: f32, vibrance: f32) -> Self {
        let mut p = Self::with_v7_ranges();
        p.chroma = [saturation.clamp(-1.0, 1.0); 3];
        p.vibrance = vibrance.clamp(-1.0, 1.0);
        p
    }

    /// What a v1–v6 shadows/highlights instance (-1 … 1 each) becomes, approximately.
    /// Must match `fromShadowsHighlights` in TS.
    pub fn from_shadows_highlights(shadows: f32, highlights: f32) -> Self {
        let mut p = Self::with_v7_ranges();
        p.brilliance[0] = shadows.clamp(-1.0, 1.0);
        p.brilliance[2] = highlights.clamp(-1.0, 1.0);
        p
    }
}

/// A colour balance grading array: `[shadows, mid-tones, highlights]`, or v7's
/// `[global, shadows, mid-tones, highlights]` with the global value added to each (each
/// clamped to ±1 first, as v7 rendered them), rounded to 1e-4 so that TS (in f64) gets
/// the same. Must match `foldGrading` in TS.
fn grading<'de, D: serde::Deserializer<'de>>(d: D) -> Result<[f32; 3], D::Error> {
    let v = Vec::<f32>::deserialize(d)?;
    let c = |x: f32| x.clamp(-1.0, 1.0);
    let add = |g: f32, r: f32| ((c(g) as f64 + c(r) as f64) * 1e4).round() as f32 / 1e4;
    match v[..] {
        [s, m, h] => Ok([s, m, h]),
        [g, s, m, h] => Ok([add(g, s), add(g, m), add(g, h)]),
        _ => Err(serde::de::Error::invalid_length(v.len(), &"3 or 4 values")),
    }
}

/// One range's mixer in colour balance, after Ansel's split-toning rgb: a chromatic
/// adaptation (CAT16) from a light of `temperature` to the working space's white,
/// then a 3×3 mix of the channels, in linear Rec.2020.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToneMixer {
    /// Correlated colour temperature of the light to correct, in kelvin, 1667 … 25000
    /// (daylight, black body below 4000 K). [`NEUTRAL_TEMPERATURE`] changes nothing.
    pub temperature: f32,
    /// Output channels as a mix of the input ones, -2 … 2 each.
    pub red: [f32; 3],
    pub green: [f32; 3],
    pub blue: [f32; 3],
    /// Scale each mix so that its coefficients add up to 1 (greys stay grey).
    pub normalize_red: bool,
    pub normalize_green: bool,
    pub normalize_blue: bool,
}

impl Default for ToneMixer {
    fn default() -> Self {
        Self {
            temperature: NEUTRAL_TEMPERATURE,
            red: [1.0, 0.0, 0.0],
            green: [0.0, 1.0, 0.0],
            blue: [0.0, 0.0, 1.0],
            normalize_red: true,
            normalize_green: true,
            normalize_blue: true,
        }
    }
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

/// Number of nodes of each tone curve.
pub const TONE_CURVE_NODES: usize = 9;
/// Default exposure of the first and last tone curve nodes, in EV relative to middle
/// grey (every 1.5 EV between).
pub const TONE_CURVE_RANGE: [f32; 2] = [-9.0, 3.0];
/// Narrowest range of a tone curve's nodes, in EV.
pub const TONE_CURVE_MIN_RANGE: f32 = 1.0;
/// Largest offset a tone curve node takes, in EV either way (Ansel's tone equalizer's).
pub const TONE_CURVE_MAX_OFFSET: f32 = 2.0;

/// Tone curve, after Ansel's `rgbcurve.c` and the controls of its tone equalizer (see
/// [`crate::ops::tone_curve`]): each curve is an exposure offset in EV (0 leaves the
/// image alone, ±[`TONE_CURVE_MAX_OFFSET`]) at [`TONE_CURVE_NODES`] input exposures
/// evenly spread over `range`, drawn smoothly through them. Past the end nodes the
/// offset stays that of the end node.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToneCurve {
    /// One curve for all channels (`rgb`), or one per channel.
    pub channels: CurveChannels,
    /// With linked channels: what the curve reads, scaling the three channels alike so
    /// that hues and saturation are kept; `None` applies it to each channel (colours
    /// shift, as with film).
    pub preserve_colors: RgbNorm,
    /// Input exposure of the first and last nodes, EV relative to middle grey; usually
    /// fitted to the image (`Developer::tone_curve_input`). See [`ToneCurve::range`].
    pub range: [f32; 2],
    pub rgb: [f32; TONE_CURVE_NODES],
    pub red: [f32; TONE_CURVE_NODES],
    pub green: [f32; TONE_CURVE_NODES],
    pub blue: [f32; TONE_CURVE_NODES],
    /// Read each pixel's exposure from an edge-aware smoothed mask of its surroundings
    /// rather than from the pixel (Ansel's tone equalizer): areas move as a whole and
    /// keep their texture. The curve is then linked and scales the pixel as a whole
    /// (see [`ToneCurve::local_norm`]).
    pub preserve_detail: bool,
    /// With `preserve_detail`: the mask's smoothing diameter, a fraction of the frame's
    /// long side, [`TONE_SMOOTHING_RANGE`].
    pub smoothing: f32,
    /// With `preserve_detail`: how closely the mask follows edges (Ansel's "edges
    /// refinement"), [`TONE_EDGE_RANGE`]; higher keeps more of them.
    pub edge_refinement: f32,
    /// How much of the curves applies: their offsets (EV) are scaled by it, 0 (off) to
    /// [`TONE_STRENGTH_MAX`], 1 as drawn.
    pub strength: f32,
}

/// Largest strength a tone curve takes.
pub const TONE_STRENGTH_MAX: f32 = 2.0;
/// Smoothing diameters a tone curve's mask takes (fractions of the long side).
pub const TONE_SMOOTHING_RANGE: [f32; 2] = [0.001, 1.0];
/// Edge refinements a tone curve's mask takes.
pub const TONE_EDGE_RANGE: [f32; 2] = [0.01, 10000.0];

impl Default for ToneCurve {
    fn default() -> Self {
        let flat = [0.0; TONE_CURVE_NODES];
        Self {
            channels: CurveChannels::Linked,
            preserve_colors: RgbNorm::Luminance,
            range: TONE_CURVE_RANGE,
            rgb: flat,
            red: flat,
            green: flat,
            blue: flat,
            preserve_detail: false,
            // Ansel's: 5 % of the long side, edges refinement 1.
            smoothing: 0.05,
            edge_refinement: 1.0,
            strength: 1.0,
        }
    }
}

impl ToneCurve {
    /// The norm a curve preserving detail reads and scales the pixel by: what
    /// `preserve_colors` says, or the euclidean norm (Ansel's default) without one.
    pub fn local_norm(&self) -> RgbNorm {
        match self.preserve_colors {
            RgbNorm::None => RgbNorm::Norm,
            norm => norm,
        }
    }

    /// `range` as used: at least [`TONE_CURVE_MIN_RANGE`] wide (widened upward). Must
    /// match `toneCurveRange` in TS.
    pub fn range(&self) -> [f32; 2] {
        let [lo, hi] = self.range;
        [lo, hi.max(lo + TONE_CURVE_MIN_RANGE)]
    }

    /// The curves in use: `rgb` (linked channels, or preserving detail), or red, green
    /// and blue.
    pub fn curves(&self) -> Vec<&[f32; TONE_CURVE_NODES]> {
        match self.channels {
            _ if self.preserve_detail => vec![&self.rgb],
            CurveChannels::Linked => vec![&self.rgb],
            CurveChannels::Independent => vec![&self.red, &self.green, &self.blue],
        }
    }

    /// `strength` as used, in 0 … [`TONE_STRENGTH_MAX`].
    pub fn strength(&self) -> f32 {
        if self.strength.is_nan() { 1.0 } else { self.strength.clamp(0.0, TONE_STRENGTH_MAX) }
    }

    /// Whether the curves leave the image alone: all flat at 0, or no strength.
    pub fn is_identity(&self) -> bool {
        self.strength() == 0.0 || self.curves().iter().all(|c| c.iter().all(|&v| v == 0.0))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CurveChannels {
    #[default]
    Linked,
    Independent,
}

/// A single value standing for a pixel's RGB, scaled so that a grey's is its value.
/// Ansel's norms, without "sum" (the average, once scaled).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RgbNorm {
    /// No norm: each channel on its own.
    None,
    /// The working space's luminance (Y).
    #[default]
    Luminance,
    /// The largest channel.
    Max,
    Average,
    /// Euclidean norm, ÷ √3.
    Norm,
    /// `(r³ + g³ + b³) / (r² + g² + b²)`: the brighter channels weigh more.
    Power,
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

/// Raw denoise (AI), see [`crate::denoise`]: a network trained by Ansel's ansel-denoise
/// subtracts the noise it estimates from the sensor's mosaic, conditioned on the
/// camera's noise profile.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawDenoise {
    /// Opacity of the correction, 0 (none) … 1: `original + strength·(denoised − original)`.
    pub strength: f32,
    /// Which network: a model is a version, a size and a variant, and stays as it was
    /// for a recipe that names it (a newer version is offered, not applied).
    pub model: DenoiseModel,
    /// Scales the noise the network is told to expect, everywhere, 0 … 2 (upstream's
    /// "global correction").
    pub noise_level: f32,
    /// Scales it per CFA colour (R, G, B), 0.5 … 8. The defaults carry the noise
    /// profiles' calibration.
    pub corrections: [f32; 3],
}

impl Default for RawDenoise {
    fn default() -> Self {
        Self { strength: crate::denoise::DEFAULT_STRENGTH, model: DenoiseModel::default(), noise_level: 1.0, corrections: crate::denoise::DEFAULT_CORRECTIONS }
    }
}

/// A raw denoise network: ansel-denoise's `denoise-<size>-<variant>-v<version>.anselnn`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DenoiseModel {
    /// The weights' version (ours: we pin upstream's files by hash), 1 for now.
    pub version: u32,
    pub size: DenoiseSize,
    pub variant: DenoiseVariant,
}

impl Default for DenoiseModel {
    fn default() -> Self {
        // Upstream's default without a GPU (there's no GPU path yet): quarter.
        Self { version: 1, size: DenoiseSize::Quarter, variant: DenoiseVariant::Multi }
    }
}

impl DenoiseModel {
    /// Its file's name without the extension, e.g. `denoise-half-multi-v1`: its id.
    pub fn id(&self) -> String {
        let size = match self.size {
            DenoiseSize::Quarter => "quarter",
            DenoiseSize::Half => "half",
            DenoiseSize::Large => "large",
        };
        let variant = match self.variant {
            DenoiseVariant::Single => "single",
            DenoiseVariant::Multi => "multi",
        };
        format!("denoise-{size}-{variant}-v{}", self.version)
    }
}

/// Width of the network: each is fitted on its own, so they don't give the same image.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DenoiseSize {
    #[default]
    Quarter,
    Half,
    Large,
}

/// The fine network alone, or guided by a coarse one on the binned image (less
/// low-frequency colour noise).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DenoiseVariant {
    Single,
    #[default]
    Multi,
}

/// Glow (see [`crate::ops::glow`]): what is brighter than a threshold spreads around,
/// tinted, and is added to the image as light. Bloom, halation, diffusion filters.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Glow {
    /// Where the glow starts, EV over middle grey (0.1845) of the module's input
    /// (before exposure), measured on each pixel's brightest channel. -4 … 8.
    pub threshold: f32,
    /// How gradually pixels start to glow around the threshold (the soft knee's half
    /// width, as a fraction of it), 0 … 1. Not the glow's shape: see `falloff`.
    pub softness: f32,
    /// Spread of the glow (the widest Gaussian's sigma), in full-resolution pixels.
    pub radius: f32,
    /// Shape of the glow, -1 … 1: a tight halo around the lights (-1), an even mix (0),
    /// or a long faint tail (1).
    pub falloff: f32,
    /// Amount of light added: the glow carries `strength` times the light above the
    /// threshold. 0 = off.
    pub strength: f32,
    /// Hue of the tint, degrees (0 red, 120 green, 240 blue), with `saturation`.
    pub hue: f32,
    /// Saturation of the tint, 0 (the light's own colour) … 1.
    pub saturation: f32,
    /// Round, or along one axis: both ways (an anamorphic streak) or one (motion).
    pub shape: GlowShape,
    /// Direction of a streak or a motion glow, degrees counterclockwise from the right
    /// (0: horizontal). A motion glow trails towards it.
    pub angle: f32,
    /// Spread across a streak or a motion glow, as a fraction of its spread along, 0 … 1.
    pub thickness: f32,
}

impl Default for Glow {
    fn default() -> Self {
        Self {
            threshold: 1.5,
            softness: 0.5,
            radius: 60.0,
            falloff: 0.0,
            strength: 1.5,
            hue: 20.0,
            saturation: 0.0,
            shape: GlowShape::Round,
            angle: 0.0,
            thickness: 0.05,
        }
    }
}

/// How a glow spreads: [`Glow::shape`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GlowShape {
    /// Around the lights, the same in every direction.
    #[default]
    Round,
    /// Along an axis, both ways: an anamorphic lens's streaks.
    Streak,
    /// Along an axis, one way: a trail, as if the lights moved.
    Motion,
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
    /// Derive the display power from the dynamic range (Ansel's "auto adjust hardness"),
    /// instead of `hardness`.
    pub auto_hardness: bool,
    /// Display power ("hardness") applied after the curve, 1 … 10, without `auto_hardness`.
    pub hardness: f32,
    /// Display luminance that black maps to, in %, 0 … 20 (Ansel's "target black luminance").
    pub black_target: f32,
    /// Display luminance that white maps to, in %, 20 … 100 (Ansel's "target white luminance").
    pub white_target: f32,
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
            auto_hardness: true,
            // Ansel's.
            hardness: 4.0,
            black_target: 0.015_176_34,
            white_target: 100.0,
        }
    }
}

/// A creative 3D LUT (roadmap 4.8, see [`crate::ops::clut`]), display-referred: it runs
/// after filmic, on encoded sRGB, and the result is converted to the output space.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Lut {
    /// The LUT; none does nothing.
    pub lut: Option<LutRef>,
    pub interpolation: crate::ops::clut::Interpolation,
}

/// A LUT by its id: the SHA-256 of its canonical form (`Clut::id`). Renderers are given
/// the tables separately (`ClutStore`); a LUT they don't have is skipped.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LutRef {
    pub id: String,
    /// Its name when it was chosen, to tell the user which LUT is missing.
    pub name: String,
}

impl EditParams {
    /// The LUTs the enabled instances use, without repeats, in pipeline order.
    pub fn lut_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = Vec::new();
        for lut in self.all::<Lut>().filter_map(|l| l.lut.as_ref()) {
            if !ids.contains(&lut.id.as_str()) {
                ids.push(&lut.id);
            }
        }
        ids
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

/// Diffuse or sharpen (see [`crate::ops::diffuse`]), after Ansel's `diffuse.c`: a
/// multiscale anisotropic heat-transfer model, to deblur, add local contrast, denoise,
/// inpaint highlights or soften. Speeds and anisotropies go by order: 1st and 3rd
/// follow the low pass's gradient, 2nd and 4th the detail's; 1st and 2nd act on the
/// low pass, 3rd and 4th on the detail. The default is Ansel's "sharpen demosaicing
/// (AA filter)" preset.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Diffuse {
    /// Diffusion steps, 1 … 500 (rounded): more is stronger and slower.
    pub iterations: f32,
    /// Band size the effect is centred on, in full-resolution pixels (0: the finest).
    pub radius_center: f32,
    /// Spread of the effect around `radius_center` over band sizes, in full-resolution pixels.
    pub radius: f32,
    /// Speed of each order, -1 (sharpen) … 1 (diffuse).
    pub speed1: f32,
    pub speed2: f32,
    pub speed3: f32,
    pub speed4: f32,
    /// Direction of each order, -10 … 10: 0 in every direction, positive along edges
    /// (isophotes), negative across them (along the gradient).
    pub anisotropy1: f32,
    pub anisotropy2: f32,
    pub anisotropy3: f32,
    pub anisotropy4: f32,
    /// Extra gain on the detail bands, -1 … 1.
    pub sharpness: f32,
    /// How much edges hold the diffusion back, 0 … 6 (log₁₀ scale).
    pub edge_sensitivity: f32,
    /// Where the edge penalty starts, -2 … 2 (log₁₀ scale).
    pub edge_threshold: f32,
    /// Only diffuse (and first fill with noise) where a channel is above this, at the
    /// level of the default exposure (+0.7 EV): inpainting clipped highlights. 0: everywhere.
    pub luminance_threshold: f32,
}

impl Default for Diffuse {
    fn default() -> Self {
        Self {
            iterations: 1.0,
            radius_center: 0.0,
            radius: 8.0,
            speed1: -0.25,
            speed2: -0.25,
            speed3: -0.25,
            speed4: -0.25,
            anisotropy1: 1.0,
            anisotropy2: 1.0,
            anisotropy3: 1.0,
            anisotropy4: 1.0,
            sharpness: 0.0,
            edge_sensitivity: 1.0,
            edge_threshold: 0.0,
            luminance_threshold: 0.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Geometry {
    /// Additional clockwise quarter turns on top of the camera orientation (0…3).
    pub rotation: u8,
    /// Mirror horizontally, after rotation.
    pub flip_horizontal: bool,
    /// Straighten angle in degrees (clockwise positive), -45 … +45: the camera's roll,
    /// undone before the perspective correction.
    pub angle: f32,
    /// Perspective correction, as a camera rotation (see [`crate::ops::perspective`]):
    /// tilt in degrees, positive for a camera that pointed up (verticals converging
    /// towards the top), -40 … +40.
    pub vertical: f32,
    /// Pan in degrees, positive for a camera that pointed left (horizontals converging
    /// towards the left), -40 … +40.
    pub horizontal: f32,
    /// Vertical shear after the rotation (`y += shear · x`), -0.5 … +0.5.
    pub shear: f32,
    /// Stretch after the correction: widths are scaled by `2^(aspect / 2)` and heights
    /// by its inverse, -1 … +1.
    pub aspect: f32,
    /// How the corrected image is framed so that no empty borders show.
    pub auto_crop: AutoCrop,
    /// Crop rectangle, normalised to the corrected (and auto-cropped) frame.
    pub crop: Crop,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            rotation: 0,
            flip_horizontal: false,
            angle: 0.0,
            vertical: 0.0,
            horizontal: 0.0,
            shear: 0.0,
            aspect: 0.0,
            auto_crop: AutoCrop::default(),
            crop: Crop::default(),
        }
    }
}

/// How [`Geometry`] frames the straightened and perspective-corrected image.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoCrop {
    /// The largest rectangle of the uncorrected frame's aspect within the image.
    #[default]
    Aspect,
    /// The largest rectangle of any aspect within the image.
    Area,
    /// All of the corrected image, with empty borders (black). The developer shows
    /// this while perspective guides are edited.
    Off,
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
    fn default_is_exposure_calibration_balance_and_filmic() {
        let p = EditParams::default();
        assert_eq!(kinds(&p), [ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::ColorBalance, ModuleKind::Filmic]);
        assert_eq!(p.modules[1].id, "colorCalibration");
        assert_eq!(p.modules[0].id, "exposure");
        assert_eq!(p.get::<Exposure>().unwrap().ev, 0.7);
        assert_eq!(p.get::<ColorBalance>().unwrap().saturation, [0.45, 0.2, 0.2]);
        assert_eq!(p.get::<Filmic>(), Some(&Filmic::default()));
    }

    #[test]
    fn default_for_adds_lens_correction_when_available() {
        let plain = PhotoMetadata::default();
        assert_eq!(EditParams::default_for(&plain), EditParams::default());
        let sony = PhotoMetadata { lens_correction: Some("sony".into()), ..Default::default() };
        let p = EditParams::default_for(&sony);
        assert_eq!(kinds(&p), [ModuleKind::Lens, ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::ColorBalance, ModuleKind::Filmic]);
        assert_eq!(p.modules[0].id, "lens");
    }

    /// The default recipe as it was before colour balance joined it (what old recipes migrate to).
    /// What old recipes migrate to: the default recipe without colour balance, and
    /// without filmic's auto-tune mark (it's for new images).
    fn default_without_balance() -> EditParams {
        let mut p = EditParams::default();
        p.remove(ModuleKind::ColorBalance);
        p.modules.iter_mut().for_each(|m| m.auto_tune = false);
        p
    }

    #[test]
    fn empty_json_is_default() {
        assert_eq!(EditParams::from_json("").unwrap(), EditParams::default());
        // An empty object is a v1 recipe: its modules' defaults, without colour balance.
        assert_eq!(EditParams::from_json("{}").unwrap(), default_without_balance());
    }

    #[test]
    fn round_trips() {
        let mut p = EditParams::default();
        p.get_mut::<Glow>().strength = 0.5;
        p.add(Exposure { ev: -1.0, black: 0.0 });
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.starts_with(r#"{"version":8,"modules":[{"id":"glow","label":null,"enabled":true,"kind":"glow","params":"#), "{json}");
        assert_eq!(EditParams::from_json(&json).unwrap(), p);
    }

    #[test]
    fn v3_partial_json_uses_defaults() {
        let p = EditParams::from_json(
            r#"{"version":3,"modules":[{"kind":"filmic","params":{"bleach":"extra"}},{"kind":"exposure","params":{"black":0.01}},{"kind":"glow"}]}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Glow, ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::Filmic]);
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
    fn retired_kinds_are_dropped() {
        let p = EditParams::from_json(
            r#"{"version":8,"modules":[{"kind":"blur","params":{"radius":3}},{"kind":"sharpen","params":{"amount":1}},{"kind":"exposure"}]}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Exposure]);
        let p = EditParams::from_json(r#"{"version":2,"sharpen":{"amount":1},"blur":{"radius":2}}"#).unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Exposure, ModuleKind::ColorCalibration, ModuleKind::Filmic]);
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
        assert_eq!(p, default_without_balance());

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
    fn masks_round_trip_and_normalize() {
        let p = EditParams::from_json(
            r#"{"version":6,"modules":[
                {"kind":"exposure","mask":{"drawn":[{"shape":"a"},{"shape":"gone","op":"difference"},{"shape":"b","op":"intersection"}],"luminance":[-2,-1,1,2],"feather":8}},
                {"kind":"exposure","mask":null},
                {"kind":"filmic","mask":{"drawn":[{"shape":"c"}]}}],
              "shapes":{
                "a":{"type":"ellipse","center":[0.5,0.5],"radii":[0.1,0.1]},
                "b":{"type":"gradient","anchor":[0.5,0.5]},
                "c":{"type":"ellipse","center":[0.1,0.1],"radii":[0.1,0.1]}}}"#,
        )
        .unwrap();
        let mask = p.modules[0].mask.as_ref().unwrap();
        // Parts without their shape go; the rest keeps its defaults.
        assert_eq!(mask.drawn, [DrawnShape { shape: "a".into(), op: ShapeOp::Union }, DrawnShape { shape: "b".into(), op: ShapeOp::Intersection }]);
        assert_eq!((mask.luminance, mask.hue, mask.feather, mask.edge_aware, mask.opacity), (Some([-2.0, -1.0, 1.0, 2.0]), None, 8.0, true, 1.0));
        assert_eq!(p.modules[1].mask, None);
        // Filmic can't be masked: its mask goes, and so does the shape only it used.
        assert_eq!(p.modules[2].mask, None);
        assert_eq!(p.shapes.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(p.shape_refs().collect::<Vec<_>>(), ["a", "b"]);

        let json = serde_json::to_value(&p).unwrap();
        assert!(json["modules"][1].get("mask").is_none(), "left out when absent");
        assert_eq!(json["modules"][0]["mask"]["drawn"][1], serde_json::json!({ "shape": "b", "op": "intersection" }));
        assert_eq!(EditParams::from_json(&json.to_string()).unwrap(), p);
    }

    #[test]
    fn tone_curve_reads_partial_json() {
        let p = EditParams::from_json(
            r#"{"version":6,"modules":[{"kind":"toneCurve","params":{"channels":"independent","preserveColors":"max","green":[0,0,0,0,0.5,0,0,0,0]}}]}"#,
        )
        .unwrap();
        let t = p.get::<ToneCurve>().unwrap();
        assert_eq!((t.channels, t.preserve_colors, t.rgb, t.green[4]), (CurveChannels::Independent, RgbNorm::Max, [0.0; TONE_CURVE_NODES], 0.5));
        assert!(!t.is_identity());
        assert_eq!(t.strength, 1.0, "full strength when absent");
        assert!(ToneCurve { strength: 0.0, ..t.clone() }.is_identity());
        assert!(EditParams::from_json(r#"{"version":6,"modules":[{"kind":"toneCurve","params":{"rgb":[1,2]}}]}"#).is_err());
    }

    #[test]
    fn luts_come_after_filmic_and_list_their_ids() {
        let p = EditParams::from_json(
            r#"{"version":6,"modules":[
                {"kind":"lut","params":{"lut":{"id":"b","name":"Vivid"},"interpolation":"pyramid"}},
                {"kind":"lut","params":{"lut":{"id":"a"}}},
                {"kind":"lut","params":{}},
                {"kind":"lut","enabled":false,"params":{"lut":{"id":"c","name":"Off"}}},
                {"kind":"lut","params":{"lut":{"id":"b","name":"Vivid again"}},"mask":{"opacity":0.5,"blend":"softLight"}},
                {"kind":"filmic"}]}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::Filmic, ModuleKind::Lut, ModuleKind::Lut, ModuleKind::Lut, ModuleKind::Lut, ModuleKind::Lut]);
        let lut = p.get::<Lut>().unwrap();
        assert_eq!((lut.lut.as_ref().unwrap().name.as_str(), lut.interpolation), ("Vivid", crate::ops::clut::Interpolation::Pyramid));
        assert_eq!(p.all::<Lut>().nth(1).unwrap().lut, Some(LutRef { id: "a".into(), name: String::new() }));
        assert_eq!(p.all::<Lut>().nth(2).unwrap().lut, None);
        assert_eq!(p.lut_ids(), ["b", "a"]);
        // Maskable, with a blend mode; filmic isn't.
        let masked = p.modules.last().unwrap().mask.as_ref().unwrap();
        assert_eq!((masked.opacity, masked.blend, masked.blend_fulcrum), (0.5, BlendMode::SoftLight, 0.0));
        assert_eq!(p.modules.iter().filter(|m| m.mask.is_some()).count(), 1);

        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["modules"][3]["params"], serde_json::json!({ "lut": null, "interpolation": "tetrahedral" }));
        assert_eq!(EditParams::from_json(&json.to_string()).unwrap(), p);
    }

    #[test]
    fn migrates_color_and_shadows_highlights_to_color_balance() {
        let p = EditParams::from_json(
            r#"{"version":6,"modules":[
                {"id":"pop","label":"pop","kind":"color","params":{"saturation":0.4,"vibrance":-0.2},"mask":{"opacity":0.5}},
                {"kind":"shadowsHighlights","enabled":false,"params":{"shadows":0.3,"highlights":-2}},
                {"kind":"color","params":"junk"}]}"#,
        )
        .unwrap();
        assert_eq!(kinds(&p), [ModuleKind::ColorBalance; 3]);
        let [a, b, c] = [0, 1, 2].map(|i| ColorBalance::get(&p.modules[i].module).unwrap().clone());
        assert_eq!((a.chroma, a.vibrance), ([0.4; 3], -0.2));
        assert_eq!((p.modules[0].id.as_str(), p.modules[0].label.as_deref(), p.modules[0].mask.as_ref().map(|m| m.opacity)), ("pop", Some("pop"), Some(0.5)));
        assert_eq!((b.brilliance, p.modules[1].enabled), ([0.3, 0.0, -1.0], false));
        assert_eq!(c, ColorBalance::from_color(0.0, 0.0));
        // Migrated instances keep the ranges they were made with.
        assert_eq!((c.fulcrum, c.midtones_range, c.shadows_falloff), (0.0, 4.0, 2.0));

        let p = EditParams::from_json(r#"{"version":2,"color":{"vibrance":0.2},"shadowsHighlights":{"highlights":-0.4}}"#).unwrap();
        let balances: Vec<_> = p.all::<ColorBalance>().collect();
        assert_eq!(balances, [&ColorBalance::from_color(0.0, 0.2), &ColorBalance::from_shadows_highlights(0.0, -0.4)]);
        // v7 recipes have no such kinds.
        assert!(EditParams::from_json(r#"{"version":7,"modules":[{"kind":"color"}]}"#).is_err());
    }

    #[test]
    fn folds_v7_global_grading_into_the_ranges() {
        let p = EditParams::from_json(
            r#"{"version":7,"modules":[{"kind":"colorBalance","params":{
                "chroma":[0.1,0.2,0,-0.3],"saturation":[1.5,0.5,0,-2],"brilliance":[0.2,0.1,0.3]}}]}"#,
        )
        .unwrap();
        let b = p.get::<ColorBalance>().unwrap();
        let close = |a: [f32; 3], e: [f32; 3]| a.iter().zip(e).all(|(a, e)| (a - e).abs() < 1e-6);
        assert!(close(b.chroma, [0.3, 0.1, -0.2]), "{:?}", b.chroma);
        // Each clamped to ±1 first, as v7 rendered them.
        assert!(close(b.saturation, [1.5, 1.0, 0.0]), "{:?}", b.saturation);
        // Already three: as they are.
        assert!(close(b.brilliance, [0.2, 0.1, 0.3]));
        assert!(EditParams::from_json(r#"{"version":8,"modules":[{"kind":"colorBalance","params":{"chroma":[0,0]}}]}"#).is_err());
    }

    #[test]
    fn migrates_v1() {
        let p = EditParams::from_json(r#"{"version":1,"exposure":{"ev":1.0},"toneMap":{"contrast":2}}"#).unwrap();
        assert_eq!(p.get::<Exposure>().unwrap().ev, 1.0);
        assert_eq!(p.get::<Filmic>(), Some(&Filmic::default()));
    }
}
