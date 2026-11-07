//! Creative 3D LUTs ("CLUTs", roadmap 4.8), after darktable's `lut3d.c`: `.cube` files
//! and Hald CLUT PNGs, decoded into one canonical form.
//!
//! A LUT is identified by the SHA-256 of its canonical form ([`Clut::to_canonical`]), not
//! of the file it came from: the same table re-encoded (a recompressed PNG, a `.cube`
//! with other comments) gets the same id, so that storage can be shared and recipes
//! refer to the table itself. LUTs are stored and sent packed ([`Clut::to_packed`]: the
//! canonical form with each node as a difference from the previous one, deflated, about
//! as small as a Hald PNG); [`Clut::parse`] reads that back too.
//!
//! The LUTs are display-referred: they map encoded sRGB to encoded sRGB
//! ([`InputSpace::Srgb`]), and run after filmic (`crate::ops::point`).
//!
//! Deviations from darktable: no `.3dl`, no compressed `.png` LUTs (gmic), no 1D LUTs,
//! no TIFF Hald CLUTs; the input colour space is fixed by the LUT (for now always sRGB)
//! rather than chosen in the module.

use std::io::Cursor;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::image::Rgb;

/// Largest grid: a level 12 Hald CLUT (144³ nodes, 9 MB at 8 bits).
pub const MAX_SIZE: usize = 144;

const MAGIC: &[u8; 6] = b"RTCLUT";
const PACKED_MAGIC: &[u8; 6] = b"RTCLUZ";
const FORMAT_VERSION: u16 = 1;
const HEADER_LEN: usize = 6 + 2 + 4 + 24;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ClutError {
    #[error("not a .cube file or a Hald CLUT PNG")]
    UnknownFormat,
    #[error("invalid .cube file, line {line}: {message}")]
    Cube { line: usize, message: String },
    #[error("invalid Hald CLUT: {0}")]
    Hald(String),
    #[error("invalid LUT data: {0}")]
    Canonical(String),
    #[error("LUT too large: {0}³ nodes (at most {MAX_SIZE}³)")]
    TooLarge(usize),
}

/// What a LUT's input and output values are.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputSpace {
    /// Display-referred sRGB, encoded with its transfer function.
    #[default]
    Srgb,
}

impl InputSpace {
    fn code(self) -> u8 {
        match self {
            InputSpace::Srgb => 0,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(InputSpace::Srgb),
            _ => None,
        }
    }
}

/// How values between the grid's nodes are computed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Interpolation {
    /// From the 4 corners of the tetrahedron the colour is in: smooth, keeps greys grey.
    #[default]
    Tetrahedral,
    /// From the 8 corners of the cube.
    Trilinear,
    /// From the 5 corners of the pyramid the colour is in.
    Pyramid,
}

/// The table's values, at the precision they came with.
#[derive(Clone)]
enum Data {
    U8(Vec<[u8; 3]>),
    U16(Vec<[u16; 3]>),
}

trait Sample: Copy {
    const SCALE: f32;
    fn value(self) -> f32;
}

impl Sample for u8 {
    const SCALE: f32 = 1.0 / 255.0;
    #[inline(always)]
    fn value(self) -> f32 {
        self as f32
    }
}

impl Sample for u16 {
    const SCALE: f32 = 1.0 / 65535.0;
    #[inline(always)]
    fn value(self) -> f32 {
        self as f32
    }
}

/// A decoded 3D LUT: `size³` nodes, red varying fastest (`.cube` and Hald order).
#[derive(Clone)]
pub struct Clut {
    size: usize,
    input: InputSpace,
    /// Inputs at the first and last nodes, per channel.
    domain: [Rgb; 2],
    /// Grid coordinate per unit of input, per channel.
    scale: Rgb,
    data: Data,
    id: String,
}

impl std::fmt::Debug for Clut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Clut").field("id", &self.id).field("size", &self.size).field("bit_depth", &self.bit_depth()).finish()
    }
}

impl Clut {
    /// A `.cube` file, a Hald CLUT PNG, or a canonical or packed form, told apart by
    /// their contents.
    pub fn parse(bytes: &[u8]) -> Result<Self, ClutError> {
        if bytes.starts_with(MAGIC) {
            Self::from_canonical(bytes)
        } else if bytes.starts_with(PACKED_MAGIC) {
            Self::from_packed(bytes)
        } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Self::from_hald_png(bytes)
        } else if let Ok(text) = std::str::from_utf8(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)) {
            Self::from_cube(text)
        } else {
            Err(ClutError::UnknownFormat)
        }
    }

    fn new(size: usize, input: InputSpace, domain: [Rgb; 2], data: Data) -> Self {
        let scale = std::array::from_fn(|i| (size - 1) as f32 / (domain[1][i] - domain[0][i]));
        let mut clut = Self { size, input, domain, scale, data, id: String::new() };
        let digest = Sha256::digest(clut.to_canonical());
        clut.id = digest.iter().map(|b| format!("{b:02x}")).collect();
        clut
    }

    /// The SHA-256 of the canonical form, in lowercase hex.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Nodes along each axis.
    pub fn size(&self) -> usize {
        self.size
    }

    pub fn bit_depth(&self) -> u8 {
        match self.data {
            Data::U8(_) => 8,
            Data::U16(_) => 16,
        }
    }

    pub fn input_space(&self) -> InputSpace {
        self.input
    }

    /// Bytes of memory the table takes.
    pub fn byte_size(&self) -> usize {
        self.size.pow(3) * 3 * (self.bit_depth() as usize / 8)
    }

    /// The canonical form, little-endian: `RTCLUT`, format version (u16), input space
    /// (u8), bit depth (u8: 8 or 16), size (u16), domain min and max (3 × f32 each), then
    /// the `size³` RGB nodes, red varying fastest, as u8 or u16.
    pub fn to_canonical(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + self.byte_size());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.push(self.input.code());
        out.push(self.bit_depth());
        out.extend_from_slice(&(self.size as u16).to_le_bytes());
        for v in self.domain.iter().flatten() {
            out.extend_from_slice(&v.to_le_bytes());
        }
        match &self.data {
            Data::U8(d) => out.extend(d.iter().flatten()),
            Data::U16(d) => out.extend(d.iter().flatten().flat_map(|v| v.to_le_bytes())),
        }
        out
    }

    /// The packed form: `RTCLUZ`, the rest of the canonical header, then the nodes
    /// zlib-compressed, each sample stored as its difference (wrapping) from the same
    /// channel of the previous node. Neighbouring nodes are close, so this compresses
    /// like a PNG's filters do (~1 MB for a 144³ 8-bit table; plain deflate: 7 MB).
    pub fn to_packed(&self) -> Vec<u8> {
        use std::io::Write;
        let canonical = self.to_canonical();
        let mut deltas = Vec::with_capacity(self.byte_size());
        match &self.data {
            Data::U8(_) => {
                let body = &canonical[HEADER_LEN..];
                deltas.extend(body.iter().enumerate().map(|(i, &v)| if i < 3 { v } else { v.wrapping_sub(body[i - 3]) }));
            }
            Data::U16(d) => {
                let samples: Vec<u16> = d.iter().flatten().copied().collect();
                let delta = |i: usize| if i < 3 { samples[i] } else { samples[i].wrapping_sub(samples[i - 3]) };
                deltas.extend((0..samples.len()).flat_map(|i| delta(i).to_le_bytes()));
            }
        }
        let mut out = Vec::with_capacity(HEADER_LEN + deltas.len() / 6);
        out.extend_from_slice(PACKED_MAGIC);
        out.extend_from_slice(&canonical[MAGIC.len()..HEADER_LEN]);
        let mut z = flate2::write::ZlibEncoder::new(out, flate2::Compression::default());
        z.write_all(&deltas).expect("writing to memory");
        z.finish().expect("writing to memory")
    }

    fn from_packed(bytes: &[u8]) -> Result<Self, ClutError> {
        use std::io::Read;
        let err = |m: &str| ClutError::Canonical(m.into());
        if bytes.len() < HEADER_LEN {
            return Err(err("truncated header"));
        }
        let size = check_size(u16::from_le_bytes([bytes[10], bytes[11]]) as usize)?;
        let sample_bytes = match bytes[9] {
            8 => 1,
            16 => 2,
            _ => return Err(err("unknown bit depth")),
        };
        let len = size.pow(3) * 3 * sample_bytes;
        let mut canonical = Vec::with_capacity(HEADER_LEN + len);
        canonical.extend_from_slice(MAGIC);
        canonical.extend_from_slice(&bytes[MAGIC.len()..HEADER_LEN]);
        // Read one byte more than needed, to tell a longer body from the right one.
        let mut z = flate2::read::ZlibDecoder::new(&bytes[HEADER_LEN..]).take(len as u64 + 1);
        z.read_to_end(&mut canonical).map_err(|e| err(&e.to_string()))?;
        if canonical.len() != HEADER_LEN + len {
            return Err(err("wrong data length"));
        }
        let body = &mut canonical[HEADER_LEN..];
        if sample_bytes == 1 {
            for i in 3..body.len() {
                body[i] = body[i].wrapping_add(body[i - 3]);
            }
        } else {
            for i in 3..body.len() / 2 {
                let prev = u16::from_le_bytes([body[2 * i - 6], body[2 * i - 5]]);
                let v = u16::from_le_bytes([body[2 * i], body[2 * i + 1]]).wrapping_add(prev);
                body[2 * i..2 * i + 2].copy_from_slice(&v.to_le_bytes());
            }
        }
        Self::from_canonical(&canonical)
    }

    fn from_canonical(bytes: &[u8]) -> Result<Self, ClutError> {
        let err = |m: &str| ClutError::Canonical(m.into());
        if bytes.len() < HEADER_LEN || !bytes.starts_with(MAGIC) {
            return Err(err("truncated header"));
        }
        let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        let f32_at = |i: usize| f32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
        if u16_at(6) != FORMAT_VERSION {
            return Err(err("unknown version"));
        }
        let input = InputSpace::from_code(bytes[8]).ok_or_else(|| err("unknown input space"))?;
        let depth = bytes[9];
        let size = check_size(u16_at(10) as usize)?;
        let domain = [[0, 1, 2].map(|i| f32_at(12 + 4 * i)), [0, 1, 2].map(|i| f32_at(24 + 4 * i))];
        check_domain(&domain).map_err(|m| err(&m))?;
        let body = &bytes[HEADER_LEN..];
        let nodes = size.pow(3);
        let data = match depth {
            8 if body.len() == nodes * 3 => Data::U8(body.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()),
            16 if body.len() == nodes * 6 => Data::U16(
                body.chunks_exact(6)
                    .map(|c| [0, 1, 2].map(|i| u16::from_le_bytes([c[2 * i], c[2 * i + 1]])))
                    .collect(),
            ),
            8 | 16 => return Err(err("wrong data length")),
            _ => return Err(err("unknown bit depth")),
        };
        Ok(Self::new(size, input, domain, data))
    }

    /// A Resolve/Adobe `.cube` file with a 3D table. Values are kept at 16 bits,
    /// clipped to [0, 1].
    pub fn from_cube(text: &str) -> Result<Self, ClutError> {
        let mut size = None;
        let mut domain = [[0.0f32; 3], [1.0; 3]];
        let mut values: Vec<[u16; 3]> = Vec::new();
        for (n, line) in text.lines().enumerate() {
            let err = |message: &str| ClutError::Cube { line: n + 1, message: message.into() };
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut words = line.split_whitespace();
            let first = words.next().unwrap_or_default();
            let floats = |words: std::str::SplitWhitespace| -> Result<Vec<f32>, ClutError> {
                words.map(|w| w.parse::<f32>().ok().filter(|v| v.is_finite()).ok_or_else(|| err("expected a number"))).collect()
            };
            let triple = |words| -> Result<Rgb, ClutError> {
                let v = floats(words)?;
                <[f32; 3]>::try_from(v).map_err(|_| err("expected three numbers"))
            };
            if first.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '.' || c == '+') {
                let n = size.ok_or_else(|| err("data before LUT_3D_SIZE"))?;
                if values.len() == n * n * n {
                    return Err(err("more data than LUT_3D_SIZE says"));
                }
                let rgb = triple(line.split_whitespace())?;
                values.push(rgb.map(|v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16));
                continue;
            }
            match first {
                "LUT_3D_SIZE" => {
                    if size.is_some() {
                        return Err(err("LUT_3D_SIZE given twice"));
                    }
                    let n = words.next().and_then(|w| w.parse::<usize>().ok()).ok_or_else(|| err("invalid LUT_3D_SIZE"))?;
                    size = Some(check_size(n)?);
                    values.reserve(n * n * n);
                }
                "LUT_1D_SIZE" => return Err(err("1D LUTs aren't supported")),
                "DOMAIN_MIN" => domain[0] = triple(words)?,
                "DOMAIN_MAX" => domain[1] = triple(words)?,
                "LUT_3D_INPUT_RANGE" => {
                    let v = floats(words)?;
                    let [lo, hi] = <[f32; 2]>::try_from(v).map_err(|_| err("expected two numbers"))?;
                    domain = [[lo; 3], [hi; 3]];
                }
                // TITLE, LUT_1D_INPUT_RANGE without a 1D table, vendor keywords…
                _ => {}
            }
        }
        let last = text.lines().count();
        let size = size.ok_or(ClutError::Cube { line: last, message: "no LUT_3D_SIZE".into() })?;
        if values.len() != size.pow(3) {
            let message = format!("{} nodes, LUT_3D_SIZE {size} needs {}", values.len(), size.pow(3));
            return Err(ClutError::Cube { line: last, message });
        }
        check_domain(&domain).map_err(|message| ClutError::Cube { line: last, message })?;
        Ok(Self::new(size, InputSpace::Srgb, domain, Data::U16(values)))
    }

    /// A Hald CLUT image: level `L` is an `L³ × L³` image of an `L²`-node grid, red
    /// varying fastest, row by row. 8 or 16 bits, RGB(A) or grey(+alpha).
    pub fn from_hald_png(bytes: &[u8]) -> Result<Self, ClutError> {
        let err = |e: &dyn std::fmt::Display| ClutError::Hald(e.to_string());
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::EXPAND);
        let header = decoder.read_header_info().map_err(|e| err(&e))?;
        let (width, height) = (header.width as usize, header.height as usize);
        let level = (1..=16).find(|l| l * l * l == width).filter(|_| width == height);
        let level = level.ok_or_else(|| ClutError::Hald(format!("{width}×{height} isn't a Hald CLUT (L³ × L³ pixels)")))?;
        let size = check_size(level * level)?;
        let mut reader = decoder.read_info().map_err(|e| err(&e))?;
        let mut buf = vec![0; reader.output_buffer_size().ok_or_else(|| ClutError::Hald("too large".into()))?];
        let info = reader.next_frame(&mut buf).map_err(|e| err(&e))?;
        let channels = match info.color_type {
            png::ColorType::Rgb => 3,
            png::ColorType::Rgba => 4,
            png::ColorType::Grayscale => 1,
            png::ColorType::GrayscaleAlpha => 2,
            png::ColorType::Indexed => unreachable!("expanded"),
        };
        let rows = buf[..info.line_size * height].chunks_exact(info.line_size);
        let data = match info.bit_depth {
            png::BitDepth::Eight => Data::U8(
                rows.flat_map(|row| row[..width * channels].chunks_exact(channels))
                    .map(|p| if channels < 3 { [p[0]; 3] } else { [p[0], p[1], p[2]] })
                    .collect(),
            ),
            png::BitDepth::Sixteen => Data::U16(
                rows.flat_map(|row| row[..width * channels * 2].chunks_exact(channels * 2))
                    .map(|p| {
                        let at = |i: usize| u16::from_be_bytes([p[2 * i], p[2 * i + 1]]);
                        if channels < 3 { [at(0); 3] } else { [at(0), at(1), at(2)] }
                    })
                    .collect(),
            ),
            depth => return Err(ClutError::Hald(format!("unsupported bit depth {depth:?}"))),
        };
        Ok(Self::new(size, InputSpace::Srgb, [[0.0; 3], [1.0; 3]], data))
    }

    /// The identity, for tests.
    #[cfg(test)]
    pub(crate) fn identity(size: usize) -> Self {
        Self::from_fn(size, |c| c)
    }

    /// `f` sampled on a `size³` grid over [0, 1], at 16 bits.
    #[cfg(test)]
    pub(crate) fn from_fn(size: usize, f: impl Fn(Rgb) -> Rgb) -> Self {
        let node = |i: usize| i as f32 / (size - 1) as f32;
        let mut data = Vec::with_capacity(size.pow(3));
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    data.push(f([node(r), node(g), node(b)]).map(|v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16));
                }
            }
        }
        Self::new(size, InputSpace::Srgb, [[0.0; 3], [1.0; 3]], Data::U16(data))
    }

    /// One colour, encoded as [`input_space`](Self::input_space) says.
    #[inline]
    pub fn eval(&self, rgb: Rgb, interpolation: Interpolation) -> Rgb {
        match &self.data {
            Data::U8(d) => self.eval_in(d, rgb, interpolation),
            Data::U16(d) => self.eval_in(d, rgb, interpolation),
        }
    }

    /// [`eval`](Self::eval) on many colours, in place.
    pub fn apply_all(&self, pixels: &mut [Rgb], interpolation: Interpolation) {
        match &self.data {
            Data::U8(d) => pixels.iter_mut().for_each(|c| *c = self.eval_in(d, *c, interpolation)),
            Data::U16(d) => pixels.iter_mut().for_each(|c| *c = self.eval_in(d, *c, interpolation)),
        }
    }

    #[inline(always)]
    fn eval_in<T: Sample>(&self, data: &[[T; 3]], rgb: Rgb, interpolation: Interpolation) -> Rgb {
        let n = self.size;
        let last = (n - 1) as f32;
        let lo = self.domain[0];
        // NaN clamps to 0 through `max`.
        let coord: Rgb = std::array::from_fn(|i| ((rgb[i] - lo[i]) * self.scale[i]).max(0.0).min(last));
        let base = coord.map(|c| (c as usize).min(n - 2));
        let [r, g, b]: Rgb = std::array::from_fn(|i| coord[i] - base[i] as f32);
        let origin = base[0] + n * (base[1] + n * base[2]);
        let at = |dr: usize, dg: usize, db: usize| -> Rgb {
            data[origin + dr + n * (dg + n * db)].map(|v| v.value())
        };
        let out = match interpolation {
            Interpolation::Tetrahedral => {
                let (c000, c111) = (at(0, 0, 0), at(1, 1, 1));
                // The tetrahedron containing the point, by the order of its coordinates:
                // walk from c000 to c111 along the edges p1, p2.
                let (p1, p2, t1, t2, t3) = if r >= g {
                    if g >= b {
                        (at(1, 0, 0), at(1, 1, 0), r, g, b)
                    } else if r >= b {
                        (at(1, 0, 0), at(1, 0, 1), r, b, g)
                    } else {
                        (at(0, 0, 1), at(1, 0, 1), b, r, g)
                    }
                } else if b >= g {
                    (at(0, 0, 1), at(0, 1, 1), b, g, r)
                } else if b >= r {
                    (at(0, 1, 0), at(0, 1, 1), g, b, r)
                } else {
                    (at(0, 1, 0), at(1, 1, 0), g, r, b)
                };
                std::array::from_fn(|i| c000[i] + (p1[i] - c000[i]) * t1 + (p2[i] - p1[i]) * t2 + (c111[i] - p2[i]) * t3)
            }
            Interpolation::Trilinear => {
                let lerp = |a: Rgb, b: Rgb, t: f32| -> Rgb { std::array::from_fn(|i| a[i] + (b[i] - a[i]) * t) };
                let c00 = lerp(at(0, 0, 0), at(1, 0, 0), r);
                let c10 = lerp(at(0, 1, 0), at(1, 1, 0), r);
                let c01 = lerp(at(0, 0, 1), at(1, 0, 1), r);
                let c11 = lerp(at(0, 1, 1), at(1, 1, 1), r);
                lerp(lerp(c00, c10, g), lerp(c01, c11, g), b)
            }
            Interpolation::Pyramid => {
                // darktable's `correct_pixel_pyramid`: the pyramid with its apex at c000
                // and its base the face of the cube along the smallest coordinate.
                let (c000, c111) = (at(0, 0, 0), at(1, 1, 1));
                if g > r && b > r {
                    let (c010, c001, c011) = (at(0, 1, 0), at(0, 0, 1), at(0, 1, 1));
                    std::array::from_fn(|i| {
                        c000[i] + (c111[i] - c011[i]) * r + (c010[i] - c000[i]) * g + (c001[i] - c000[i]) * b
                            + (c011[i] - c001[i] - c010[i] + c000[i]) * g * b
                    })
                } else if r > g && b > g {
                    let (c100, c001, c101) = (at(1, 0, 0), at(0, 0, 1), at(1, 0, 1));
                    std::array::from_fn(|i| {
                        c000[i] + (c100[i] - c000[i]) * r + (c111[i] - c101[i]) * g + (c001[i] - c000[i]) * b
                            + (c101[i] - c001[i] - c100[i] + c000[i]) * r * b
                    })
                } else {
                    let (c100, c010, c110) = (at(1, 0, 0), at(0, 1, 0), at(1, 1, 0));
                    std::array::from_fn(|i| {
                        c000[i] + (c100[i] - c000[i]) * r + (c010[i] - c000[i]) * g + (c111[i] - c110[i]) * b
                            + (c110[i] - c100[i] - c010[i] + c000[i]) * r * g
                    })
                }
            }
        };
        out.map(|v| v * T::SCALE)
    }
}

fn check_size(size: usize) -> Result<usize, ClutError> {
    match size {
        0 | 1 => Err(ClutError::Canonical(format!("a grid needs at least 2 nodes per axis, not {size}"))),
        n if n > MAX_SIZE => Err(ClutError::TooLarge(n)),
        n => Ok(n),
    }
}

fn check_domain([lo, hi]: &[Rgb; 2]) -> Result<(), String> {
    let ok = (0..3).all(|i| lo[i].is_finite() && hi[i].is_finite() && hi[i] > lo[i]);
    if ok { Ok(()) } else { Err(format!("invalid domain {lo:?} … {hi:?}")) }
}

/// LUTs loaded in a renderer, by id. Recipes refer to them by id; a LUT that isn't
/// loaded is skipped.
#[derive(Clone, Default)]
pub struct ClutStore {
    luts: std::collections::HashMap<String, std::rc::Rc<Clut>>,
}

impl ClutStore {
    /// Add a LUT (any format [`Clut::parse`] reads); returns its id.
    pub fn load(&mut self, bytes: &[u8]) -> Result<String, ClutError> {
        let clut = Clut::parse(bytes)?;
        let id = clut.id.clone();
        self.insert(clut);
        Ok(id)
    }

    pub fn insert(&mut self, clut: Clut) {
        self.luts.insert(clut.id.clone(), std::rc::Rc::new(clut));
    }

    pub fn get(&self, id: &str) -> Option<&std::rc::Rc<Clut>> {
        self.luts.get(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.luts.contains_key(id)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.luts.remove(id).is_some()
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.luts.keys().map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTERPOLATIONS: [Interpolation; 3] = [Interpolation::Tetrahedral, Interpolation::Trilinear, Interpolation::Pyramid];

    fn close(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
    }

    #[test]
    fn identity_is_exact_with_every_interpolation() {
        let lut = Clut::identity(17);
        for interpolation in INTERPOLATIONS {
            for c in [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.3, 0.7, 0.1], [0.99, 0.01, 0.5], [0.5, 0.5, 0.5]] {
                let out = lut.eval(c, interpolation);
                assert!(close(out, c, 2e-5), "{interpolation:?} {c:?}: {out:?}");
            }
        }
    }

    #[test]
    fn interpolations_are_exact_for_affine_tables() {
        let f = |c: Rgb| [0.2 + 0.5 * c[0] + 0.1 * c[2], 0.8 * c[1], 0.3 * c[0] + 0.3 * c[1] + 0.3 * c[2]];
        let lut = Clut::from_fn(5, f);
        for interpolation in INTERPOLATIONS {
            for c in [[0.13, 0.62, 0.91], [0.9, 0.2, 0.4], [0.5, 0.55, 0.45]] {
                assert!(close(lut.eval(c, interpolation), f(c), 3e-5), "{interpolation:?} {c:?}");
            }
        }
    }

    #[test]
    fn interpolations_agree_on_nodes_and_stay_close_between() {
        let f = |c: Rgb| [c[0] * c[0], (c[1] * 3.0).sin().abs(), (c[0] + c[2]) / 2.0];
        let lut = Clut::from_fn(33, f);
        for c in [[0.25f32, 0.5, 0.75], [0.1, 0.9, 0.3]] {
            let node = c.map(|v| (v * 32.0).round() / 32.0);
            for interpolation in INTERPOLATIONS {
                assert!(close(lut.eval(node, interpolation), f(node), 2e-5));
                assert!(close(lut.eval(c, interpolation), f(c), 2e-3), "{interpolation:?}");
            }
        }
    }

    #[test]
    fn out_of_domain_inputs_clamp() {
        let lut = Clut::identity(3);
        assert_eq!(lut.eval([-1.0, f32::NAN, 2.0], Interpolation::Tetrahedral), [0.0, 0.0, 1.0]);
    }

    fn cube(size: usize, header: &str, f: impl Fn(Rgb) -> Rgb) -> String {
        let mut s = format!("# a comment\nTITLE \"test\"\n{header}LUT_3D_SIZE {size}\n\n");
        let node = |i: usize| i as f32 / (size - 1) as f32;
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    let [x, y, z] = f([node(r), node(g), node(b)]);
                    s += &format!("{x:.6} {y:.6} {z:.6}\n");
                }
            }
        }
        s
    }

    #[test]
    fn reads_cube_files() {
        let swap = |c: Rgb| [c[2], c[1], c[0]];
        let lut = Clut::parse(cube(9, "", swap).as_bytes()).unwrap();
        assert_eq!((lut.size(), lut.bit_depth()), (9, 16));
        assert!(close(lut.eval([0.2, 0.4, 0.9], Interpolation::Tetrahedral), [0.9, 0.4, 0.2], 1e-4));

        // A wider domain: inputs are rescaled to the grid.
        let lut = Clut::parse(cube(3, "DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n", |c| c).as_bytes()).unwrap();
        assert!(close(lut.eval([1.0, 0.5, 2.0], Interpolation::Trilinear), [0.5, 0.25, 1.0], 1e-4));
    }

    #[test]
    fn rejects_bad_cube_files() {
        let missing = cube(3, "", |c| c).replace("1.000000 1.000000 1.000000\n", "");
        assert!(matches!(Clut::parse(missing.as_bytes()), Err(ClutError::Cube { .. })));
        assert!(matches!(Clut::parse(b"LUT_1D_SIZE 16\n"), Err(ClutError::Cube { .. })));
        assert!(matches!(Clut::parse(b"LUT_3D_SIZE 200\n"), Err(ClutError::TooLarge(200))));
        assert!(matches!(Clut::parse(b"0.1 0.2 0.3\n"), Err(ClutError::Cube { line: 1, .. })));
        assert!(matches!(Clut::parse(&[0xff, 0xfe, 0x00]), Err(ClutError::UnknownFormat)));
    }

    fn hald_png(level: usize, sixteen: bool, f: impl Fn(Rgb) -> Rgb) -> Vec<u8> {
        let (side, size) = (level.pow(3), level * level);
        let mut pixels = Vec::new();
        for i in 0..side * side {
            let (r, g, b) = (i % size, (i / size) % size, i / (size * size));
            let c = f([r, g, b].map(|v| v as f32 / (size - 1) as f32));
            for v in c {
                if sixteen {
                    pixels.extend(((v * 65535.0).round() as u16).to_be_bytes());
                } else {
                    pixels.push((v * 255.0).round() as u8);
                }
            }
        }
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, side as u32, side as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(if sixteen { png::BitDepth::Sixteen } else { png::BitDepth::Eight });
        encoder.write_header().unwrap().write_image_data(&pixels).unwrap();
        out
    }

    #[test]
    fn reads_hald_pngs() {
        let invert = |c: Rgb| c.map(|v| 1.0 - v);
        for sixteen in [false, true] {
            let lut = Clut::parse(&hald_png(3, sixteen, invert)).unwrap();
            assert_eq!((lut.size(), lut.bit_depth()), (9, if sixteen { 16 } else { 8 }));
            let tol = if sixteen { 1e-4 } else { 3e-3 };
            assert!(close(lut.eval([0.1, 0.5, 0.8], Interpolation::Tetrahedral), [0.9, 0.5, 0.2], tol));
        }
        let mut not_square = Vec::new();
        let mut encoder = png::Encoder::new(&mut not_square, 8, 4);
        encoder.set_color(png::ColorType::Rgb);
        encoder.write_header().unwrap().write_image_data(&[0; 8 * 4 * 3]).unwrap();
        assert!(matches!(Clut::parse(&not_square), Err(ClutError::Hald(_))));
    }

    #[test]
    fn same_table_same_id_whatever_the_file() {
        let f = |c: Rgb| [c[1], c[2], c[0]];
        let a = Clut::parse(cube(5, "", f).as_bytes()).unwrap();
        let b = Clut::parse(format!("# other comments\r\n{}", cube(5, "", f).replace('\n', "\r\n")).as_bytes()).unwrap();
        assert_eq!(a.id(), b.id());
        assert_eq!(a.id().len(), 64);
        let c = Clut::parse(cube(5, "", |c| c).as_bytes()).unwrap();
        assert_ne!(a.id(), c.id());
    }

    #[test]
    fn canonical_form_round_trips() {
        for lut in [Clut::parse(&hald_png(2, false, |c| c.map(|v| v * v))).unwrap(), Clut::from_fn(4, |c| [c[2], c[0], c[1]])] {
            let bytes = lut.to_canonical();
            assert_eq!(bytes.len(), HEADER_LEN + lut.byte_size());
            let back = Clut::parse(&bytes).unwrap();
            assert_eq!(back.id(), lut.id());
            assert_eq!(back.to_canonical(), bytes);
        }
        let mut truncated = Clut::identity(3).to_canonical();
        truncated.pop();
        assert!(matches!(Clut::parse(&truncated), Err(ClutError::Canonical(_))));
    }

    #[test]
    fn packed_form_round_trips_and_is_small() {
        let smooth = |c: Rgb| [c[0].powf(0.8), (c[1] + c[2]) / 2.0, c[2] * c[2]];
        let luts = [Clut::parse(&hald_png(4, false, smooth)).unwrap(), Clut::parse(&hald_png(3, true, smooth)).unwrap(), Clut::from_fn(33, smooth)];
        for lut in luts {
            let packed = lut.to_packed();
            let back = Clut::parse(&packed).unwrap();
            assert_eq!(back.id(), lut.id());
            assert_eq!(back.to_canonical(), lut.to_canonical());
            assert!(packed.len() * 4 < lut.byte_size(), "{} → {}", lut.byte_size(), packed.len());
        }
        let packed = Clut::identity(5).to_packed();
        assert!(matches!(Clut::parse(&packed[..packed.len() - 4]), Err(ClutError::Canonical(_))));
        // A body that inflates to more than the header says.
        let mut longer = Clut::identity(5).to_packed();
        longer[10] = 4;
        assert!(matches!(Clut::parse(&longer), Err(ClutError::Canonical(_))));
    }

    #[test]
    fn store_skips_reloads_by_id() {
        let mut store = ClutStore::default();
        let id = store.load(&Clut::identity(3).to_canonical()).unwrap();
        assert!(store.contains(&id));
        assert_eq!(store.load(cube(3, "", |c| c).as_bytes()).unwrap().len(), 64);
        assert!(store.remove(&id));
        assert!(!store.contains(&id));
    }
}
