//! Frame: borders around an exported image, like darktable's `borders.c` ("framing").
//!
//! An export setting, not part of the recipe: it's applied to the encoded render,
//! after the pipeline, so it never affects previews, regions, overlays or shapes.
//! Lengths are fractions of the image's shorter side, so a frame looks the same at
//! every export size. [`crate::export::render_size`] fits the image so that the framed
//! result stays within the export bounds.
//!
//! Mirrored in `packages/pipeline/src/frame.ts` (`frameLayout`, for the export dialog's
//! preview); the TS tests compare both.

use serde::{Deserialize, Serialize};


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

    /// The border and line colours (sRGB), as parsed (white and black if they don't).
    pub fn colors(&self) -> [[u8; 3]; 2] {
        [rgb(&self.color, [255, 255, 255]), rgb(&self.line_color, [0, 0, 0])]
    }

    /// A `width × height` image of interleaved samples (`color.len()` per pixel) in
    /// this frame, with the border and line colours given as samples too. Returns the
    /// framed image's size and samples.
    pub fn apply_pixels<T: Copy>(&self, img: &[T], width: usize, height: usize, color: &[T], line: &[T]) -> (usize, usize, Vec<T>) {
        let channels = color.len();
        assert_eq!(line.len(), channels);
        assert_eq!(img.len(), width * height * channels);
        let l = self.layout(width, height);
        let mut data: Vec<T> = color.iter().copied().cycle().take(l.width * l.height * channels).collect();
        if l.line_width > 0 {
            let inner = l.line_offset;
            let outer = inner + l.line_width;
            // The line's outer rectangle, clipped to the frame, minus its inner one.
            let x0 = l.x.saturating_sub(outer);
            let y0 = l.y.saturating_sub(outer);
            let x1 = (l.x + width + outer).min(l.width);
            let y1 = (l.y + height + outer).min(l.height);
            let (ix0, iy0) = (l.x as isize - inner as isize, l.y as isize - inner as isize);
            let (ix1, iy1) = ((l.x + width + inner) as isize, (l.y + height + inner) as isize);
            for y in y0..y1 {
                let row = &mut data[y * l.width * channels..(y + 1) * l.width * channels];
                let inside_rows = (y as isize) >= iy0 && (y as isize) < iy1;
                for x in x0..x1 {
                    if inside_rows && (x as isize) >= ix0 && (x as isize) < ix1 {
                        continue;
                    }
                    row[x * channels..(x + 1) * channels].copy_from_slice(line);
                }
            }
        }
        let stride = width * channels;
        for y in 0..height {
            let at = ((l.y + y) * l.width + l.x) * channels;
            data[at..at + stride].copy_from_slice(&img[y * stride..(y + 1) * stride]);
        }
        (l.width, l.height, data)
    }
}

/// `#rrggbb`, or `fallback` if it doesn't parse.
fn rgb(hex: &str, fallback: [u8; 3]) -> [u8; 3] {
    let parse = || {
        let hex = hex.strip_prefix('#')?;
        if hex.len() != 6 || !hex.is_ascii() {
            return None;
        }
        let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
        Some([channel(0)?, channel(2)?, channel(4)?])
    };
    parse().unwrap_or(fallback)
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
        let img = [9u8, 9, 9, 255].repeat(100);
        let f = Frame { line: 0.1, line_offset: 0.1, color: "#102030".into(), line_color: "#ff0000".into(), ..frame(0.5, 0.0) };
        let [[r, g, b], [lr, lg, lb]] = f.colors();
        let (width, height, out) = f.apply_pixels(&img, 10, 10, &[r, g, b, 255], &[lr, lg, lb, 255]);
        assert_eq!((width, height), (20, 20));
        let px = |x: usize, y: usize| &out[(y * 20 + x) * 4..(y * 20 + x) * 4 + 4];
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
        assert_eq!(rgb("white", [1, 2, 3]), [1, 2, 3]);
        assert_eq!(rgb("#00ff7f", [1, 2, 3]), [0, 255, 127]);
    }
}
