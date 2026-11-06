//! A small little-endian TIFF writer: image file directories (IFDs), which are also
//! what EXIF is made of, and 8/16-bit RGB TIFF files compressed with deflate.

use std::collections::BTreeMap;
use std::io::Write;

use crate::{Error, Result};

/// A tag's value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Byte(Vec<u8>),
    /// Written with its terminating NUL.
    Ascii(String),
    Short(Vec<u16>),
    Long(Vec<u32>),
    Rational(Vec<[u32; 2]>),
    SRational(Vec<[i32; 2]>),
    Undefined(Vec<u8>),
    /// A sub-directory (EXIF, GPS), written as a pointer.
    Ifd(Ifd),
}

impl Value {
    fn type_code(&self) -> u16 {
        match self {
            Value::Byte(_) => 1,
            Value::Ascii(_) => 2,
            Value::Short(_) => 3,
            Value::Long(_) | Value::Ifd(_) => 4,
            Value::Rational(_) => 5,
            Value::Undefined(_) => 7,
            Value::SRational(_) => 10,
        }
    }

    fn count(&self) -> usize {
        match self {
            Value::Byte(v) | Value::Undefined(v) => v.len(),
            Value::Ascii(s) => s.len() + 1,
            Value::Short(v) => v.len(),
            Value::Long(v) => v.len(),
            Value::Rational(v) => v.len(),
            Value::SRational(v) => v.len(),
            Value::Ifd(_) => 1,
        }
    }

    /// The value's bytes, except for sub-directories.
    fn bytes(&self) -> Vec<u8> {
        match self {
            Value::Byte(v) | Value::Undefined(v) => v.clone(),
            Value::Ascii(s) => s.bytes().chain([0]).collect(),
            Value::Short(v) => v.iter().flat_map(|x| x.to_le_bytes()).collect(),
            Value::Long(v) => v.iter().flat_map(|x| x.to_le_bytes()).collect(),
            Value::Rational(v) => v.iter().flatten().flat_map(|x| x.to_le_bytes()).collect(),
            Value::SRational(v) => v.iter().flatten().flat_map(|x| x.to_le_bytes()).collect(),
            Value::Ifd(_) => Vec::new(),
        }
    }
}

/// An image file directory: tags and their values, written in tag order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ifd(BTreeMap<u16, Value>);

impl Ifd {
    pub fn set(&mut self, tag: u16, value: Value) {
        self.0.insert(tag, value);
    }

    /// Sets an ASCII tag if `value` has something in it.
    pub fn set_text(&mut self, tag: u16, value: Option<&str>) {
        if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
            // ASCII only: other characters become '?'.
            self.set(tag, Value::Ascii(v.chars().map(|c| if c.is_ascii() && c != '\0' { c } else { '?' }).collect()));
        }
    }

    pub fn get(&self, tag: u16) -> Option<&Value> {
        self.0.get(&tag)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Little-endian TIFF header pointing at the first IFD, written next.
const HEADER: [u8; 8] = [b'I', b'I', 42, 0, 8, 0, 0, 0];

/// `ifd` as a TIFF structure on its own: the payload of an EXIF block (JPEG APP1
/// after `Exif\0\0`, PNG `eXIf`).
pub fn exif_block(ifd: &Ifd) -> Result<Vec<u8>> {
    let mut out = HEADER.to_vec();
    let at = write_ifd(&mut out, ifd)?;
    debug_assert_eq!(at, 8);
    Ok(out)
}

fn offset(n: usize) -> Result<u32> {
    u32::try_from(n).map_err(|_| Error::Encode("the file is too large for TIFF (4 GB)".into()))
}

/// Appends `ifd` (word-aligned) and what doesn't fit in its entries, sub-directories
/// last; returns its offset. Offsets are from the start of `out`, the TIFF header.
fn write_ifd(out: &mut Vec<u8>, ifd: &Ifd) -> Result<u32> {
    if out.len() % 2 == 1 {
        out.push(0);
    }
    let at = out.len();
    out.resize(at + 2 + 12 * ifd.0.len() + 4, 0);
    let mut entries = Vec::with_capacity(ifd.0.len());
    for (&tag, value) in &ifd.0 {
        let inline = match value {
            Value::Ifd(_) => None,
            v => {
                let bytes = v.bytes();
                if bytes.len() <= 4 {
                    let mut inline = [0u8; 4];
                    inline[..bytes.len()].copy_from_slice(&bytes);
                    Some(inline)
                } else {
                    if out.len() % 2 == 1 {
                        out.push(0);
                    }
                    let o = offset(out.len())?;
                    out.extend_from_slice(&bytes);
                    Some(o.to_le_bytes())
                }
            }
        };
        entries.push((tag, value, inline));
    }
    let mut table = Vec::with_capacity(2 + 12 * entries.len() + 4);
    table.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for (tag, value, inline) in entries {
        let data = match (inline, value) {
            (Some(data), _) => data,
            (None, Value::Ifd(sub)) => write_ifd(out, sub)?.to_le_bytes(),
            (None, _) => unreachable!(),
        };
        table.extend_from_slice(&tag.to_le_bytes());
        table.extend_from_slice(&value.type_code().to_le_bytes());
        table.extend_from_slice(&(value.count() as u32).to_le_bytes());
        table.extend_from_slice(&data);
    }
    table.extend_from_slice(&0u32.to_le_bytes());
    out[at..at + table.len()].copy_from_slice(&table);
    offset(at)
}

// Image tags.
const IMAGE_WIDTH: u16 = 256;
const IMAGE_LENGTH: u16 = 257;
const BITS_PER_SAMPLE: u16 = 258;
const COMPRESSION: u16 = 259;
const PHOTOMETRIC: u16 = 262;
const STRIP_OFFSETS: u16 = 273;
const SAMPLES_PER_PIXEL: u16 = 277;
const ROWS_PER_STRIP: u16 = 278;
const STRIP_BYTE_COUNTS: u16 = 279;
const PLANAR_CONFIGURATION: u16 = 284;
const PREDICTOR: u16 = 317;

/// Adobe deflate (zlib).
const DEFLATE: u16 = 8;
const RGB: u16 = 2;
const HORIZONTAL_DIFFERENCING: u16 = 2;

/// A sample type TIFF and PNG files can hold.
pub trait Sample: Copy + Default {
    const BITS: u16;
    fn quantize(v: f32) -> Self;
    fn wrapping_sub(self, other: Self) -> Self;
    fn write_le(self, out: &mut Vec<u8>);
    fn write_be(self, out: &mut Vec<u8>);
}

impl Sample for u8 {
    const BITS: u16 = 8;
    #[inline]
    fn quantize(v: f32) -> Self {
        (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
    }
    fn wrapping_sub(self, other: Self) -> Self {
        u8::wrapping_sub(self, other)
    }
    fn write_le(self, out: &mut Vec<u8>) {
        out.push(self);
    }
    fn write_be(self, out: &mut Vec<u8>) {
        out.push(self);
    }
}

impl Sample for u16 {
    const BITS: u16 = 16;
    #[inline]
    fn quantize(v: f32) -> Self {
        (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16
    }
    fn wrapping_sub(self, other: Self) -> Self {
        u16::wrapping_sub(self, other)
    }
    fn write_le(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.to_le_bytes());
    }
    fn write_be(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.to_be_bytes());
    }
}

/// An RGB TIFF file of `width × height` pixels (`data`: interleaved samples), with
/// the tags of `ifd` (metadata, ICC profile) added to its first directory.
pub fn encode<T: Sample>(width: usize, height: usize, data: &[T], mut ifd: Ifd) -> Result<Vec<u8>> {
    let row_samples = width * 3;
    let row_bytes = row_samples * usize::from(T::BITS / 8);
    // Strips of about 256 kB, uncompressed.
    let rows_per_strip = (256 * 1024 / row_bytes.max(1)).clamp(1, height.max(1));
    let mut out = HEADER.to_vec();
    let (mut offsets, mut counts) = (Vec::new(), Vec::new());
    let mut raw = Vec::with_capacity(rows_per_strip * row_bytes);
    let mut diff = vec![T::default(); row_samples];
    for strip in data.chunks(rows_per_strip * row_samples) {
        raw.clear();
        for row in strip.chunks(row_samples) {
            // Horizontal differencing, per channel.
            diff[..3].copy_from_slice(&row[..3]);
            for i in 3..row.len() {
                diff[i] = row[i].wrapping_sub(row[i - 3]);
            }
            diff.iter().for_each(|s| s.write_le(&mut raw));
        }
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(&raw).map_err(|e| Error::Encode(e.to_string()))?;
        let compressed = z.finish().map_err(|e| Error::Encode(e.to_string()))?;
        offsets.push(offset(out.len())?);
        counts.push(offset(compressed.len())?);
        out.extend_from_slice(&compressed);
    }
    let size = |n: usize| offset(n);
    ifd.set(IMAGE_WIDTH, Value::Long(vec![size(width)?]));
    ifd.set(IMAGE_LENGTH, Value::Long(vec![size(height)?]));
    ifd.set(BITS_PER_SAMPLE, Value::Short(vec![T::BITS; 3]));
    ifd.set(COMPRESSION, Value::Short(vec![DEFLATE]));
    ifd.set(PHOTOMETRIC, Value::Short(vec![RGB]));
    ifd.set(STRIP_OFFSETS, Value::Long(offsets));
    ifd.set(SAMPLES_PER_PIXEL, Value::Short(vec![3]));
    ifd.set(ROWS_PER_STRIP, Value::Long(vec![size(rows_per_strip)?]));
    ifd.set(STRIP_BYTE_COUNTS, Value::Long(counts));
    ifd.set(PLANAR_CONFIGURATION, Value::Short(vec![1]));
    ifd.set(PREDICTOR, Value::Short(vec![HORIZONTAL_DIFFERENCING]));
    let at = write_ifd(&mut out, &ifd)?;
    out[4..8].copy_from_slice(&at.to_le_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }
    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
    }

    /// Entries of the IFD at `at`: (tag, type, count, value or offset).
    fn entries(b: &[u8], at: usize) -> Vec<(u16, u16, u32, u32)> {
        (0..u16_at(b, at) as usize)
            .map(|i| {
                let e = at + 2 + 12 * i;
                (u16_at(b, e), u16_at(b, e + 2), u32_at(b, e + 4), u32_at(b, e + 8))
            })
            .collect()
    }

    #[test]
    fn writes_sorted_entries_and_sub_directories() {
        let mut exif = Ifd::default();
        exif.set(0x9000, Value::Undefined(b"0232".to_vec()));
        let mut ifd = Ifd::default();
        ifd.set(0x8769, Value::Ifd(exif));
        ifd.set(0x010f, Value::Ascii("Sony".into()));
        ifd.set(0x0112, Value::Short(vec![1]));
        let b = exif_block(&ifd).unwrap();
        assert_eq!(&b[..8], &HEADER);
        let e = entries(&b, 8);
        assert_eq!(e.iter().map(|e| e.0).collect::<Vec<_>>(), [0x010f, 0x0112, 0x8769]);
        // "Sony\0" doesn't fit in the entry: it's stored after the table.
        let (_, ty, count, at) = e[0];
        assert_eq!((ty, count, &b[at as usize..at as usize + 5]), (2, 5, &b"Sony\0"[..]));
        assert_eq!(e[1].3, 1);
        let sub = entries(&b, e[2].3 as usize);
        assert_eq!(sub, [(0x9000, 7, 4, u32::from_le_bytes(*b"0232"))]);
        assert_eq!(e[2].3 % 2, 0);
    }

    #[test]
    fn tiff_round_trips_through_inflate() {
        use std::io::Read;
        let (w, h) = (5, 3);
        let data: Vec<u16> = (0..w * h * 3).map(|i| (i * 4099) as u16).collect();
        let b = encode(w, h, &data, Ifd::default()).unwrap();
        let ifd = entries(&b, u32_at(&b, 4) as usize);
        let get = |tag| ifd.iter().find(|e| e.0 == tag).unwrap().3;
        assert_eq!((get(IMAGE_WIDTH), get(IMAGE_LENGTH), get(COMPRESSION), get(PREDICTOR)), (5, 3, 8, 2));
        // One strip: inflate it and undo the differencing.
        let (at, n) = (get(STRIP_OFFSETS) as usize, get(STRIP_BYTE_COUNTS) as usize);
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(&b[at..at + n]).read_to_end(&mut raw).unwrap();
        let mut samples: Vec<u16> = raw.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        for row in samples.chunks_mut(w * 3) {
            for i in 3..row.len() {
                row[i] = row[i].wrapping_add(row[i - 3]);
            }
        }
        assert_eq!(samples, data);
    }
}
