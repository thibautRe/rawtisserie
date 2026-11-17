//! Spatial filters: gaussian and box blurs (retouch, masks, glow, export sharpening).

use crate::image::{Image, Rgb};

/// Gaussian blur of the whole image. Small radii use an exact separable kernel,
/// large ones three successive box blurs (≈ gaussian, O(1) per pixel).
pub fn gaussian_blur(img: &Image, sigma: f32) -> Image {
    if sigma < 0.2 {
        return img.clone();
    }
    let mut channels: [Vec<f32>; 3] = std::array::from_fn(|c| img.pixels.iter().map(|p| p[c]).collect());
    for plane in &mut channels {
        blur_plane(plane, img.width, img.height, sigma);
    }
    let mut out = Image::new(img.width, img.height);
    for (i, p) in out.pixels.iter_mut().enumerate() {
        *p = [channels[0][i], channels[1][i], channels[2][i]];
    }
    out
}

pub fn blur_active(sigma: f32) -> bool {
    sigma >= 0.2
}

pub fn sharpen_active(amount: f32, sigma: f32) -> bool {
    amount > 0.0 && sigma >= 0.2
}

/// How far, in pixels, a blur of `sigma` reads around each pixel.
pub fn reach(sigma: f32) -> usize {
    if sigma <= 4.0 { (sigma * 3.0).ceil() as usize } else { box_radii(sigma).iter().sum() }
}

pub fn blur(img: &mut Image, sigma: f32) {
    if blur_active(sigma) {
        *img = gaussian_blur(img, sigma);
    }
}

pub(crate) fn blur_plane(plane: &mut [f32], w: usize, h: usize, sigma: f32) {
    let mut tmp = vec![0.0f32; plane.len()];
    if sigma <= 4.0 {
        let kernel = gaussian_kernel(sigma);
        convolve_rows(plane, &mut tmp, w, h, &kernel);
        convolve_cols(&tmp, plane, w, h, &kernel);
    } else {
        for radius in box_radii(sigma) {
            box_rows(plane, &mut tmp, w, h, radius);
            box_cols(&tmp, plane, w, h, radius);
        }
    }
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (sigma * 3.0).ceil() as i32;
    let mut k: Vec<f32> = (-radius..=radius).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    k
}

fn convolve_rows(src: &[f32], dst: &mut [f32], w: usize, h: usize, k: &[f32]) {
    let r = (k.len() / 2) as isize;
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        for x in 0..w {
            let mut acc = 0.0;
            for (i, kv) in k.iter().enumerate() {
                let sx = (x as isize + i as isize - r).clamp(0, w as isize - 1) as usize;
                acc += row[sx] * kv;
            }
            dst[y * w + x] = acc;
        }
    }
}

fn convolve_cols(src: &[f32], dst: &mut [f32], w: usize, h: usize, k: &[f32]) {
    let r = (k.len() / 2) as isize;
    for y in 0..h {
        let out = &mut dst[y * w..(y + 1) * w];
        out.fill(0.0);
        for (i, kv) in k.iter().enumerate() {
            let sy = (y as isize + i as isize - r).clamp(0, h as isize - 1) as usize;
            let row = &src[sy * w..(sy + 1) * w];
            for (o, s) in out.iter_mut().zip(row) {
                *o += s * kv;
            }
        }
    }
}

/// Three box blurs approximating a Gaussian of `sigma` (as [`blur_plane`] does for
/// large ones) over all three channels at once. Below a sigma of about 1 it does nothing.
pub(crate) fn box_blur_rgb(px: &mut [Rgb], w: usize, h: usize, sigma: f32) {
    let mut tmp = vec![[0.0f32; 3]; px.len()];
    for radius in box_radii(sigma).into_iter().filter(|&r| r > 0) {
        box_rows_rgb(px, &mut tmp, w, h, radius);
        box_cols_rgb(&tmp, px, w, h, radius);
    }
}

/// Like [`box_blur_rgb`], with a sigma of its own along rows (`sigma_x`) and columns.
/// Its running sums are kept in f64: rows can be long (a glow's turned grid), and an f32
/// sum drifts along them, differently from another start (a region).
pub(crate) fn box_blur_rgb_xy(px: &mut [Rgb], w: usize, h: usize, sigma_x: f32, sigma_y: f32) {
    let mut tmp = vec![[0.0f32; 3]; px.len()];
    for radius in box_radii(sigma_x).into_iter().filter(|&r| r > 0) {
        box_rows_rgb_f64(px, &mut tmp, w, h, radius);
        px.copy_from_slice(&tmp);
    }
    for radius in box_radii(sigma_y).into_iter().filter(|&r| r > 0) {
        box_cols_rgb_f64(px, &mut tmp, w, h, radius);
        px.copy_from_slice(&tmp);
    }
}

fn box_rows_rgb_f64(src: &[Rgb], dst: &mut [Rgb], w: usize, h: usize, r: usize) {
    let norm = 1.0 / (2 * r + 1) as f64;
    let clamp = |i: isize| i.clamp(0, w as isize - 1) as usize;
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let out = &mut dst[y * w..(y + 1) * w];
        let mut acc = [0.0f64; 3];
        for i in -(r as isize)..=r as isize {
            let p = row[clamp(i)];
            (0..3).for_each(|c| acc[c] += p[c] as f64);
        }
        for (x, o) in out.iter_mut().enumerate() {
            *o = acc.map(|a| (a * norm) as f32);
            let (add, sub) = (row[clamp(x as isize + r as isize + 1)], row[clamp(x as isize - r as isize)]);
            (0..3).for_each(|c| acc[c] += add[c] as f64 - sub[c] as f64);
        }
    }
}

fn box_cols_rgb_f64(src: &[Rgb], dst: &mut [Rgb], w: usize, h: usize, r: usize) {
    let norm = 1.0 / (2 * r + 1) as f64;
    let clamp = |i: isize| i.clamp(0, h as isize - 1) as usize;
    let mut acc = vec![[0.0f64; 3]; w];
    for i in -(r as isize)..=r as isize {
        let row = &src[clamp(i) * w..][..w];
        acc.iter_mut().zip(row).for_each(|(a, s)| (0..3).for_each(|c| a[c] += s[c] as f64));
    }
    for y in 0..h {
        let out = &mut dst[y * w..(y + 1) * w];
        out.iter_mut().zip(&acc).for_each(|(o, a)| *o = a.map(|v| (v * norm) as f32));
        let add = &src[clamp(y as isize + r as isize + 1) * w..][..w];
        let sub = &src[clamp(y as isize - r as isize) * w..][..w];
        for ((a, p), m) in acc.iter_mut().zip(add).zip(sub) {
            (0..3).for_each(|c| a[c] += p[c] as f64 - m[c] as f64);
        }
    }
}

/// How far [`box_blur_rgb`] reads around each pixel.
pub(crate) fn box_reach(sigma: f32) -> usize {
    box_radii(sigma).iter().sum()
}

fn box_rows_rgb(src: &[Rgb], dst: &mut [Rgb], w: usize, h: usize, r: usize) {
    let norm = 1.0 / (2 * r + 1) as f32;
    let clamp = |i: isize| i.clamp(0, w as isize - 1) as usize;
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let out = &mut dst[y * w..(y + 1) * w];
        let mut acc = [0.0f32; 3];
        for i in -(r as isize)..=r as isize {
            let p = row[clamp(i)];
            (0..3).for_each(|c| acc[c] += p[c]);
        }
        for (x, o) in out.iter_mut().enumerate() {
            *o = acc.map(|a| a * norm);
            let (add, sub) = (row[clamp(x as isize + r as isize + 1)], row[clamp(x as isize - r as isize)]);
            (0..3).for_each(|c| acc[c] += add[c] - sub[c]);
        }
    }
}

fn box_cols_rgb(src: &[Rgb], dst: &mut [Rgb], w: usize, h: usize, r: usize) {
    let norm = 1.0 / (2 * r + 1) as f32;
    let clamp = |i: isize| i.clamp(0, h as isize - 1) as usize;
    let mut acc = vec![[0.0f32; 3]; w];
    for i in -(r as isize)..=r as isize {
        let row = &src[clamp(i) * w..][..w];
        acc.iter_mut().zip(row).for_each(|(a, s)| (0..3).for_each(|c| a[c] += s[c]));
    }
    for y in 0..h {
        let out = &mut dst[y * w..(y + 1) * w];
        out.iter_mut().zip(&acc).for_each(|(o, a)| *o = a.map(|v| v * norm));
        let add = &src[clamp(y as isize + r as isize + 1) * w..][..w];
        let sub = &src[clamp(y as isize - r as isize) * w..][..w];
        for ((a, p), m) in acc.iter_mut().zip(add).zip(sub) {
            (0..3).for_each(|c| a[c] += p[c] - m[c]);
        }
    }
}

/// Radii of three box filters approximating a gaussian (Kovesi / "boxes for gauss").
fn box_radii(sigma: f32) -> [usize; 3] {
    let n = 3.0;
    let w_ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut wl = w_ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wu = wl + 2;
    let m_ideal = (12.0 * sigma * sigma - n * (wl * wl) as f32 - 4.0 * n * wl as f32 - 3.0 * n) / (-4.0 * wl as f32 - 4.0);
    let m = m_ideal.round() as i32;
    std::array::from_fn(|i| (((if (i as i32) < m { wl } else { wu }) - 1) / 2).max(0) as usize)
}

fn box_rows(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
    let norm = 1.0 / (2 * r + 1) as f32;
    let clamp = |i: isize| i.clamp(0, w as isize - 1) as usize;
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let mut acc: f32 = (-(r as isize)..=r as isize).map(|i| row[clamp(i)]).sum();
        for x in 0..w {
            dst[y * w + x] = acc * norm;
            acc += row[clamp(x as isize + r as isize + 1)] - row[clamp(x as isize - r as isize)];
        }
    }
}

fn box_cols(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
    let norm = 1.0 / (2 * r + 1) as f32;
    let clamp = |i: isize| i.clamp(0, h as isize - 1) as usize;
    let mut acc = vec![0.0f32; w];
    for i in -(r as isize)..=r as isize {
        let row = &src[clamp(i) * w..][..w];
        acc.iter_mut().zip(row).for_each(|(a, s)| *a += s);
    }
    for y in 0..h {
        let out = &mut dst[y * w..(y + 1) * w];
        out.iter_mut().zip(&acc).for_each(|(o, a)| *o = a * norm);
        let add = &src[clamp(y as isize + r as isize + 1) * w..][..w];
        let sub = &src[clamp(y as isize - r as isize) * w..][..w];
        for x in 0..w {
            acc[x] += add[x] - sub[x];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(v: f32) -> Image {
        Image { width: 16, height: 9, pixels: vec![[v; 3]; 16 * 9] }
    }

    #[test]
    fn blur_preserves_flat_field() {
        for sigma in [0.5, 2.0, 10.0] {
            let out = gaussian_blur(&flat(0.3), sigma);
            assert!(out.pixels.iter().all(|p| (p[0] - 0.3).abs() < 1e-5), "sigma {sigma}");
        }
    }

    #[test]
    fn blur_spreads_impulse() {
        let mut img = flat(0.0);
        img.pixels[4 * 16 + 8] = [1.0; 3];
        let out = gaussian_blur(&img, 1.0);
        let total: f32 = out.pixels.iter().map(|p| p[0]).sum();
        assert!((total - 1.0).abs() < 1e-3);
        assert!(out.pixels[4 * 16 + 8][0] < 0.5 && out.pixels[4 * 16 + 9][0] > 0.0);
    }

    #[test]
    fn box_radii_are_sane() {
        assert!(box_radii(10.0).iter().all(|r| (5..=10).contains(r)));
    }
}
