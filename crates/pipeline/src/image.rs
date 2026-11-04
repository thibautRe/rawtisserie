/// A linear RGB pixel. Values are scene-referred: they may exceed 1.0.
pub type Rgb = [f32; 3];

/// A floating point RGB image, row-major, top-left origin.
#[derive(Clone, Debug)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<Rgb>,
}

impl Image {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            pixels: vec![[0.0; 3]; width * height],
        }
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> Rgb {
        self.pixels[y * self.width + x]
    }

    /// Bilinear sample at continuous coordinates where pixel `(i, j)` covers
    /// `[i, i+1) × [j, j+1)`. Coordinates outside the image are clamped to the edge.
    pub fn sample_bilinear(&self, x: f32, y: f32) -> Rgb {
        let fx = (x - 0.5).clamp(0.0, (self.width - 1) as f32);
        let fy = (y - 0.5).clamp(0.0, (self.height - 1) as f32);
        let x0 = fx as usize;
        let y0 = fy as usize;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let (a, b, c, d) = (self.get(x0, y0), self.get(x1, y0), self.get(x0, y1), self.get(x1, y1));
        let mut out = [0.0; 3];
        for i in 0..3 {
            let top = a[i] + (b[i] - a[i]) * tx;
            let bottom = c[i] + (d[i] - c[i]) * tx;
            out[i] = top + (bottom - top) * ty;
        }
        out
    }

    /// [`sample_bilinear`](Self::sample_bilinear) for one channel.
    #[inline]
    pub fn sample_bilinear_channel(&self, x: f32, y: f32, c: usize) -> f32 {
        let fx = (x - 0.5).clamp(0.0, (self.width - 1) as f32);
        let fy = (y - 0.5).clamp(0.0, (self.height - 1) as f32);
        let x0 = fx as usize;
        let y0 = fy as usize;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let (row0, row1) = (y0 * self.width, y1 * self.width);
        let (a, b) = (self.pixels[row0 + x0][c], self.pixels[row0 + x1][c]);
        let (d0, d1) = (self.pixels[row1 + x0][c], self.pixels[row1 + x1][c]);
        let top = a + (b - a) * tx;
        let bottom = d0 + (d1 - d0) * tx;
        top + (bottom - top) * ty
    }

    pub fn map_in_place(&mut self, f: impl Fn(Rgb) -> Rgb) {
        for p in &mut self.pixels {
            *p = f(*p);
        }
    }
}

/// A 1-bit-per-pixel image, row-major, top-left origin.
#[derive(Clone, Debug)]
pub struct Mask {
    pub width: usize,
    pub height: usize,
    bits: Vec<u64>,
}

impl Mask {
    pub fn new(width: usize, height: usize) -> Self {
        Self { width, height, bits: vec![0; (width * height).div_ceil(64)] }
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> bool {
        let i = y * self.width + x;
        self.bits[i / 64] >> (i % 64) & 1 != 0
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize) {
        let i = y * self.width + x;
        self.bits[i / 64] |= 1 << (i % 64);
    }
}

/// An 8-bit, display-referred sRGB image with alpha (the layout of a canvas `ImageData`).
#[derive(Clone, Debug)]
pub struct Rgba8 {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// A rectangle of pixels, top-left origin.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Region {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

impl Region {
    /// The whole of a `width × height` image.
    pub fn full(width: usize, height: usize) -> Self {
        Self { x: 0, y: 0, width, height }
    }

    pub fn right(&self) -> usize {
        self.x + self.width
    }

    pub fn bottom(&self) -> usize {
        self.y + self.height
    }

    /// The part of this region inside a `width × height` image.
    pub fn clipped(&self, width: usize, height: usize) -> Self {
        let (x, y) = (self.x.min(width), self.y.min(height));
        Self { x, y, width: self.right().min(width) - x, height: self.bottom().min(height) - y }
    }

    /// Grown by `margin` on every side, within a `width × height` image.
    pub fn padded(&self, margin: usize, width: usize, height: usize) -> Self {
        let (x, y) = (self.x.saturating_sub(margin), self.y.saturating_sub(margin));
        Self { x, y, width: (self.right() + margin).min(width) - x, height: (self.bottom() + margin).min(height) - y }
    }

    pub fn contains(&self, other: &Region) -> bool {
        other.x >= self.x && other.y >= self.y && other.right() <= self.right() && other.bottom() <= self.bottom()
    }
}

impl Image {
    /// A copy of `region` of this image.
    pub fn crop(&self, region: Region) -> Image {
        let pixels = (region.y..region.bottom())
            .flat_map(|y| &self.pixels[y * self.width + region.x..y * self.width + region.right()])
            .copied()
            .collect();
        Image { width: region.width, height: region.height, pixels }
    }
}
