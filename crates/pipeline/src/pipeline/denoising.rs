//! Raw denoise in the [`Developer`] (roadmap 3.5).
//!
//! Denoising is too slow to run inside a render, so it runs beside them: the caller
//! takes tiles ([`Developer::next_denoise_tile`]), runs them where it likes
//! ([`denoise::run_tile`], on a worker pool in the browser) and hands back the results
//! ([`Developer::provide_denoise_tile`]). Until every tile is in, renders read the
//! original samples; then the denoised photo (blended at the recipe's strength) takes
//! the original's place, and the image caches are dropped. The tiles stay at full
//! strength, so a strength change only blends again.
//!
//! The denoised photo can be kept as a file ([`Developer::denoised_file`]) and a
//! developer opened from it without the RAW file ([`Developer::from_denoised_file`]):
//! [`DenoiseStatus::NeedsOriginal`] says when a recipe needs the original again
//! ([`Developer::set_original`]).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::Developer;
use crate::decode::{self, RawPhoto};
use crate::denoise::{self, Conditioning, NoiseProfile, TileInput};
use crate::image::Region;
use crate::nn::Model;
use crate::params::{DenoiseModel, EditParams, RawDenoise};
use crate::Result;

/// What a denoised mosaic depends on, besides the photo: the model and the σ map's
/// conditioning. Strength isn't part of it (it's applied afterwards).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DenoiseKey {
    pub model: DenoiseModel,
    pub conditioning: Conditioning,
}

impl DenoiseKey {
    /// The key and strength of the recipe's raw denoise, if it has one that does
    /// something.
    pub fn of(params: &EditParams) -> Option<(DenoiseKey, f32)> {
        let m = params.modules.iter().find(|m| m.enabled && matches!(m.module, crate::params::Module::RawDenoise(_)))?;
        let crate::params::Module::RawDenoise(p) = &m.module else { return None };
        (p.strength > 0.0).then(|| (DenoiseKey::from_params(p), p.strength.min(1.0)))
    }

    fn from_params(p: &RawDenoise) -> Self {
        DenoiseKey { model: p.model, conditioning: Conditioning { noise_level: p.noise_level, corrections: p.corrections } }
    }

    /// A string naming the key and `strength`: what a stored denoised photo is for.
    pub fn name(&self, strength: f32) -> String {
        let c = &self.conditioning;
        format!(
            "{}/n{}/r{}g{}b{}/s{}",
            self.model.id(),
            c.noise_level.to_bits(),
            c.corrections[0].to_bits(),
            c.corrections[1].to_bits(),
            c.corrections[2].to_bits(),
            strength.to_bits()
        )
    }

    /// A number identifying it, for tile jobs.
    fn id(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.model.hash(&mut h);
        self.conditioning.noise_level.to_bits().hash(&mut h);
        self.conditioning.corrections.map(f32::to_bits).hash(&mut h);
        h.finish()
    }
}

/// Where a recipe's raw denoise stands.
#[derive(Clone, Debug, PartialEq)]
pub enum DenoiseStatus {
    /// No raw denoise (or at strength 0).
    Off,
    /// The photo can't be denoised (not a Bayer or X-Trans RAW file): renders skip it.
    Unsupported,
    /// The model isn't loaded ([`Developer::load_denoise_model`]): its id.
    NeedsModel(String),
    /// Opened from a denoised file made with other settings: the RAW file is needed.
    NeedsOriginal,
    /// Tiles to compute ([`Developer::next_denoise_tile`]); renders use the original.
    Pending { done: usize, total: usize },
    /// Renders use the denoised photo.
    Ready,
}

/// A tile to denoise, from [`Developer::next_denoise_tile`].
pub struct DenoiseJob {
    /// For [`Developer::provide_denoise_tile`]: which settings it was for.
    pub key: u64,
    /// The model to run it with (its id).
    pub model: String,
    pub input: TileInput,
}

#[derive(Default)]
pub(super) struct Denoising {
    models: HashMap<String, Rc<Model>>,
    /// The photo as decoded, `None` when opened from a denoised file.
    original: Option<Rc<RawPhoto>>,
    run: Option<Run>,
    /// The denoised photo renders use, its key and strength.
    ready: Option<(DenoiseKey, f32, Rc<RawPhoto>)>,
}

/// Tiles computed for one key, at full strength.
struct Run {
    key: DenoiseKey,
    profile: NoiseProfile,
    total: usize,
    tiles: HashMap<(usize, usize), (Region, Vec<f32>)>,
    in_flight: HashSet<(usize, usize)>,
}

impl Denoising {
    pub(super) fn new(original: Rc<RawPhoto>) -> Self {
        Self { original: Some(original), ..Default::default() }
    }

    /// For a sibling developer: the models and the ready photo, not the run.
    pub(super) fn share(&self) -> Self {
        Self { models: self.models.clone(), original: self.original.clone(), run: None, ready: self.ready.clone() }
    }
}

impl Developer {
    /// A developer for a photo stored by [`denoised_file`](Self::denoised_file), without
    /// its RAW file. Its recipe's raw denoise must be what the file was made with
    /// ([`DenoiseKey::name`] is the file's key), or it needs the original
    /// ([`DenoiseStatus::NeedsOriginal`], [`set_original`](Self::set_original)).
    pub fn from_denoised_file(bytes: &[u8]) -> Result<(String, Developer)> {
        let (key, photo) = RawPhoto::from_denoised_file(bytes)?;
        let photo = Rc::new(photo);
        let mut dev = Self::with_photo(Rc::clone(&photo));
        dev.denoising.original = None;
        if let Some((k, strength)) = parse_name(&key) {
            dev.denoising.ready = Some((k, strength, photo));
        }
        Ok((key, dev))
    }

    /// The RAW file, for a developer opened from a denoised file.
    pub fn set_original(&mut self, bytes: &[u8]) -> Result<()> {
        let photo = decode::decode(bytes)?;
        if (photo.width, photo.height) != (self.photo.width, self.photo.height) {
            return Err(crate::Error::Decode("not the denoised photo's RAW file".into()));
        }
        self.denoising.original = Some(Rc::new(photo));
        Ok(())
    }

    /// Whether the developer has the RAW file's samples (not only a denoised file's).
    pub fn has_original(&self) -> bool {
        self.denoising.original.is_some()
    }

    /// Loads a raw denoise model (an `.anselnn` file) under its id
    /// ([`DenoiseModel::id`]).
    pub fn load_denoise_model(&mut self, id: &str, bytes: &[u8]) -> std::result::Result<(), crate::nn::ModelError> {
        let model = Model::from_bytes(bytes)?;
        self.denoising.models.insert(id.to_string(), Rc::new(model));
        Ok(())
    }

    pub fn has_denoise_model(&self, id: &str) -> bool {
        self.denoising.models.contains_key(id)
    }

    /// Where the recipe's raw denoise stands.
    pub fn denoise_status(&self, params: &EditParams) -> DenoiseStatus {
        let Some((key, strength)) = DenoiseKey::of(params) else { return DenoiseStatus::Off };
        if !denoise::supported(&self.photo) && !self.photo.is_denoised() {
            return DenoiseStatus::Unsupported;
        }
        let d = &self.denoising;
        if d.ready.as_ref().is_some_and(|(k, s, _)| *k == key && *s == strength) {
            return DenoiseStatus::Ready;
        }
        let Some(original) = &d.original else { return DenoiseStatus::NeedsOriginal };
        let total = denoise::tiles(original.width, original.height).len();
        match &d.run {
            Some(run) if run.key == key && run.tiles.len() == total => DenoiseStatus::Ready,
            _ if !d.models.contains_key(&key.model.id()) => DenoiseStatus::NeedsModel(key.model.id()),
            Some(run) if run.key == key => DenoiseStatus::Pending { done: run.tiles.len(), total },
            _ => DenoiseStatus::Pending { done: 0, total },
        }
    }

    /// The next tile to denoise for the recipe, nearest `focus` (a point of the sensor,
    /// normalised: what's in view first), or `None` when none is left to hand out.
    pub fn next_denoise_tile(&mut self, params: &EditParams, focus: Option<(f32, f32)>) -> Option<DenoiseJob> {
        let DenoiseStatus::Pending { .. } = self.denoise_status(params) else { return None };
        let (key, _) = DenoiseKey::of(params)?;
        let original = Rc::clone(self.denoising.original.as_ref()?);
        let model = Rc::clone(self.denoising.models.get(&key.model.id())?);
        if self.denoising.run.as_ref().is_none_or(|r| r.key != key) {
            let m = &original.metadata;
            self.denoising.run = Some(Run {
                key,
                profile: denoise::noise_profile(m.make.as_deref(), m.model.as_deref(), m.iso),
                total: denoise::tiles(original.width, original.height).len(),
                tiles: HashMap::new(),
                in_flight: HashSet::new(),
            });
        }
        let run = self.denoising.run.as_mut()?;
        let (fx, fy) = focus.unwrap_or((0.5, 0.5));
        let (cx, cy) = (fx * original.width as f32, fy * original.height as f32);
        let distance = |t: &Region| {
            let (tx, ty) = (t.x as f32 + t.width as f32 / 2.0, t.y as f32 + t.height as f32 / 2.0);
            (tx - cx).powi(2) + (ty - cy).powi(2)
        };
        let core = denoise::tiles(original.width, original.height)
            .into_iter()
            .filter(|t| !run.tiles.contains_key(&(t.x, t.y)) && !run.in_flight.contains(&(t.x, t.y)))
            .min_by(|a, b| distance(a).total_cmp(&distance(b)))?;
        let input = denoise::tile_input(&original, &run.profile, &key.conditioning, denoise::margin(&model), core)?;
        run.in_flight.insert((core.x, core.y));
        Some(DenoiseJob { key: key.id(), model: key.model.id(), input })
    }

    /// A tile's result ([`denoise::run_tile`]'s), for the job with this `key` (ignored if
    /// the recipe's settings changed since), or `None` if it failed: it's handed out again.
    pub fn provide_denoise_tile(&mut self, key: u64, core: Region, values: Option<Vec<f32>>) {
        let Some(run) = self.denoising.run.as_mut().filter(|r| r.key.id() == key) else { return };
        run.in_flight.remove(&(core.x, core.y));
        if let Some(values) = values.filter(|v| v.len() == core.width * core.height) {
            run.tiles.insert((core.x, core.y), (core, values));
        }
    }

    /// Denoises every tile left here and now, on this thread (native callers, tests).
    pub fn denoise_now(&mut self, params: &EditParams) {
        while let Some(job) = self.next_denoise_tile(params, None) {
            let core = job.input.core;
            let values = self.denoising.models.get(&job.model).and_then(|m| denoise::run_tile(m, job.input));
            self.provide_denoise_tile(job.key, core, values);
        }
    }

    /// The denoised photo renders use, as a file to keep ([`from_denoised_file`](Self::from_denoised_file)),
    /// once the recipe's raw denoise is ready.
    pub fn denoised_file(&mut self, params: &EditParams) -> Option<Vec<u8>> {
        self.sync_source(params);
        let (key, strength, photo) = self.denoising.ready.as_ref()?;
        photo.to_denoised_file(&key.name(*strength))
    }

    /// Reads samples from the photo the recipe wants: the denoised one when it's ready,
    /// else the original. Drops the image caches when that changes.
    pub(super) fn sync_source(&mut self, params: &EditParams) {
        let wanted = self.wanted_source(params);
        if let Some(photo) = wanted {
            if !Rc::ptr_eq(&photo, &self.photo) {
                self.photo = photo;
                self.release_cache();
                self.diffused.clear();
            }
        }
    }

    /// Whether [`sync_source`](Self::sync_source) would change the photo.
    pub(super) fn source_changes(&self, params: &EditParams) -> bool {
        self.wanted_source_now(params).is_some_and(|p| !Rc::ptr_eq(&p, &self.photo))
    }

    fn wanted_source(&mut self, params: &EditParams) -> Option<Rc<RawPhoto>> {
        if let Some((key, strength)) = DenoiseKey::of(params) {
            let d = &mut self.denoising;
            let stale = d.ready.as_ref().is_none_or(|(k, s, _)| *k != key || *s != strength);
            if stale {
                if let (Some(run), Some(original)) = (&d.run, &d.original) {
                    if run.key == key && run.tiles.len() == run.total {
                        d.ready = Some((key, strength, Rc::new(blend(original, run, strength))));
                    }
                }
            }
        }
        self.wanted_source_now(params)
    }

    /// The photo to read: the ready denoised one if it's the recipe's, else the
    /// original; `None` to keep the current one (no original to go back to).
    fn wanted_source_now(&self, params: &EditParams) -> Option<Rc<RawPhoto>> {
        let d = &self.denoising;
        if let Some((key, strength)) = DenoiseKey::of(params) {
            if let Some((k, s, photo)) = &d.ready {
                if *k == key && *s == strength {
                    return Some(Rc::clone(photo));
                }
            }
        }
        d.original.clone()
    }
}

/// The original with the run's tiles blended in at `strength`.
fn blend(original: &RawPhoto, run: &Run, strength: f32) -> RawPhoto {
    let w = original.width;
    let mut samples = vec![0.0f32; w * original.height];
    for (core, values) in run.tiles.values() {
        for y in 0..core.height {
            let row = (core.y + y) * w + core.x;
            for x in 0..core.width {
                let o = original.sample_unclamped(core.x + x, core.y + y, 0);
                samples[row + x] = denoise::blend(o, values[y * core.width + x], strength);
            }
        }
    }
    original.with_denoised(samples)
}

/// The key and strength in a [`DenoiseKey::name`].
fn parse_name(name: &str) -> Option<(DenoiseKey, f32)> {
    let mut parts = name.split('/');
    let id = parts.next()?;
    let noise = parts.next()?.strip_prefix('n')?.parse::<u32>().ok()?;
    let rgb = parts.next()?.strip_prefix('r')?;
    let (r, rest) = rgb.split_once('g')?;
    let (g, b) = rest.split_once('b')?;
    let strength = parts.next()?.strip_prefix('s')?.parse::<u32>().ok()?;
    let model = parse_model_id(id)?;
    let corrections = [r.parse::<u32>().ok()?, g.parse::<u32>().ok()?, b.parse::<u32>().ok()?].map(f32::from_bits);
    Some((DenoiseKey { model, conditioning: Conditioning { noise_level: f32::from_bits(noise), corrections } }, f32::from_bits(strength)))
}

fn parse_model_id(id: &str) -> Option<DenoiseModel> {
    use crate::params::{DenoiseSize, DenoiseVariant};
    let rest = id.strip_prefix("denoise-")?;
    let mut parts = rest.split('-');
    let size = match parts.next()? {
        "quarter" => DenoiseSize::Quarter,
        "half" => DenoiseSize::Half,
        "large" => DenoiseSize::Large,
        _ => return None,
    };
    let variant = match parts.next()? {
        "single" => DenoiseVariant::Single,
        "multi" => DenoiseVariant::Multi,
        _ => return None,
    };
    let version = parts.next()?.strip_prefix('v')?.parse().ok()?;
    Some(DenoiseModel { version, size, variant })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        let key = DenoiseKey { model: DenoiseModel::default(), conditioning: Conditioning { noise_level: 1.2, corrections: [2.82, 3.94, 2.96] } };
        assert_eq!(parse_name(&key.name(0.85)), Some((key, 0.85)));
        assert_eq!(parse_name("nonsense"), None);
    }
}
