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
