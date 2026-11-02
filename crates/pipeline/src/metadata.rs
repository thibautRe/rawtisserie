//! EXIF-ish metadata extraction, flattened into something a photo library can index.

use rawler::RawImage;
use rawler::decoders::RawDecodeParams;
use rawler::exif::Exif;
use rawler::formats::tiff::{Rational, SRational};
use rawler::rawsource::RawSource;
use serde::{Deserialize, Serialize};

use crate::lens::LensProfile;
use crate::{Error, Result};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoMetadata {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens_make: Option<String>,
    pub lens_model: Option<String>,
    pub iso: Option<u32>,
    /// Seconds.
    pub exposure_time: Option<f64>,
    pub f_number: Option<f64>,
    /// Millimetres.
    pub focal_length: Option<f64>,
    /// EV.
    pub exposure_bias: Option<f64>,
    /// ISO 8601 local date-time, with offset when the camera recorded one.
    pub captured_at: Option<String>,
    /// Pixel dimensions of the developed image, after orientation.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// EXIF orientation (1…8).
    pub orientation: Option<u16>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
    pub serial_number: Option<String>,
    pub rating: Option<u32>,
    pub flash: Option<u16>,
    pub metering_mode: Option<u16>,
    pub exposure_program: Option<u16>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    pub gps_altitude: Option<f64>,
    /// Where the lens correction data embedded in the file comes from (`"sony"`), if
    /// it has any. See [`crate::lens`].
    pub lens_correction: Option<String>,
    /// CIE 1931 xy chromaticity of the light the camera's white balance was set for
    /// (colour calibration's "as shot" illuminant), if the file has colour.
    pub as_shot_illuminant: Option<[f64; 2]>,
}

/// Read metadata without decoding (decompressing) the sensor data.
pub fn read(bytes: &[u8]) -> Result<PhotoMetadata> {
    let source = RawSource::new_from_slice(bytes);
    let raw = rawler::decode_dummy(&source).map_err(|e| Error::Decode(e.to_string()))?;
    Ok(extract_with_lens(&source, &raw).0)
}

pub(crate) fn extract(source: &RawSource, raw: &RawImage) -> PhotoMetadata {
    let mut meta = PhotoMetadata {
        make: non_empty(&raw.clean_make),
        model: non_empty(&raw.clean_model),
        ..Default::default()
    };

    let area = raw.crop_area.or(raw.active_area);
    let (w, h) = area.map(|r| (r.d.w, r.d.h)).unwrap_or((raw.width, raw.height));
    let orientation = raw.orientation.to_u16();
    let swap = matches!(orientation, 5..=8);
    if w > 0 && h > 0 {
        meta.width = Some(if swap { h } else { w } as u32);
        meta.height = Some(if swap { w } else { h } as u32);
    }
    if (1..=8).contains(&orientation) {
        meta.orientation = Some(orientation);
    }

    let raw_meta = rawler::get_decoder(source).and_then(|d| d.raw_metadata(source, &RawDecodeParams::default()));
    if let Ok(rm) = raw_meta {
        apply_exif(&mut meta, &rm.exif);
        meta.rating = rm.rating;
        if let Some(lens) = rm.lens {
            meta.lens_make = meta.lens_make.or_else(|| non_empty(&lens.lens_make));
            // Prefer the decoder's lens database name over the raw EXIF string.
            meta.lens_model = non_empty(&lens.lens_model).or(meta.lens_model);
        }
        meta.make = meta.make.or_else(|| non_empty(&rm.make));
        meta.model = meta.model.or_else(|| non_empty(&rm.model));
    }
    let round = |v: f32| (v as f64 * 1e6).round() / 1e6;
    meta.as_shot_illuminant = crate::decode::as_shot_illuminant(raw).map(|xy| xy.map(round));
    meta
}

/// [`extract`], plus the lens correction data embedded in the file.
pub(crate) fn extract_with_lens(source: &RawSource, raw: &RawImage) -> (PhotoMetadata, Option<LensProfile>) {
    let mut meta = extract(source, raw);
    let profile = meta.make.as_deref().and_then(|make| LensProfile::embedded(source.buf(), make));
    meta.lens_correction = profile.as_ref().map(|p| p.source.name().to_string());
    (meta, profile)
}

fn apply_exif(meta: &mut PhotoMetadata, exif: &Exif) {
    meta.iso = exif
        .iso_speed_ratings
        .map(u32::from)
        .or(exif.iso_speed)
        .or(exif.recommended_exposure_index)
        .filter(|v| *v > 0);
    meta.exposure_time = exif.exposure_time.and_then(rational);
    meta.f_number = exif.fnumber.and_then(rational);
    meta.focal_length = exif.focal_length.and_then(rational);
    meta.exposure_bias = exif.exposure_bias.and_then(srational);
    meta.lens_make = exif.lens_make.as_deref().and_then(non_empty);
    meta.lens_model = exif.lens_model.as_deref().and_then(non_empty);
    meta.artist = exif.artist.as_deref().and_then(non_empty);
    meta.copyright = exif.copyright.as_deref().and_then(non_empty);
    meta.serial_number = exif.serial_number.as_deref().and_then(non_empty);
    meta.flash = exif.flash;
    meta.metering_mode = exif.metering_mode;
    meta.exposure_program = exif.exposure_program;
    if meta.orientation.is_none() {
        meta.orientation = exif.orientation.filter(|o| (1..=8).contains(o));
    }

    let date = exif.date_time_original.as_deref().or(exif.create_date.as_deref());
    meta.captured_at = date.and_then(|d| {
        exif_datetime_to_iso(
            d,
            exif.sub_sec_time_original.as_deref(),
            exif.offset_time_original.as_deref().or(exif.offset_time.as_deref()),
        )
    });

    if let Some(gps) = &exif.gps {
        let coord = |v: Option<[Rational; 3]>, r: Option<&str>, neg: &str| {
            let [d, m, s] = v?;
            let deg = rational(d)? + rational(m)? / 60.0 + rational(s)? / 3600.0;
            Some(if r.is_some_and(|r| r.trim().eq_ignore_ascii_case(neg)) { -deg } else { deg })
        };
        meta.gps_latitude = coord(gps.gps_latitude, gps.gps_latitude_ref.as_deref(), "S");
        meta.gps_longitude = coord(gps.gps_longitude, gps.gps_longitude_ref.as_deref(), "W");
        meta.gps_altitude = gps
            .gps_altitude
            .and_then(rational)
            .map(|a| if gps.gps_altitude_ref == Some(1) { -a } else { a });
    }
}

/// `"2026:09:29 14:03:12"` (+ sub-seconds, + `"+02:00"`) → `"2026-09-29T14:03:12.123+02:00"`.
fn exif_datetime_to_iso(date: &str, subsec: Option<&str>, offset: Option<&str>) -> Option<String> {
    let date = date.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    let (d, t) = date.split_once(' ')?;
    let d: Vec<&str> = d.split(':').collect();
    let t: Vec<&str> = t.split(':').collect();
    if d.len() != 3 || t.len() != 3 || d.iter().chain(t.iter()).any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    if d[0] == "0000" {
        return None;
    }
    let mut out = format!("{}-{}-{}T{}:{}:{}", d[0], d[1], d[2], t[0], t[1], t[2]);
    if let Some(sub) = subsec.map(str::trim).filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) {
        out.push('.');
        out.push_str(sub);
    }
    if let Some(off) = offset.map(|s| s.trim_matches(|c: char| c == '\0' || c.is_whitespace())) {
        let b = off.as_bytes();
        if b.len() == 6 && (b[0] == b'+' || b[0] == b'-') && b[3] == b':' {
            out.push_str(off);
        }
    }
    Some(out)
}

fn rational(r: Rational) -> Option<f64> {
    (r.d != 0).then(|| r.n as f64 / r.d as f64)
}

fn srational(r: SRational) -> Option<f64> {
    (r.d != 0).then(|| r.n as f64 / r.d as f64)
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!s.is_empty()).then(|| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_dates() {
        assert_eq!(
            exif_datetime_to_iso("2026:09:29 14:03:12", Some("123"), Some("+02:00")).as_deref(),
            Some("2026-09-29T14:03:12.123+02:00")
        );
        assert_eq!(exif_datetime_to_iso("2026:09:29 14:03:12\0", None, None).as_deref(), Some("2026-09-29T14:03:12"));
        assert_eq!(exif_datetime_to_iso("0000:00:00 00:00:00", None, None), None);
        assert_eq!(exif_datetime_to_iso("garbage", None, None), None);
    }
}
