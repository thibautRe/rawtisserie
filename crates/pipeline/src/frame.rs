//! Frame: borders around an exported image, like darktable's `borders.c` ("framing").
//!
//! An export setting, not part of the recipe: it's applied to the encoded sRGB render,
//! after the pipeline, so it never affects previews, regions, overlays or shapes.
//! Lengths are fractions of the image's shorter side, so a frame looks the same at
//! every export size. [`render`] fits the image so that the framed result stays within
//! the export bounds.
//!
//! Mirrored in `packages/pipeline/src/frame.ts` (`frameLayout`, for the export dialog's
//! preview); the TS tests compare both.

use serde::{Deserialize, Serialize};

use crate::image::Rgba8;
use crate::params::EditParams;
use crate::pipeline::{Developer, Quality, RenderSize};

/// Orientation of the frame when it has an aspect ratio.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Orientation {
    /// The image's: landscape if it's wider than tall, portrait otherwise.
    #[default]
    Auto,
    Portrait,
    Landscape,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Frame {
    /// Border on each side, as a fraction of the image's shorter side.
    pub size: f32,
    /// Aspect ratio of the framed image, long side over short side (≥ 1), or 0 to
    /// keep the image's. The extra space goes around the border.
    pub aspect: f32,
    pub orientation: Orientation,
    /// Where the image sits in the extra space an aspect ratio adds, horizontally and
    /// vertically: 0 left/top, 0.5 centred, 1 right/bottom.
    pub position: [f32; 2],
    /// Border colour, `#rrggbb` (sRGB).
    pub color: String,
    /// Width of a line around the image, as a fraction of its shorter side (0: none).
    pub line: f32,
    /// Gap between the image and the line, same unit.
    pub line_offset: f32,
    /// Line colour, `#rrggbb`.
    pub line_color: String,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            size: 0.05,
            aspect: 0.0,
            orientation: Orientation::Auto,
            position: [0.5, 0.5],
            color: "#ffffff".into(),
            line: 0.0,
            line_offset: 0.0,
            line_color: "#000000".into(),
        }
    }
}

/// Where everything goes in the framed image, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub width: usize,
    pub height: usize,
    /// Top-left corner of the image.
    pub x: usize,
    pub y: usize,
    /// Gap between the image and the line, and the line's width (0: no line).
    pub line_offset: usize,
    pub line_width: usize,
}

fn round(v: f32) -> usize {
    v.max(0.0).round() as usize
}

impl Frame {
    /// The layout of a `width × height` image in this frame.
    pub fn layout(&self, width: usize, height: usize) -> Layout {
        let short = width.min(height) as f32;
        let border = round(self.size.clamp(0.0, 10.0) * short);
        let (mut w, mut h) = (width + 2 * border, height + 2 * border);
        if self.aspect >= 1.0 {
            let landscape = match self.orientation {
                Orientation::Auto => width > height,
                Orientation::Portrait => false,
                Orientation::Landscape => true,
            };
            let ratio = if landscape { self.aspect } else { 1.0 / self.aspect };
            if (w as f32) < h as f32 * ratio {
                w = round(h as f32 * ratio).max(w);
            } else {
                h = round(w as f32 / ratio).max(h);
            }
        }
        let place = |extra: usize, at: f32| border + round(extra as f32 * at.clamp(0.0, 1.0)).min(extra);
        let line_width = if self.line > 0.0 { round(self.line * short).max(1) } else { 0 };
        Layout {
            width: w,
            height: h,
            x: place(w - width - 2 * border, self.position[0]),
            y: place(h - height - 2 * border, self.position[1]),
            line_offset: if line_width > 0 { round(self.line_offset * short) } else { 0 },
            line_width,
        }
    }

    /// `img` in this frame.
    pub fn apply(&self, img: &Rgba8) -> Rgba8 {
        let l = self.layout(img.width, img.height);
        let color = rgba(&self.color, [255, 255, 255]);
        let mut data: Vec<u8> = color.iter().copied().cycle().take(l.width * l.height * 4).collect();
        if l.line_width > 0 {
            let line = rgba(&self.line_color, [0, 0, 0]);
            let inner = l.line_offset;
            let outer = inner + l.line_width;
            // The line's outer rectangle, clipped to the frame, minus its inner one.
            let x0 = l.x.saturating_sub(outer);
            let y0 = l.y.saturating_sub(outer);
            let x1 = (l.x + img.width + outer).min(l.width);
            let y1 = (l.y + img.height + outer).min(l.height);
            let (ix0, iy0) = (l.x as isize - inner as isize, l.y as isize - inner as isize);
            let (ix1, iy1) = ((l.x + img.width + inner) as isize, (l.y + img.height + inner) as isize);
            for y in y0..y1 {
                let row = &mut data[y * l.width * 4..(y + 1) * l.width * 4];
                let inside_rows = (y as isize) >= iy0 && (y as isize) < iy1;
                for x in x0..x1 {
                    if inside_rows && (x as isize) >= ix0 && (x as isize) < ix1 {
                        continue;
                    }
                    row[x * 4..x * 4 + 4].copy_from_slice(&line);
                }
            }
        }
        let stride = img.width * 4;
        for y in 0..img.height {
            let at = ((l.y + y) * l.width + l.x) * 4;
            data[at..at + stride].copy_from_slice(&img.data[y * stride..(y + 1) * stride]);
        }
        Rgba8 { width: l.width, height: l.height, data }
    }
}

/// `#rrggbb` as opaque RGBA, or `fallback` if it doesn't parse.
fn rgba(hex: &str, fallback: [u8; 3]) -> [u8; 4] {
    let parse = || {
        let hex = hex.strip_prefix('#')?;
        if hex.len() != 6 || !hex.is_ascii() {
            return None;
        }
        let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
        Some([channel(0)?, channel(2)?, channel(4)?])
    };
    let [r, g, b] = parse().unwrap_or(fallback);
    [r, g, b, 255]
}

/// A final-quality render within `max_width × max_height` (0: unbounded), framed if
/// `frame` is given. The framed image fits the bounds: the photo is rendered smaller.
pub fn render(dev: &mut Developer, params: &EditParams, max_width: u32, max_height: u32, frame: Option<&Frame>) -> Rgba8 {
    let Some(frame) = frame else {
        return dev.render(params, RenderSize::fit(max_width, max_height), Quality::Final);
    };
    let bounds = fit(dev, params, max_width, max_height, frame);
    frame.apply(&dev.render(params, bounds, Quality::Final))
}

/// Bounds for the photo so that, framed, it fits `max_width × max_height`.
pub fn fit(dev: &Developer, params: &EditParams, max_width: u32, max_height: u32, frame: &Frame) -> RenderSize {
    if max_width == 0 && max_height == 0 {
        return RenderSize::FULL;
    }
    // The framed size grows with the photo's width: find the widest photo that fits
    // (never wider than at full resolution).
    let fits = |width: u32| {
        let (w, h, _) = dev.output_size(params, RenderSize::fit(width, 0));
        let l = frame.layout(w, h);
        (max_width == 0 || l.width <= max_width as usize) && (max_height == 0 || l.height <= max_height as usize)
    };
    let (full_width, ..) = dev.output_size(params, RenderSize::FULL);
    let (mut lo, mut hi) = (1u32, full_width as u32);
    if fits(hi) {
        return RenderSize::FULL;
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if fits(mid) { lo = mid } else { hi = mid }
    }
    RenderSize::fit(lo, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(size: f32, aspect: f32) -> Frame {
        Frame { size, aspect, ..Frame::default() }
    }

    #[test]
    fn border_is_a_fraction_of_the_shorter_side() {
        let l = frame(0.1, 0.0).layout(600, 400);
        assert_eq!((l.width, l.height, l.x, l.y), (680, 480, 40, 40));
    }

    #[test]
    fn aspect_ratio_follows_the_image_by_default() {
        // Landscape 3:2 in a 1:1 frame: the extra space goes above and below.
        let l = frame(0.0, 1.0).layout(600, 400);
        assert_eq!((l.width, l.height, l.x, l.y), (600, 600, 0, 100));
        // Portrait 4:5 around a landscape image.
        let f = Frame { orientation: Orientation::Portrait, ..frame(0.05, 1.25) };
        let l = f.layout(600, 400);
        assert_eq!((l.width, l.height), (640, 800));
        assert_eq!((l.x, l.y), (20, 200));
        // Auto on a portrait image.
        let l = frame(0.0, 1.5).layout(400, 500);
        assert_eq!((l.width, l.height), (400, 600));
    }

    #[test]
    fn position_moves_the_image_in_the_extra_space() {
        let f = Frame { position: [0.5, 0.25], ..frame(0.0, 1.0) };
        assert_eq!(f.layout(600, 400).y, 50);
        let f = Frame { position: [0.5, 1.0], ..frame(0.0, 1.0) };
        assert_eq!(f.layout(600, 400).y, 200);
    }

    #[test]
    fn apply_paints_border_line_and_image() {
        let img = Rgba8 { width: 10, height: 10, data: [9, 9, 9, 255].repeat(100) };
        let f = Frame { line: 0.1, line_offset: 0.1, color: "#102030".into(), line_color: "#ff0000".into(), ..frame(0.5, 0.0) };
        let out = f.apply(&img);
        assert_eq!((out.width, out.height), (20, 20));
        let px = |x: usize, y: usize| &out.data[(y * 20 + x) * 4..(y * 20 + x) * 4 + 4];
        assert_eq!(px(0, 0), [16, 32, 48, 255]);
        assert_eq!(px(5, 5), [9, 9, 9, 255]); // the image
        assert_eq!(px(4, 4), [16, 32, 48, 255]); // the gap
        assert_eq!(px(3, 10), [255, 0, 0, 255]); // the line, left
        assert_eq!(px(10, 15), [16, 32, 48, 255]); // the gap, bottom
        assert_eq!(px(10, 16), [255, 0, 0, 255]); // the line, bottom
        assert_eq!(px(2, 10), [16, 32, 48, 255]);
    }

    #[test]
    fn bad_colours_fall_back() {
        assert_eq!(rgba("white", [1, 2, 3]), [1, 2, 3, 255]);
        assert_eq!(rgba("#00ff7f", [1, 2, 3]), [0, 255, 127, 255]);
    }
}
