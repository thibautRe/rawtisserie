//! Multiple exposure: another photo blended into the base image (see
//! [`params::MultipleExposure`]).
//!
//! Both photos are developed the same way up to the base (demosaiced or binned, white
//! balanced for D65 light, in linear Rec.2020), so they blend as light does, before
//! anything else touches them. The other photo is scaled to cover this one's sensor,
//! centred, and read at whatever binning gives at least the resolution needed. The
//! modes are Fujifilm's in-camera ones.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use crate::color;
use crate::decode::RawPhoto;
use crate::demosaic;
use crate::image::{Image, Region};
use crate::params::{self, EditParams, ExposureBlend};

/// The photos multiple exposures may blend in, by the SHA-256 of their file. Recipes
/// whose photo isn't here render without it.
#[derive(Clone, Default)]
pub struct ExposureStore {
    photos: HashMap<String, Rc<RawPhoto>>,
}

impl ExposureStore {
    pub fn insert(&mut self, sha256: &str, photo: RawPhoto) {
        self.photos.insert(sha256.to_ascii_lowercase(), Rc::new(photo));
    }

    pub fn contains(&self, sha256: &str) -> bool {
        self.photos.contains_key(&sha256.to_ascii_lowercase())
    }

    pub fn remove(&mut self, sha256: &str) -> bool {
        self.photos.remove(&sha256.to_ascii_lowercase()).is_some()
    }

    fn get(&self, sha256: &str) -> Option<Rc<RawPhoto>> {
        self.photos.get(&sha256.to_ascii_lowercase()).cloned()
    }
}

/// What a recipe blends into the base: the other photo and how.
#[derive(Clone)]
pub struct Layer {
    pub photo: Rc<RawPhoto>,
    pub blend: ExposureBlend,
    pub gain: f32,
    /// Changes with any of them (never 0, which stands for no layer in cache keys).
    pub key: u64,
}

impl Layer {
    /// The layer of `params`' enabled multiple exposure, if it has a photo `store` has.
    pub fn of(params: &EditParams, store: &ExposureStore) -> Option<Layer> {
        let m = params.get::<params::MultipleExposure>()?;
        let photo_ref = m.photo.as_ref()?;
        let photo = store.get(&photo_ref.sha256)?;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        photo_ref.sha256.to_ascii_lowercase().hash(&mut h);
        m.blend.hash(&mut h);
        m.ev.to_bits().hash(&mut h);
        Some(Layer { photo, blend: m.blend, gain: m.ev.clamp(-10.0, 10.0).exp2(), key: h.finish().max(1) })
    }

    /// The cache key of an optional layer: 0 without one.
    pub fn key_of(layer: Option<&Layer>) -> u64 {
        layer.map_or(0, |l| l.key)
    }

    /// Blend this layer into `img`, pixels `at` of `base`'s base image for `factor`.
    pub fn apply(&self, img: &mut Image, base: &RawPhoto, factor: usize, at: Region) {
        let other = other_region(base, &self.photo, factor, at);
        blend(img, &other, self.blend, self.gain);
    }
}

/// Pixels `at` of `other` as it lies on `base`'s base image for `factor`: scaled to
/// cover it, centred. The same pixels whatever `at` is (regions match whole renders).
pub fn other_region(base: &RawPhoto, other: &RawPhoto, factor: usize, at: Region) -> Image {
    let factor = factor.max(1);
    if (base.width, base.height) == (other.width, other.height) {
        return demosaic::develop_base_region(other, factor, at);
    }
    let scale = (base.width as f32 / other.width as f32).max(base.height as f32 / other.height as f32);
    let offset = ((base.width as f32 - scale * other.width as f32) / 2.0, (base.height as f32 - scale * other.height as f32) / 2.0);
    // Binned as much as possible while keeping at least the resolution needed.
    let other_factor = ((factor as f32 / scale).floor() as usize).clamp(1, 64);
    let (ow, oh) = demosaic::base_size(other, other_factor);
    // A coordinate on the base image (in its pixels) → on the other's for `other_factor`.
    let map = |u: f32, origin: f32| (u * factor as f32 - origin) / scale / other_factor as f32;
    let span = |from: usize, to: usize, origin: f32, size: usize| {
        let lo = (map(from as f32 + 0.5, origin).floor() - 1.0).max(0.0) as usize;
        let hi = (map(to as f32 - 0.5, origin).floor() + 2.0).max(0.0) as usize;
        let lo = lo.min(size - 1);
        (lo, hi.clamp(lo + 1, size))
    };
    let (x0, x1) = span(at.x, at.right(), offset.0, ow);
    let (y0, y1) = span(at.y, at.bottom(), offset.1, oh);
    let src_at = Region { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    let src = demosaic::develop_base_region(other, other_factor, src_at);
    let xs: Vec<f32> = (at.x..at.right()).map(|x| map(x as f32 + 0.5, offset.0) - x0 as f32).collect();
    let mut out = Image::new(at.width, at.height);
    for (j, y) in (at.y..at.bottom()).enumerate() {
        let v = map(y as f32 + 0.5, offset.1) - y0 as f32;
        let row = &mut out.pixels[j * at.width..(j + 1) * at.width];
        for (px, &u) in row.iter_mut().zip(&xs) {
            *px = src.sample_bilinear(u, v);
        }
    }
    out
}

/// Blend `other`, times `gain`, into `img` (same size).
pub fn blend(img: &mut Image, other: &Image, mode: ExposureBlend, gain: f32) {
    debug_assert_eq!((img.width, img.height), (other.width, other.height));
    let pairs = img.pixels.iter_mut().zip(&other.pixels);
    match mode {
        ExposureBlend::Additive => pairs.for_each(|(a, b)| *a = std::array::from_fn(|c| a[c] + gain * b[c])),
        ExposureBlend::Average => pairs.for_each(|(a, b)| *a = std::array::from_fn(|c| 0.5 * (a[c] + gain * b[c]))),
        ExposureBlend::Lighten | ExposureBlend::Darken => {
            let lighten = mode == ExposureBlend::Lighten;
            pairs.for_each(|(a, b)| {
                let b = b.map(|v| gain * v);
                if (color::luminance(b) > color::luminance(*a)) == lighten {
                    *a = b;
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(pixels: Vec<[f32; 3]>) -> Image {
        Image { width: pixels.len(), height: 1, pixels }
    }

    #[test]
    fn modes() {
        let a = image(vec![[0.2, 0.2, 0.2], [0.8, 0.1, 0.1]]);
        let b = image(vec![[0.1, 0.1, 0.1], [0.2, 0.4, 0.2]]);
        let run = |mode, gain| {
            let mut img = a.clone();
            blend(&mut img, &b, mode, gain);
            img.pixels
        };
        assert_eq!(run(ExposureBlend::Additive, 2.0)[0], [0.4, 0.4, 0.4]);
        assert_eq!(run(ExposureBlend::Average, 1.0)[0], [0.15000001, 0.15000001, 0.15000001]);
        // By luminance, not per channel: green weighs most.
        assert_eq!(run(ExposureBlend::Lighten, 1.0), vec![[0.2, 0.2, 0.2], [0.2, 0.4, 0.2]]);
        assert_eq!(run(ExposureBlend::Darken, 1.0), vec![[0.1, 0.1, 0.1], [0.8, 0.1, 0.1]]);
    }
}
