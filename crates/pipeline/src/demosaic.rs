//! Turn sensor data into a linear RGB "base" image in the working space.
//!
//! * At full resolution (`factor == 1`) mosaic sensors are demosaiced bilinearly.
//! * When downscaling (`factor >= 2`) each `factor × factor` block of photosites is
//!   binned into one pixel by averaging the samples of each colour ("superpixel").
//!   This is fast, alias-free and exactly what previews and thumbnails need.
//!
//! The base image is then white balanced with the camera reference multipliers (D65
//! light is neutral; colour calibration adapts to the scene's light), highlight-clipped
//! so that saturated photosites take the as-shot white, and converted to linear Rec.2020.

use rawler::CFA;

use crate::color;
use crate::decode::{Layout, RawPhoto};
use crate::image::{Image, Mask};

pub fn develop_base(photo: &RawPhoto, factor: usize) -> Image {
    let factor = factor.max(1);
    let mut img = match &photo.layout {
        Layout::Mosaic(cfa) if factor == 1 => demosaic_bilinear(photo, cfa),
        Layout::Mosaic(cfa) => bin_mosaic(photo, cfa, factor),
        Layout::Rgb => bin_plain(photo, factor, 3),
        Layout::Mono => bin_plain(photo, factor, 1),
    };

    let (wb, as_shot, matrix) = match photo.layout {
        Layout::Mono => ([1.0; 3], [1.0; 3], color::IDENTITY),
        _ => (photo.wb_reference, photo.wb, photo.working_from_camera),
    };
    // A photosite at saturation reads 1.0; after white balance that becomes wb[c].
    // Clipping every channel where the smallest as-shot multiplier would put it keeps
    // blown highlights the colour of the as-shot white (rather than magenta), which
    // colour calibration's default "as shot" illuminant turns white.
    let min = as_shot.iter().copied().fold(f32::INFINITY, f32::min);
    let clip = [0, 1, 2].map(|c| min * wb[c] / as_shot[c]);
    img.map_in_place(|p| {
        let balanced = [(p[0] * wb[0]).min(clip[0]), (p[1] * wb[1]).min(clip[1]), (p[2] * wb[2]).min(clip[2])];
        color::mul_vec(&matrix, balanced)
    });
    img
}

/// Normalised sample at or above which a photosite counts as saturated. Slightly
/// below 1: the white level some cameras report is a little above where they clip.
pub const SENSOR_CLIP: f32 = 0.99;

/// The pixels of the base image for `factor` (same size as [`develop_base`]'s) that
/// contain at least one saturated photosite.
pub fn clipped_photosites(photo: &RawPhoto, factor: usize) -> Mask {
    let factor = factor.max(1);
    let channels = match photo.layout {
        Layout::Rgb => 3,
        _ => 1,
    };
    let (w, h) = ((photo.width / factor).max(1), (photo.height / factor).max(1));
    let mut mask = Mask::new(w, h);
    for oy in 0..h {
        for ox in 0..w {
            let clipped = (oy * factor..((oy + 1) * factor).min(photo.height)).any(|y| {
                (ox * factor..((ox + 1) * factor).min(photo.width)).any(|x| (0..channels).any(|c| photo.sample(x, y, c) >= SENSOR_CLIP))
            });
            if clipped {
                mask.set(ox, oy);
            }
        }
    }
    mask
}

fn bin_mosaic(photo: &RawPhoto, cfa: &CFA, factor: usize) -> Image {
    let (w, h) = (photo.width / factor, photo.height / factor);
    let mut img = Image::new(w.max(1), h.max(1));
    for oy in 0..img.height {
        for ox in 0..img.width {
            let mut grow = 0;
            loop {
                let (mut sum, mut count) = ([0.0f32; 3], [0u32; 3]);
                let x0 = (ox * factor).saturating_sub(grow);
                let y0 = (oy * factor).saturating_sub(grow);
                let x1 = (ox * factor + factor + grow).min(photo.width);
                let y1 = (oy * factor + factor + grow).min(photo.height);
                for y in y0..y1 {
                    for x in x0..x1 {
                        let c = photo.color_at(cfa, x, y);
                        sum[c] += photo.sample(x, y, 0);
                        count[c] += 1;
                    }
                }
                // Blocks smaller than the CFA period (e.g. X-Trans) may miss a colour.
                if count.iter().all(|&n| n > 0) || grow >= 4 {
                    img.pixels[oy * img.width + ox] = std::array::from_fn(|c| sum[c] / count[c].max(1) as f32);
                    break;
                }
                grow += 1;
            }
        }
    }
    img
}

fn demosaic_bilinear(photo: &RawPhoto, cfa: &CFA) -> Image {
    let (w, h) = (photo.width, photo.height);
    let mut img = Image::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let own = photo.color_at(cfa, x, y);
            let mut out = [0.0f32; 3];
            out[own] = photo.sample(x, y, 0);
            for (c, value) in out.iter_mut().enumerate() {
                if c == own {
                    continue;
                }
                // Average the nearest same-colour neighbours (3×3, widening for X-Trans).
                for radius in 1..=2usize {
                    let (mut sum, mut count) = (0.0f32, 0u32);
                    for ny in y.saturating_sub(radius)..(y + radius + 1).min(h) {
                        for nx in x.saturating_sub(radius)..(x + radius + 1).min(w) {
                            if photo.color_at(cfa, nx, ny) == c {
                                sum += photo.sample(nx, ny, 0);
                                count += 1;
                            }
                        }
                    }
                    if count > 0 {
                        *value = sum / count as f32;
                        break;
                    }
                }
            }
            img.pixels[y * w + x] = out;
        }
    }
    img
}

fn bin_plain(photo: &RawPhoto, factor: usize, channels: usize) -> Image {
    let (w, h) = ((photo.width / factor).max(1), (photo.height / factor).max(1));
    let mut img = Image::new(w, h);
    let norm = 1.0 / (factor * factor) as f32;
    for oy in 0..h {
        for ox in 0..w {
            let mut sum = [0.0f32; 3];
            for y in oy * factor..((oy + 1) * factor).min(photo.height) {
                for x in ox * factor..((ox + 1) * factor).min(photo.width) {
                    for (c, s) in sum.iter_mut().enumerate() {
                        *s += photo.sample(x, y, c.min(channels - 1));
                    }
                }
            }
            img.pixels[oy * w + ox] = sum.map(|s| s * norm);
        }
    }
    img
}
