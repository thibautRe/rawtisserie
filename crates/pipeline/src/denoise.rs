//! Raw denoise (AI), roadmap 3.5: a port of Ansel's `src/iop/rawdenoiseai.c`
//! (GPL-3.0-or-later) at upstream `248dcec22` (2026-11-17), around the executor in
//! [`crate::nn`].
//!
//! The network subtracts estimated noise from the sensor's mosaic, before demosaicing,
//! conditioned on a σ map: σ = √(a·y + b) from the camera's noise profile at the
//! photo's ISO (darktable/Ansel's database, `data/noiseprofiles.bin`, built by
//! `scripts/noise-profiles.mjs`), on normalised, unclamped samples before white
//! balance, scaled by the module's corrections. A multiscale model first denoises the
//! superpixel-binned image with a coarse net, whose output guides the fine net, then
//! anchors the result's low band to the measurement ([`anchor_low_band`]).
//!
//! Deviations from upstream:
//! - Tiles are on a fixed grid ([`TILE`] photosites, plus a margin of 96 or 192 on
//!   each side as upstream's overlap), whatever the machine, so a photo always denoises
//!   to the same values; upstream's tiling depends on free memory, and its untiled
//!   render differs slightly from its tiled ones. Beyond the image, samples are mirrored
//!   (upstream mirrors at the tile's edges, which are the image's for a border tile).
//! - The result is kept at full strength ([`denoise_tile`]); strength is applied when
//!   it's used ([`blend`]), so changing it doesn't run the network again.

use rawler::CFA;

use crate::decode::{Layout, RawPhoto};
use crate::image::Region;
use crate::nn::{self, Model, FUSION_COARSEST, FUSION_FINEST};

/// Side of the grid's tiles, in photosites: a multiple of every model's alignment
/// (192 for the multiscale ones). Each is denoised with a margin on every side
/// ([`margin`]); 768 keeps a half model's scratch near 300 MB per worker.
pub const TILE: usize = 768;

/// Upstream's defaults: strength 0.85, no global correction, and the per-channel
/// corrections that carry the profiles' calibration (×2 for the profile fit's Haar
/// normalisation, times the demosaic attenuation the profiles were measured through).
pub const DEFAULT_STRENGTH: f32 = 0.85;
pub const DEFAULT_CORRECTIONS: [f32; 3] = [2.82, 3.94, 2.96];

/// What scales the σ map: `noise_level` (the global correction) times the per-channel
/// `corrections`, and nothing else (upstream's rule: a model file's own calibration is
/// ignored).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Conditioning {
    pub noise_level: f32,
    pub corrections: [f32; 3],
}

impl Conditioning {
    fn scale(&self) -> [f32; 3] {
        self.corrections.map(|c| c * self.noise_level)
    }
}

impl Default for Conditioning {
    fn default() -> Self {
        Self { noise_level: 1.0, corrections: DEFAULT_CORRECTIONS }
    }
}

/// A camera's noise at one ISO: variance `a·x + b` per CFA colour, in normalised units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseProfile {
    pub a: [f32; 3],
    pub b: [f32; 3],
    /// Whether it's the camera's own profile rather than the generic fallback.
    pub matched: bool,
}

/// Upstream's fallback for cameras without a profile ("generic poissonian").
pub const GENERIC_PROFILE: NoiseProfile = NoiseProfile { a: [1e-4; 3], b: [0.0; 3], matched: false };

static PROFILES: &[u8] = include_bytes!("../data/noiseprofiles.bin");

/// Cameras the database knows under another model name (the same sensor): darktable
/// gets these from rawspeed's camera aliases, which rawler's names don't follow.
const ALIASES: &[(&str, &str, &str)] = &[("Sony", "ILCE-7RM3A", "ILCE-7RM3"), ("Sony", "ILCE-7RM4A", "ILCE-7RM4")];

/// The profile for a camera at an ISO, as upstream picks it: the database's maker must
/// be part of the photo's (`make` "Fujifilm Corporation" matches "Fujifilm") and its
/// model equal; between two profiled ISOs it's interpolated, outside them clamped.
pub fn noise_profile(make: Option<&str>, model: Option<&str>, iso: Option<u32>) -> NoiseProfile {
    let (Some(make), Some(model)) = (make, model) else { return GENERIC_PROFILE };
    let model = ALIASES.iter().find(|(m, from, _)| make.contains(m) && *from == model).map_or(model, |(_, _, to)| to);
    let Some(profiles) = find_profiles(make, model) else { return GENERIC_PROFILE };
    let iso = iso.unwrap_or(0) as f32;
    let at = |i: usize| {
        let v: [f32; 7] = std::array::from_fn(|j| f32::from_le_bytes(profiles[i * 28 + j * 4..][..4].try_into().unwrap()));
        (v[0], NoiseProfile { a: [v[1], v[2], v[3]], b: [v[4], v[5], v[6]], matched: true })
    };
    let n = profiles.len() / 28;
    let (first_iso, first) = at(0);
    if iso <= first_iso {
        return first;
    }
    for i in 1..n {
        let (lo_iso, lo) = at(i - 1);
        let (hi_iso, hi) = at(i);
        if iso == hi_iso {
            return hi;
        }
        if iso < hi_iso {
            let t = ((iso - lo_iso) / (hi_iso - lo_iso)).clamp(0.0, 1.0);
            let mix = |l: [f32; 3], h: [f32; 3]| std::array::from_fn(|k| (1.0 - t) * l[k] + t * h[k]);
            return NoiseProfile { a: mix(lo.a, hi.a), b: mix(lo.b, hi.b), matched: true };
        }
    }
    at(n - 1).1
}

/// The packed profiles (28 bytes each) of a camera in `PROFILES`.
fn find_profiles(make: &str, model: &str) -> Option<&'static [u8]> {
    let data = PROFILES.strip_prefix(b"RTNP1\0")?;
    let count = u32::from_le_bytes(data.get(..4)?.try_into().ok()?);
    let mut at = 4;
    let text = |at: &mut usize| -> Option<&'static str> {
        let len = *data.get(*at)? as usize;
        let s = std::str::from_utf8(data.get(*at + 1..*at + 1 + len)?).ok()?;
        *at += 1 + len;
        Some(s)
    };
    for _ in 0..count {
        let db_make = text(&mut at)?;
        let db_model = text(&mut at)?;
        let n = u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?) as usize;
        let profiles = data.get(at + 2..at + 2 + n * 28)?;
        at += 2 + n * 28;
        if make.contains(db_make) && model == db_model && n > 0 {
            return Some(profiles);
        }
    }
    None
}

/// Margin denoised around each tile and dropped: the network's effective reach, as
/// upstream measured it on seams (96 for the fine net alone, 192 with the coarse one).
pub fn margin(model: &Model) -> usize {
    if model.bin(false) > 1 { 192 } else { 96 }
}

/// The grid's tiles covering a `width × height` sensor, clipped to it, row by row.
pub fn tiles(width: usize, height: usize) -> Vec<Region> {
    let mut out = Vec::new();
    for y in (0..height).step_by(TILE) {
        for x in (0..width).step_by(TILE) {
            out.push(Region { x, y, width: TILE.min(width - x), height: TILE.min(height - y) });
        }
    }
    out
}

/// The grid's tiles that `region` (of the sensor) touches.
pub fn tiles_in(width: usize, height: usize, region: Region) -> Vec<Region> {
    tiles(width, height).into_iter().filter(|t| t.x < region.right() && region.x < t.right() && t.y < region.bottom() && region.y < t.bottom()).collect()
}

/// Mirrors `v` into `[0, n)` without repeating the edge (upstream's `_reflect`).
fn reflect(mut v: isize, n: usize) -> usize {
    let n = n as isize;
    if n == 1 {
        return 0;
    }
    while v < 0 || v >= n {
        if v < 0 {
            v = -v;
        }
        if v >= n {
            v = 2 * n - 2 - v;
        }
    }
    v as usize
}

/// What denoising reads from a photo: its mosaic, unclamped, and the CFA.
struct Sensor<'a> {
    photo: &'a RawPhoto,
    cfa: &'a CFA,
}

impl Sensor<'_> {
    fn color(&self, x: usize, y: usize) -> usize {
        self.photo.color_at(self.cfa, x, y)
    }
}

/// Whether `photo` can be denoised: a RAW file with a Bayer or X-Trans mosaic.
pub fn supported(photo: &RawPhoto) -> bool {
    matches!(&photo.layout, Layout::Mosaic(cfa) if !photo.is_bitmap() && matches!(cfa.width, 2 | 6) && cfa.width == cfa.height)
}

fn is_xtrans(cfa: &CFA) -> bool {
    cfa.width == 6
}

/// One tile of the grid to denoise: the network's first five input planes over the
/// tile and its margin (`size × size`), and what the rest needs. Built where the photo
/// is ([`tile_input`]), run where the model is ([`run_tile`]).
#[derive(Clone, Debug)]
pub struct TileInput {
    /// The tile, in the sensor's usable area.
    pub core: Region,
    pub size: usize,
    /// Mosaic, R, G, B one-hot and σ planes, `size × size` each.
    pub planes: Vec<f32>,
    pub xtrans: bool,
    pub profile: NoiseProfile,
    /// The σ map's scale per colour ([`Conditioning`]).
    pub scale: [f32; 3],
}

/// The input of one tile of the grid (`core`, from [`tiles`]) for a model with this
/// `margin` ([`margin`]). `None` if the photo can't be denoised.
pub fn tile_input(photo: &RawPhoto, profile: &NoiseProfile, conditioning: &Conditioning, margin: usize, core: Region) -> Option<TileInput> {
    let Layout::Mosaic(cfa) = &photo.layout else { return None };
    if !supported(photo) {
        return None;
    }
    let size = TILE + 2 * margin;
    let scale = conditioning.scale();
    let mut planes = vec![0.0f32; 5 * size * size];
    let sensor = Sensor { photo, cfa };
    assemble(&sensor, profile, scale, core.x as isize - margin as isize, core.y as isize - margin as isize, size, &mut planes);
    Some(TileInput { core, size, planes, xtrans: is_xtrans(cfa), profile: *profile, scale })
}

/// Denoises a tile at full strength: its photosites, row by row, normalised and
/// unclamped. `None` if `input` wasn't made for this model's margin.
pub fn run_tile(model: &Model, input: TileInput) -> Option<Vec<f32>> {
    let TileInput { core, size: n, planes: first, xtrans, profile, scale } = input;
    let m = margin(model);
    if n != TILE + 2 * m || n % model.alignment() != 0 || first.len() != 5 * n * n {
        return None;
    }
    let plane = n * n;
    let mut planes = first;
    planes.resize(model.in_channels() * plane, 0.0);
    let bin = model.bin(xtrans);
    if bin > 1 {
        let guide = coarse_guide(model, &planes, n, bin, &profile, scale)?;
        planes[5 * plane..8 * plane].copy_from_slice(&guide);
    }
    let head = model.forward(false, &planes, n, n, false)?;
    let mut denoised: Vec<f32> = planes[..plane].iter().zip(&head).map(|(i, h)| i - h).collect();
    drop(head);
    if model.anchor() > 0 {
        anchor_low_band(&planes, &mut denoised, n);
    }
    let mut out = Vec::with_capacity(core.width * core.height);
    for y in 0..core.height {
        out.extend_from_slice(&denoised[(y + m) * n + m..][..core.width]);
    }
    Some(out)
}

/// [`tile_input`] then [`run_tile`].
pub fn denoise_tile(model: &Model, photo: &RawPhoto, profile: &NoiseProfile, conditioning: &Conditioning, core: Region) -> Option<Vec<f32>> {
    run_tile(model, tile_input(photo, profile, conditioning, margin(model), core)?)
}

/// The fine net's first five planes for the `n × n` window at (`x0`, `y0`): mosaic, R,
/// G, B one-hot and σ (upstream's `_k_assemble`), mirrored beyond the sensor. The CFA
/// colour is the mirrored source photosite's.
fn assemble(sensor: &Sensor, profile: &NoiseProfile, scale: [f32; 3], x0: isize, y0: isize, n: usize, planes: &mut [f32]) {
    let plane = n * n;
    let (w, h) = (sensor.photo.width, sensor.photo.height);
    for y in 0..n {
        let sy = reflect(y0 + y as isize, h);
        for x in 0..n {
            let sx = reflect(x0 + x as isize, w);
            let v = sensor.photo.sample_unclamped(sx, sy, 0);
            let c = sensor.color(sx, sy);
            let i = y * n + x;
            planes[i] = v;
            planes[(1 + c) * plane + i] = 1.0;
            let var = profile.a[c] * v.max(0.0) + profile.b[c];
            planes[4 * plane + i] = scale[c] * var.max(1e-12).sqrt();
        }
    }
}

/// The coarse stage: bins the mosaic into superpixels, denoises them, and returns them
/// nearest-upsampled as the fine net's guide planes (R, G, B).
fn coarse_guide(model: &Model, planes: &[f32], n: usize, bin: usize, profile: &NoiseProfile, scale: [f32; 3]) -> Option<Vec<f32>> {
    let cn = n / bin;
    let cplane = cn * cn;
    let mut input = vec![0.0f32; 6 * cplane];
    let mut count = vec![0.0f32; 3 * cplane];
    nn::bin_planes(planes, n, n, bin, &mut input[..3 * cplane], &mut count);
    // σ of a mean of `count` photosites.
    for c in 0..3 {
        for i in 0..cplane {
            let mean = input[c * cplane + i];
            let var = (profile.a[c] * mean.max(0.0) + profile.b[c]) / count[c * cplane + i].max(1.0);
            input[(3 + c) * cplane + i] = scale[c] * var.max(1e-12).sqrt();
        }
    }
    let head = model.forward(true, &input, cn, cn, false)?;
    let rgb: Vec<f32> = input[..3 * cplane].iter().zip(&head).map(|(i, h)| i - h).collect();
    let mut guide = vec![0.0f32; 3 * n * n];
    nn::upsample_nearest(&rgb, 3, cn, cn, bin, &mut guide);
    Some(guide)
}

/// Fraction of a block's photosites of each colour (Bayer's, for X-Trans too, as the
/// training reference does).
const DENSITY: [f64; 3] = [0.25, 0.5, 0.25];
/// χ² guard: a 3×3 neighbourhood's mean squared noise fluctuates up to ~2× its
/// expectation.
const T_CHI2: f64 = 2.5;

/// Upstream's `_apply_low_band_anchor` (training: `cfa.fuse_low_bands`): per colour,
/// block means of the mosaic (M), the denoised plane (D) and σ² (V) at 16, 32 and 64
/// photosites, fused coarse to fine (the measurement owns the coarsest band where it's
/// flat, Wiener gains on the finer ones), and the difference with D at 16 added back,
/// bilinearly, to the denoised plane.
fn anchor_low_band(planes: &[f32], denoised: &mut [f32], n: usize) {
    if n % FUSION_COARSEST != 0 {
        return;
    }
    let (cw0, ch0) = (n / FUSION_FINEST, n / FUSION_FINEST);
    let p0 = cw0 * ch0;
    let levels = {
        let mut l = 1;
        let mut s = FUSION_FINEST;
        while s < FUSION_COARSEST {
            s *= 2;
            l += 1;
        }
        l
    };
    // Per level: M, D, V, 3 planes of p0 each.
    let mut lv: Vec<[Vec<f32>; 3]> = (0..levels).map(|_| std::array::from_fn(|_| vec![0.0f32; 3 * p0])).collect();
    bin16(planes, denoised, &mut lv[0], n, p0);
    let (mut w, mut h) = (cw0, ch0);
    for k in 1..levels {
        let (lo, hi) = lv.split_at_mut(k);
        for md in 0..3 {
            avg2x2(&lo[k - 1][md], &mut hi[0][md], w, h, p0);
        }
        w /= 2;
        h /= 2;
    }
    let mut fused_a = vec![0.0f32; 3 * p0];
    let mut fused_b = vec![0.0f32; 3 * p0];
    let mut ups = vec![0.0f32; 2 * p0];
    let top = &lv[levels - 1];
    floor_fuse(&top[0], &top[1], &top[2], &mut fused_a, w, h, p0, FUSION_FINEST << (levels - 1));
    for k in (0..levels - 1).rev() {
        let [mf, df, vf] = &lv[k];
        let [mc, dc, _] = &lv[k + 1];
        fuse_step(&fused_a, mf, df, vf, mc, dc, &mut fused_b, &mut ups, w, h, p0, FUSION_FINEST << k);
        std::mem::swap(&mut fused_a, &mut fused_b);
        w *= 2;
        h *= 2;
    }
    bilerp_add(&fused_a, &lv[0][1], &mut fused_b, planes, denoised, n, p0, cw0, ch0);
}

/// Count-weighted means of the mosaic, the denoised plane and σ² per colour over 16×16
/// blocks (`_k_bin16_mdv`).
fn bin16(planes: &[f32], denoised: &[f32], out: &mut [Vec<f32>; 3], n: usize, p0: usize) {
    let plane = n * n;
    let sigma = &planes[4 * plane..5 * plane];
    let cw = n / FUSION_FINEST;
    let [m, d, v] = out;
    for c in 0..3 {
        let onehot = &planes[(1 + c) * plane..(2 + c) * plane];
        for cy in 0..n / FUSION_FINEST {
            for cx in 0..cw {
                let (mut sm, mut sd, mut sv, mut cnt) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
                for y in cy * FUSION_FINEST..(cy + 1) * FUSION_FINEST {
                    for x in cx * FUSION_FINEST..(cx + 1) * FUSION_FINEST {
                        let i = y * n + x;
                        sm += planes[i] * onehot[i];
                        sd += denoised[i] * onehot[i];
                        sv += sigma[i] * sigma[i] * onehot[i];
                        cnt += onehot[i];
                    }
                }
                let cnt = cnt.max(1.0);
                let o = c * p0 + cy * cw + cx;
                m[o] = sm / cnt;
                d[o] = sd / cnt;
                v[o] = sv / cnt;
            }
        }
    }
}

/// 2×2 average pooling of a 3-plane grid (`_k_avg2x2`).
fn avg2x2(input: &[f32], out: &mut [f32], sw: usize, sh: usize, p0: usize) {
    let (w2, h2) = (sw / 2, sh / 2);
    for c in 0..3 {
        let src = &input[c * p0..];
        let dst = &mut out[c * p0..];
        for y in 0..h2 {
            for x in 0..w2 {
                dst[y * w2 + x] = 0.25 * (src[2 * y * sw + 2 * x] + src[2 * y * sw + 2 * x + 1] + src[(2 * y + 1) * sw + 2 * x] + src[(2 * y + 1) * sw + 2 * x + 1]);
            }
        }
    }
}

/// Bilinear sample of `p` (`w × h`) at (`fx`, `fy`), clamped at the edges.
#[inline]
fn bilerp_tap(p: &[f32], w: usize, h: usize, fx: f32, fy: f32) -> f32 {
    let cx = fx.clamp(0.0, w as f32 - 1.0);
    let cy = fy.clamp(0.0, h as f32 - 1.0);
    let (x0, y0) = (cx as usize, cy as usize);
    let x1 = if x0 + 1 < w { x0 + 1 } else { x0 };
    let y1 = if y0 + 1 < h { y0 + 1 } else { y0 };
    let (ax, ay) = (cx - x0 as f32, cy - y0 as f32);
    let top = p[y0 * w + x0] * (1.0 - ax) + p[y0 * w + x1] * ax;
    let bot = p[y1 * w + x0] * (1.0 - ax) + p[y1 * w + x1] * ax;
    top * (1.0 - ay) + bot * ay
}

/// `dst` (`sw·f × sh·f`) = `src` upsampled bilinearly (align_corners = false).
fn upsample_bilinear(src: &[f32], sw: usize, sh: usize, f: usize, dst: &mut [f32]) {
    let (fw, fh) = (sw * f, sh * f);
    for y in 0..fh {
        let sy = (y as f32 + 0.5) / f as f32 - 0.5;
        for x in 0..fw {
            dst[y * fw + x] = bilerp_tap(src, sw, sh, (x as f32 + 0.5) / f as f32 - 0.5, sy);
        }
    }
}

/// The coarsest band (`_k_floor_fuse`): the measurement where its own local structure
/// is noise-sized, the model where there's structure.
#[allow(clippy::too_many_arguments)]
fn floor_fuse(m: &[f32], d: &[f32], v: &[f32], fused: &mut [f32], sw: usize, sh: usize, p0: usize, s: usize) {
    let clampi = |v: isize, n: usize| v.clamp(0, n as isize - 1) as usize;
    for c in 0..3 {
        let vscale = 1.0 / (DENSITY[c] * (s * s) as f64);
        let (mp, dp, vp) = (&m[c * p0..], &d[c * p0..], &v[c * p0..]);
        for y in 0..sh {
            for x in 0..sw {
                // structure = blur3((M − blur3(M))²): blind to smooth gradients.
                let mut structure = 0.0f64;
                for ny in -1..=1isize {
                    for nx in -1..=1isize {
                        let cy2 = clampi(y as isize + ny, sh);
                        let cx2 = clampi(x as isize + nx, sw);
                        let mut mean = 0.0f64;
                        for dy in -1..=1isize {
                            for dx in -1..=1isize {
                                mean += mp[clampi(cy2 as isize + dy, sh) * sw + clampi(cx2 as isize + dx, sw)] as f64;
                            }
                        }
                        let mloc = mp[cy2 * sw + cx2] as f64 - mean / 9.0;
                        structure += mloc * mloc;
                    }
                }
                let i = y * sw + x;
                let vn = vp[i] as f64 * vscale;
                let structure = (structure / 9.0 - T_CHI2 * vn).max(0.0);
                let w = (structure / (structure + vn + 1e-20)) as f32;
                fused[c * p0 + i] = w * dp[i] + (1.0 - w) * mp[i];
            }
        }
    }
}

/// One finer band (`_k_fuse_step`): the running fusion upsampled, plus the band's
/// detail, weighted per cell by a Wiener gain on the model/measurement discrepancy.
#[allow(clippy::too_many_arguments)]
fn fuse_step(fused_c: &[f32], mf: &[f32], df: &[f32], vf: &[f32], mc: &[f32], dc: &[f32], fused_f: &mut [f32], ups: &mut [f32], sw: usize, sh: usize, p0: usize, sc: usize) {
    let (fw, fh) = (sw * 2, sh * 2);
    let clampi = |v: isize, n: usize| v.clamp(0, n as isize - 1) as usize;
    for c in 0..3 {
        let (dfp, mfp, vfp) = (&df[c * p0..], &mf[c * p0..], &vf[c * p0..]);
        let (up_d, up_m) = ups.split_at_mut(p0);
        upsample_bilinear(&dc[c * p0..], sw, sh, 2, up_d);
        upsample_bilinear(&mc[c * p0..], sw, sh, 2, up_m);
        // Var(mean_s − up(mean_2s)) = ¾·Var(mean_s), folded in as this difference.
        let vscale = 1.0 / (DENSITY[c] * (sc * sc) as f64) - 1.0 / (DENSITY[c] * 4.0 * (sc * sc) as f64);
        let fs = &mut fused_f[c * p0..];
        upsample_bilinear(&fused_c[c * p0..], sw, sh, 2, fs);
        for y in 0..fh {
            for x in 0..fw {
                let mut acc = 0.0f64;
                let mut n = 0;
                for dy in -1..=1isize {
                    for dx in -1..=1isize {
                        let j = clampi(y as isize + dy, fh) * fw + clampi(x as isize + dx, fw);
                        let d = (dfp[j] - up_d[j]) as f64 - (mfp[j] - up_m[j]) as f64;
                        acc += d * d;
                        n += 1;
                    }
                }
                let i = y * fw + x;
                let vn = vfp[i] as f64 * vscale;
                let vm = (acc / n as f64 - T_CHI2 * vn).max(0.0);
                let w = (vn / (vn + vm + 1e-20)) as f32;
                fs[i] += w * (dfp[i] - up_d[i]) + (1.0 - w) * (mfp[i] - up_m[i]);
            }
        }
    }
}

/// Adds `fused − D16`, upsampled bilinearly from the 16-photosite grid, to each
/// photosite of the denoised plane, from its colour's plane (`_k_bilerp_add`).
#[allow(clippy::too_many_arguments)]
fn bilerp_add(fused: &[f32], d16: &[f32], scratch: &mut [f32], planes: &[f32], denoised: &mut [f32], n: usize, p0: usize, cw0: usize, ch0: usize) {
    let plane = n * n;
    for i in 0..3 * p0 {
        scratch[i] = fused[i] - d16[i];
    }
    let inv = 1.0 / FUSION_FINEST as f32;
    for y in 0..n {
        let sy = (y as f32 + 0.5) * inv - 0.5;
        for x in 0..n {
            let i = y * n + x;
            if let Some(c) = (0..3).find(|&c| planes[(1 + c) * plane + i] > 0.0) {
                denoised[i] += bilerp_tap(&scratch[c * p0..(c + 1) * p0], cw0, ch0, (x as f32 + 0.5) * inv - 0.5, sy);
            }
        }
    }
}

/// `original + strength·(denoised − original)`: the module's opacity.
#[inline]
pub fn blend(original: f32, denoised: f32, strength: f32) -> f32 {
    original + strength * (denoised - original)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_are_found_and_interpolated() {
        let p100 = noise_profile(Some("Sony"), Some("ILCE-7M3"), Some(100));
        let p200 = noise_profile(Some("Sony"), Some("ILCE-7M3"), Some(200));
        assert!(p100.matched && p100.a[1] > 0.0 && p200.a[1] > p100.a[1]);
        let mid = noise_profile(Some("Sony"), Some("ILCE-7M3"), Some(150));
        assert!(mid.a[1] > p100.a[1] && mid.a[1] < p200.a[1]);
        // Below and above the profiled range: clamped.
        let sony = |iso| noise_profile(Some("Sony"), Some("ILCE-7M3"), Some(iso));
        assert_eq!(sony(1), sony(2));
        assert_eq!(sony(10_000_000), sony(20_000_000));
        assert_eq!(noise_profile(Some("Fujifilm Corporation"), Some("X-T30"), Some(400)).matched, true);
        assert_eq!(noise_profile(Some("Sony"), Some("ILCE-7RM3A"), Some(400)), noise_profile(Some("Sony"), Some("ILCE-7RM3"), Some(400)));
        assert_eq!(noise_profile(Some("Sony"), Some("No Such Camera"), Some(400)), GENERIC_PROFILE);
        assert_eq!(noise_profile(None, None, None), GENERIC_PROFILE);
    }

    #[test]
    fn reflect_mirrors_without_repeating_the_edge() {
        assert_eq!([-2, -1, 0, 4, 5, 6].map(|v| reflect(v, 5)), [2, 1, 0, 4, 3, 2]);
        assert_eq!(reflect(-7, 1), 0);
    }

    #[test]
    fn tiles_cover_the_sensor_on_a_fixed_grid() {
        let t = tiles(2000, 900);
        assert_eq!(t.len(), 6);
        assert_eq!(t[2], Region { x: 1536, y: 0, width: 464, height: 768 });
        assert_eq!(t[5], Region { x: 1536, y: 768, width: 464, height: 132 });
        let some = tiles_in(2000, 900, Region { x: 700, y: 700, width: 100, height: 10 });
        assert_eq!(some.iter().map(|r| (r.x, r.y)).collect::<Vec<_>>(), [(0, 0), (768, 0)]);
    }
}
