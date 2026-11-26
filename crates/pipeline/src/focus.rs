//! Focus areas (roadmap 8.9): where a photo is sharp, measured once per photo on its
//! sensor data, so it's a property of the capture rather than of a recipe.
//!
//! The measure (`edges`) finds the photo's edges and how wide each is blurred, in
//! sensor pixels: an absolute scale, comparable from one photo to the next. The map
//! keeps it on a grid of `CELL`-pixel cells of the measure (the sharpest edge in each),
//! only for edges sharper than `MAX_BLUR`, which views don't show; most cells have none,
//! so it's stored deflated.
//!
//! The luminance is the green photosites binned 2 × 2 for a mosaic (green is on every
//! Bayer block and nearly every X-Trans one), square-rooted so that photon noise is
//! about the same everywhere. It's read in strips, so a 60 MP file needs a few tens of MB.
//!
//! Everything is in the sensor frame (the base image, before orientation), normalised
//! like shapes (`crate::shapes`): `SensorMapping` places it on a version's output.

use std::io::Write;

use serde::Serialize;

use crate::decode::{Layout, RawPhoto};

mod edges;

/// Bumped whenever the measure changes, so stored maps are measured again.
pub const FOCUS_VERSION: u32 = 2;

/// Cells of the map, in the measure's pixels (binned 2 × 2 for a mosaic).
const CELL: usize = 2;
/// Edges blurred this much or more (σ, sensor pixels) aren't kept.
pub const MAX_BLUR: f32 = 5.0;
/// A cell's value is its sharpest edge's σ times this; `NO_EDGE` without one.
pub const BLUR_SCALE: f32 = 10.0;
pub const NO_EDGE: u8 = 255;

/// The edges of a photo and how blurred they are, by cell, in the sensor frame.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusMap {
    pub version: u32,
    pub cols: usize,
    pub rows: usize,
    /// Row by row, σ × `BLUR_SCALE` of the cell's sharpest edge or `NO_EDGE`: deflated
    /// (zlib) and base64 in JSON.
    #[serde(serialize_with = "deflated")]
    pub cells: Vec<u8>,
}

impl FocusMap {
    /// The blur (σ, sensor pixels) of the sharpest edge in a cell, if any.
    pub fn blur(&self, col: usize, row: usize) -> Option<f32> {
        let v = self.cells[row * self.cols + col];
        (v != NO_EDGE).then(|| v as f32 / BLUR_SCALE)
    }
}

pub fn measure(photo: &RawPhoto) -> FocusMap {
    let luma = Luma::new(photo);
    let blur = edges::measure(&luma);
    let (w, h) = (luma.width, luma.height);
    let (cols, rows) = (w.div_ceil(CELL), h.div_ceil(CELL));
    let mut cells = vec![NO_EDGE; cols * rows];
    for y in 0..h {
        for x in 0..w {
            let v = blur[y * w + x];
            let b = v as f32 * edges::STEP;
            if v == edges::NONE || b >= MAX_BLUR {
                continue;
            }
            let c = &mut cells[(y / CELL) * cols + x / CELL];
            *c = (*c).min((b * BLUR_SCALE).round() as u8);
        }
    }
    FocusMap { version: FOCUS_VERSION, cols, rows, cells }
}

fn deflated<S: serde::Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    z.write_all(bytes).map_err(serde::ser::Error::custom)?;
    let packed = z.finish().map_err(serde::ser::Error::custom)?;
    s.serialize_str(&encode_base64(&packed))
}

/// The luminance the measure reads, square-rooted, a row at a time.
struct Luma<'a> {
    photo: &'a RawPhoto,
    factor: usize,
    width: usize,
    height: usize,
    /// For a mosaic, which photosites of a `factor`-sized block (`dy * factor + dx`)
    /// to average, per block position in the CFA's period: green ones, or all.
    picks: Option<Picks>,
}

struct Picks {
    period_x: usize,
    period_y: usize,
    /// By `(block_y % period_y) * period_x + block_x % period_x`.
    offsets: Vec<Vec<(usize, usize)>>,
}

impl<'a> Luma<'a> {
    fn new(photo: &'a RawPhoto) -> Self {
        let factor = match photo.layout {
            Layout::Mosaic(_) => 2,
            // Images aren't mosaics; very large ones are halved, which keeps detail enough.
            _ if photo.width.max(photo.height) > 8000 => 2,
            _ => 1,
        };
        let picks = match &photo.layout {
            Layout::Mosaic(cfa) => {
                // Blocks repeat with the CFA (Bayer 2 × 2: one; X-Trans 6 × 6: nine).
                let (px, py) = (cfa.width.max(1) / gcd(cfa.width.max(1), factor), cfa.height.max(1) / gcd(cfa.height.max(1), factor));
                let offsets = (0..py)
                    .flat_map(|by| (0..px).map(move |bx| (bx, by)))
                    .map(|(bx, by)| {
                        let block: Vec<(usize, usize)> =
                            (0..factor).flat_map(|dy| (0..factor).map(move |dx| (dx, dy))).collect();
                        let greens: Vec<(usize, usize)> = block
                            .iter()
                            .copied()
                            .filter(|&(dx, dy)| photo.color_at(cfa, bx * factor + dx, by * factor + dy) == 1)
                            .collect();
                        if greens.is_empty() { block } else { greens }
                    })
                    .collect::<Vec<_>>();
                Some(Picks { period_x: px, period_y: py, offsets })
            }
            _ => None,
        };
        Self { photo, factor, width: (photo.width / factor).max(1), height: (photo.height / factor).max(1), picks }
    }

    fn row(&self, y: usize, out: &mut [f32]) {
        let p = self.photo;
        let f = self.factor;
        for (x, o) in out.iter_mut().enumerate() {
            let v = match (&self.picks, &p.layout) {
                (Some(picks), _) => {
                    let sites = &picks.offsets[(y % picks.period_y) * picks.period_x + x % picks.period_x];
                    let sum: f32 = sites
                        .iter()
                        .map(|&(dx, dy)| p.sample((x * f + dx).min(p.width - 1), (y * f + dy).min(p.height - 1), 0))
                        .sum();
                    sum / sites.len() as f32
                }
                (None, Layout::Rgb) => {
                    let mut s = 0.0;
                    for dy in 0..f {
                        for dx in 0..f {
                            let (sx, sy) = ((x * f + dx).min(p.width - 1), (y * f + dy).min(p.height - 1));
                            s += 0.25 * p.sample(sx, sy, 0) + 0.5 * p.sample(sx, sy, 1) + 0.25 * p.sample(sx, sy, 2);
                        }
                    }
                    s / (f * f) as f32
                }
                (None, _) => {
                    let mut s = 0.0;
                    for dy in 0..f {
                        for dx in 0..f {
                            s += p.sample((x * f + dx).min(p.width - 1), (y * f + dy).min(p.height - 1), 0);
                        }
                    }
                    s / (f * f) as f32
                }
            };
            *o = v.max(0.0).sqrt();
        }
    }
}


fn gcd(a: usize, b: usize) -> usize {
    if b == 0 { a } else { gcd(b, a % b) }
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encodes() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(&[255, 0, 254]), "/wD+");
    }
}
