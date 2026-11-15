//! Metadata written into exports: EXIF (camera, lens, exposure, date, location) and
//! XMP (title, description, rating, label, keywords, creator and rights).

use serde::{Deserialize, Serialize};

use super::tiff::{Ifd, Value};
use crate::metadata::PhotoMetadata;
use crate::output::ColorSpace;

/// What the export knows about the photo: the file's metadata (with the library's
/// corrections) and the version's curation. Mirrored in `packages/pipeline/src/export.ts`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportMetadata {
    pub photo: PhotoMetadata,
    pub title: Option<String>,
    pub description: Option<String>,
    /// 0–5 stars; 0 isn't written.
    pub rating: u8,
    /// Colour label (`red`, `yellow`, `green`, `blue`, `purple`).
    pub label: Option<String>,
    pub tags: Vec<String>,
}

/// Which metadata goes into the file.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetadataMode {
    #[default]
    All,
    /// Everything except GPS.
    NoLocation,
    /// Only the artist and copyright.
    Copyright,
    None,
}

// IFD0
const MAKE: u16 = 0x010f;
const MODEL: u16 = 0x0110;
const ORIENTATION: u16 = 0x0112;
const X_RESOLUTION: u16 = 0x011a;
const Y_RESOLUTION: u16 = 0x011b;
const RESOLUTION_UNIT: u16 = 0x0128;
const SOFTWARE: u16 = 0x0131;
const ARTIST: u16 = 0x013b;
const IMAGE_DESCRIPTION: u16 = 0x010e;
const COPYRIGHT: u16 = 0x8298;
const EXIF_IFD: u16 = 0x8769;
const GPS_IFD: u16 = 0x8825;
/// In TIFF files only (JPEG and PNG have their own places for these).
pub const XMP: u16 = 0x02bc;
pub const ICC_PROFILE: u16 = 0x8773;

// EXIF IFD
const EXPOSURE_TIME: u16 = 0x829a;
const F_NUMBER: u16 = 0x829d;
const EXPOSURE_PROGRAM: u16 = 0x8822;
const ISO: u16 = 0x8827;
const EXIF_VERSION: u16 = 0x9000;
const DATE_TIME_ORIGINAL: u16 = 0x9003;
const DATE_TIME_DIGITIZED: u16 = 0x9004;
const OFFSET_TIME_ORIGINAL: u16 = 0x9011;
const EXPOSURE_BIAS: u16 = 0x9204;
const METERING_MODE: u16 = 0x9207;
const FLASH: u16 = 0x9209;
const FOCAL_LENGTH: u16 = 0x920a;
const COLOR_SPACE: u16 = 0xa001;
const PIXEL_X_DIMENSION: u16 = 0xa002;
const PIXEL_Y_DIMENSION: u16 = 0xa003;
const BODY_SERIAL_NUMBER: u16 = 0xa431;
const LENS_MAKE: u16 = 0xa433;
const LENS_MODEL: u16 = 0xa434;

/// A positive value as a rational: `1/n` for exposure times, else 1/10000ths.
fn rational(v: f64) -> Option<[u32; 2]> {
    if !(v.is_finite() && v > 0.0 && v < 4e5) {
        return None;
    }
    let inverse = 1.0 / v;
    if v < 1.0 && (inverse - inverse.round()).abs() < 1e-3 * inverse {
        return Some([1, inverse.round() as u32]);
    }
    Some(reduce((v * 10_000.0).round() as u64, 10_000))
}

fn reduce(n: u64, d: u64) -> [u32; 2] {
    let gcd = |mut a: u64, mut b: u64| {
        while b != 0 {
            (a, b) = (b, a % b);
        }
        a.max(1)
    };
    let g = gcd(n, d);
    [(n / g) as u32, (d / g) as u32]
}

fn signed_rational(v: f64) -> Option<[i32; 2]> {
    (v.is_finite() && v.abs() < 1e4).then(|| [(v * 100.0).round() as i32, 100])
}

/// `captured_at` (ISO 8601) as EXIF's `YYYY:MM:DD HH:MM:SS`, and its UTC offset.
fn exif_date(iso: &str) -> Option<(String, Option<String>)> {
    let b = iso.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r.clone()).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    if !(digits(0..4) && digits(5..7) && digits(8..10) && digits(11..13) && digits(14..16) && digits(17..19)) {
        return None;
    }
    let date = format!("{}:{}:{} {}", &iso[0..4], &iso[5..7], &iso[8..10], &iso[11..19]);
    // Skip fractional seconds, then an offset: `Z`, `+hh:mm` or `-hh:mm`.
    let rest = iso[19..].trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = match rest {
        "Z" => Some("+00:00".to_string()),
        r if r.len() == 6 && (r.starts_with('+') || r.starts_with('-')) && r.as_bytes()[3] == b':' => Some(r.to_string()),
        _ => None,
    };
    Some((date, offset))
}

/// Degrees as degrees, minutes and seconds.
fn dms(v: f64) -> Value {
    let v = v.abs();
    let degrees = v.floor();
    let minutes = ((v - degrees) * 60.0).floor();
    let seconds = ((v - degrees) * 60.0 - minutes) * 60.0;
    Value::Rational(vec![[degrees as u32, 1], [minutes as u32, 1], [(seconds * 1000.0).round() as u32, 1000]])
}

fn gps(m: &PhotoMetadata) -> Option<Ifd> {
    let (lat, lon) = (m.gps_latitude?, m.gps_longitude?);
    if !(lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0) {
        return None;
    }
    let mut ifd = Ifd::default();
    ifd.set(0, Value::Byte(vec![2, 3, 0, 0]));
    ifd.set(1, Value::Ascii(if lat >= 0.0 { "N" } else { "S" }.into()));
    ifd.set(2, dms(lat));
    ifd.set(3, Value::Ascii(if lon >= 0.0 { "E" } else { "W" }.into()));
    ifd.set(4, dms(lon));
    if let Some(alt) = m.gps_altitude.filter(|a| a.is_finite()) {
        ifd.set(5, Value::Byte(vec![u8::from(alt < 0.0)]));
        if let Some(r) = rational(alt.abs()).or((alt == 0.0).then_some([0, 1])) {
            ifd.set(6, Value::Rational(vec![r]));
        }
    }
    Some(ifd)
}

/// The first directory of an export's EXIF (also the TIFF file's), for an image of
/// `width × height` pixels in `space`. Empty for [`MetadataMode::None`].
pub fn ifd0(meta: &ExportMetadata, mode: MetadataMode, space: ColorSpace, width: usize, height: usize) -> Ifd {
    let m = &meta.photo;
    let mut ifd = Ifd::default();
    if mode == MetadataMode::None {
        return ifd;
    }
    ifd.set_text(ARTIST, m.artist.as_deref());
    ifd.set_text(COPYRIGHT, m.copyright.as_deref());
    if mode == MetadataMode::Copyright {
        return ifd;
    }
    ifd.set_text(MAKE, m.make.as_deref());
    ifd.set_text(MODEL, m.model.as_deref());
    ifd.set_text(IMAGE_DESCRIPTION, meta.description.as_deref());
    // The pixels are already upright.
    ifd.set(ORIENTATION, Value::Short(vec![1]));
    ifd.set(X_RESOLUTION, Value::Rational(vec![[300, 1]]));
    ifd.set(Y_RESOLUTION, Value::Rational(vec![[300, 1]]));
    ifd.set(RESOLUTION_UNIT, Value::Short(vec![2]));
    ifd.set(SOFTWARE, Value::Ascii("RAWtisserie".into()));

    let mut exif = Ifd::default();
    exif.set(EXIF_VERSION, Value::Undefined(b"0232".to_vec()));
    if let Some(r) = m.exposure_time.and_then(rational) {
        exif.set(EXPOSURE_TIME, Value::Rational(vec![r]));
    }
    if let Some(r) = m.f_number.and_then(rational) {
        exif.set(F_NUMBER, Value::Rational(vec![r]));
    }
    if let Some(p) = m.exposure_program {
        exif.set(EXPOSURE_PROGRAM, Value::Short(vec![p]));
    }
    if let Some(iso) = m.iso.filter(|&i| i > 0) {
        exif.set(ISO, Value::Short(vec![iso.min(65535) as u16]));
    }
    if let Some((date, offset)) = m.captured_at.as_deref().and_then(exif_date) {
        exif.set(DATE_TIME_ORIGINAL, Value::Ascii(date.clone()));
        exif.set(DATE_TIME_DIGITIZED, Value::Ascii(date));
        if let Some(offset) = offset {
            exif.set(OFFSET_TIME_ORIGINAL, Value::Ascii(offset));
        }
    }
    if let Some(r) = m.exposure_bias.and_then(signed_rational) {
        exif.set(EXPOSURE_BIAS, Value::SRational(vec![r]));
    }
    if let Some(v) = m.metering_mode {
        exif.set(METERING_MODE, Value::Short(vec![v]));
    }
    if let Some(v) = m.flash {
        exif.set(FLASH, Value::Short(vec![v]));
    }
    if let Some(r) = m.focal_length.and_then(rational) {
        exif.set(FOCAL_LENGTH, Value::Rational(vec![r]));
    }
    // 1 is sRGB; anything else is "uncalibrated" (the ICC profile says what it is).
    exif.set(COLOR_SPACE, Value::Short(vec![if space == ColorSpace::Srgb { 1 } else { 0xffff }]));
    exif.set(PIXEL_X_DIMENSION, Value::Long(vec![width as u32]));
    exif.set(PIXEL_Y_DIMENSION, Value::Long(vec![height as u32]));
    exif.set_text(BODY_SERIAL_NUMBER, m.serial_number.as_deref());
    exif.set_text(LENS_MAKE, m.lens_make.as_deref());
    exif.set_text(LENS_MODEL, m.lens_model.as_deref());
    ifd.set(EXIF_IFD, Value::Ifd(exif));

    if mode == MetadataMode::All {
        if let Some(gps) = gps(m) {
            ifd.set(GPS_IFD, Value::Ifd(gps));
        }
    }
    ifd
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Characters XML 1.0 can't hold.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The XMP packet, or `None` if there is nothing to put in it.
pub fn xmp(meta: &ExportMetadata, mode: MetadataMode) -> Option<String> {
    if mode == MetadataMode::None {
        return None;
    }
    let alt = |name: &str, v: &str| {
        format!("   <{name}><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></{name}>\n", escape(v))
    };
    let mut body = String::new();
    if let Some(artist) = non_empty(&meta.photo.artist) {
        body += &format!("   <dc:creator><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></dc:creator>\n", escape(artist));
    }
    if let Some(copyright) = non_empty(&meta.photo.copyright) {
        body += &alt("dc:rights", copyright);
    }
    if mode != MetadataMode::Copyright {
        if let Some(title) = non_empty(&meta.title) {
            body += &alt("dc:title", title);
        }
        if let Some(description) = non_empty(&meta.description) {
            body += &alt("dc:description", description);
        }
        // Tags are paths, levels separated by `|` (`People|Gwen`): as Lightroom and
        // darktable write them, every level in `dc:subject` and the paths in
        // `lr:hierarchicalSubject`, so other apps read the tree back.
        let tags: Vec<&str> = meta.tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
        let mut levels: Vec<&str> = Vec::new();
        for level in tags.iter().flat_map(|t| t.split('|')).map(str::trim).filter(|l| !l.is_empty()) {
            if !levels.contains(&level) {
                levels.push(level);
            }
        }
        if !levels.is_empty() {
            body += "   <dc:subject><rdf:Bag>";
            for level in levels {
                body += &format!("<rdf:li>{}</rdf:li>", escape(level));
            }
            body += "</rdf:Bag></dc:subject>\n";
        }
        if tags.iter().any(|t| t.contains('|')) {
            body += "   <lr:hierarchicalSubject><rdf:Bag>";
            for t in &tags {
                body += &format!("<rdf:li>{}</rdf:li>", escape(t));
            }
            body += "</rdf:Bag></lr:hierarchicalSubject>\n";
        }
        if (1..=5).contains(&meta.rating) {
            body += &format!("   <xmp:Rating>{}</xmp:Rating>\n", meta.rating);
        }
        if let Some(label) = non_empty(&meta.label) {
            let mut c = label.chars();
            let label: String = c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default();
            body += &format!("   <xmp:Label>{}</xmp:Label>\n", escape(&label));
        }
    }
    if body.is_empty() {
        return None;
    }
    Some(format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
         <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n \
         <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  \
         <rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:lr=\"http://ns.adobe.com/lightroom/1.0/\">\n\
         {body}  </rdf:Description>\n \
         </rdf:RDF>\n\
         </x:xmpmeta>\n\
         <?xpacket end=\"w\"?>"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ExportMetadata {
        ExportMetadata {
            photo: PhotoMetadata {
                make: Some("Sony".into()),
                model: Some("ILCE-7M4".into()),
                exposure_time: Some(1.0 / 250.0),
                f_number: Some(2.8),
                iso: Some(400),
                captured_at: Some("2024-05-01T12:34:56.120+02:00".into()),
                gps_latitude: Some(-33.8568),
                gps_longitude: Some(151.2153),
                artist: Some("Ada".into()),
                copyright: Some("© Ada".into()),
                ..Default::default()
            },
            title: Some("Harbour <night>".into()),
            rating: 4,
            label: Some("red".into()),
            tags: vec!["sydney".into(), " ".into(), "Places|Australia|Sydney".into()],
            ..Default::default()
        }
    }

    #[test]
    fn rationals() {
        assert_eq!(rational(1.0 / 250.0), Some([1, 250]));
        assert_eq!(rational(2.8), Some([14, 5]));
        assert_eq!(rational(30.0), Some([30, 1]));
        assert_eq!(rational(0.0), None);
    }

    #[test]
    fn dates() {
        assert_eq!(
            exif_date("2024-05-01T12:34:56.120+02:00"),
            Some(("2024:05:01 12:34:56".into(), Some("+02:00".into())))
        );
        assert_eq!(exif_date("2024-05-01T12:34:56"), Some(("2024:05:01 12:34:56".into(), None)));
        assert_eq!(exif_date("yesterday"), None);
    }

    #[test]
    fn modes_choose_what_is_written() {
        let meta = sample();
        let sub = |ifd: &Ifd, tag| match ifd.get(tag) {
            Some(Value::Ifd(sub)) => Some(sub.clone()),
            _ => None,
        };
        let all = ifd0(&meta, MetadataMode::All, ColorSpace::DisplayP3, 10, 20);
        let exif = sub(&all, EXIF_IFD).unwrap();
        assert_eq!(exif.get(EXPOSURE_TIME), Some(&Value::Rational(vec![[1, 250]])));
        assert_eq!(exif.get(COLOR_SPACE), Some(&Value::Short(vec![0xffff])));
        assert_eq!(exif.get(OFFSET_TIME_ORIGINAL), Some(&Value::Ascii("+02:00".into())));
        let gps = sub(&all, GPS_IFD).unwrap();
        assert_eq!(gps.get(1), Some(&Value::Ascii("S".into())));
        // Non-ASCII characters can't go in EXIF.
        assert_eq!(all.get(COPYRIGHT), Some(&Value::Ascii("? Ada".into())));

        assert!(sub(&ifd0(&meta, MetadataMode::NoLocation, ColorSpace::Srgb, 1, 1), GPS_IFD).is_none());
        let copyright = ifd0(&meta, MetadataMode::Copyright, ColorSpace::Srgb, 1, 1);
        assert!(copyright.get(ARTIST).is_some() && copyright.get(MAKE).is_none() && copyright.get(EXIF_IFD).is_none());
        assert!(ifd0(&meta, MetadataMode::None, ColorSpace::Srgb, 1, 1).is_empty());
    }

    #[test]
    fn xmp_holds_curation() {
        let meta = sample();
        let x = xmp(&meta, MetadataMode::All).unwrap();
        assert!(x.contains("<xmp:Rating>4</xmp:Rating>"), "{x}");
        assert!(x.contains("<xmp:Label>Red</xmp:Label>"));
        assert!(x.contains("Harbour &lt;night&gt;"));
        // Every level once, then the paths.
        assert!(x.contains("<dc:subject><rdf:Bag><rdf:li>sydney</rdf:li><rdf:li>Places</rdf:li><rdf:li>Australia</rdf:li><rdf:li>Sydney</rdf:li></rdf:Bag>"));
        assert!(x.contains("<lr:hierarchicalSubject><rdf:Bag><rdf:li>sydney</rdf:li><rdf:li>Places|Australia|Sydney</rdf:li></rdf:Bag>"));
        assert!(x.contains("© Ada"));
        let c = xmp(&meta, MetadataMode::Copyright).unwrap();
        assert!(c.contains("Ada") && !c.contains("Rating") && !c.contains("Harbour"));
        assert_eq!(xmp(&meta, MetadataMode::None), None);
        assert_eq!(xmp(&ExportMetadata::default(), MetadataMode::All), None);
    }
}
