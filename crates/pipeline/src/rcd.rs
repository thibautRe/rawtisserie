//! RCD demosaicing (Ratio Corrected Demosaicing, by Luis Sanz Rodríguez) for Bayer
//! sensors at full resolution (roadmap 3.9): a port of Ansel's `src/iop/demosaic/rcd.c`
//! (GPL-3.0-or-later, after RawTherapee's tiled version), with its PPG border for the
//! outer pixels of the sensor.
//!
//! Deviations from upstream:
//! - It works on a patch of the sensor and gives a region of it (the whole sensor, or a
//!   zoomed region with its margin), in the same tiles as upstream: a pixel only depends
//!   on the photosites within [`BORDER`] of it, so a region matches the whole. Tiles
//!   start on even photosites, so that their local CFA parity is the sensor's, as
//!   upstream's (multiples of its tile step) are.
//! - The samples it reads are balanced and normalised by the caller (`demosaic.rs`):
//!   upstream runs after white balance, and RCD interpolates colour differences.
//! - Its scratch buffers are zeroed once per call rather than per thread; what they hold
//!   outside a tile's exact area never reaches the output (upstream's note 1).

use crate::image::{Image, Region, Rgb};

/// How far in from a tile's edge, or the sensor's, a pixel is exact: the margin a region
/// needs, and the band at the sensor's edges the PPG border fills.
pub const BORDER: usize = 10;
const TILE: usize = 112;
const VALID: usize = TILE - 2 * BORDER;
const W1: usize = TILE;
const W2: usize = 2 * TILE;
const W3: usize = 3 * TILE;
const W4: usize = 4 * TILE;
const EPS: f32 = 1e-5;
const EPSSQ: f32 = 1e-10;

/// The smallest sensor it demosaics (upstream's limit).
pub const MIN_SIZE: usize = 16;

/// A Bayer CFA: the colour (0 red, 1 green, 2 blue) of each photosite of a 2×2 block
/// starting on even coordinates.
#[derive(Clone, Copy, Debug)]
pub struct Bayer(pub [[u8; 2]; 2]);

impl Bayer {
    /// `colour(x, y)` of a sensor as a Bayer pattern, if it is one (period 2, one red, one
    /// blue and two greens).
    pub fn detect(colour: impl Fn(usize, usize) -> usize) -> Option<Bayer> {
        let p = [[colour(0, 0) as u8, colour(1, 0) as u8], [colour(0, 1) as u8, colour(1, 1) as u8]];
        let periodic = (0..6).all(|y| (0..6).all(|x| colour(x, y) as u8 == p[y & 1][x & 1]));
        let mut count = [0; 3];
        p.iter().flatten().for_each(|&c| count[c as usize] += 1);
        (periodic && count == [1, 2, 1]).then_some(Bayer(p))
    }

    #[inline]
    fn fc(&self, row: usize, col: usize) -> usize {
        self.0[row & 1][col & 1] as usize
    }
}

/// Samples of a patch of the sensor (`width × height` photosites in all), balanced and
/// normalised, not negative.
pub struct Patch {
    pub x0: usize,
    pub y0: usize,
    pub w: usize,
    pub h: usize,
    pub samples: Vec<f32>,
    pub width: usize,
    pub height: usize,
    pub cfa: Bayer,
}

impl Patch {
    #[inline]
    fn s(&self, x: usize, y: usize) -> f32 {
        self.samples[(y - self.y0) * self.w + (x - self.x0)]
    }

    #[inline]
    fn fc(&self, x: usize, y: usize) -> usize {
        self.cfa.fc(y, x)
    }

    /// Average of the colour-`c` photosites in the 3×3 block around `(x, y)` (upstream's
    /// border step 1), if there's one.
    fn avg3(&self, x: usize, y: usize, c: usize) -> Option<f32> {
        let (mut sum, mut n) = (0.0f32, 0);
        for yy in y.saturating_sub(1)..(y + 2).min(self.height) {
            for xx in x.saturating_sub(1)..(x + 2).min(self.width) {
                if self.fc(xx, yy) == c {
                    sum += self.s(xx, yy);
                    n += 1;
                }
            }
        }
        (n > 0).then(|| sum / n as f32)
    }

    /// Green at `(x, y)` as the border sees it: the photosite's own, PPG's estimate
    /// (step 2) at least 3 photosites in, or the 3×3 average (step 1).
    fn border_green(&self, x: usize, y: usize) -> f32 {
        let pc = self.s(x, y);
        if self.fc(x, y) == 1 {
            return pc;
        }
        let (w, h) = (self.width, self.height);
        if !(x >= 3 && y >= 3 && x < w - 3 && y < h - 3) {
            return self.avg3(x, y, 1).unwrap_or(pc);
        }
        let s = |dx: isize, dy: isize| self.s((x as isize + dx) as usize, (y as isize + dy) as usize);
        let (pym, pym2, pym3, pyy, pyy2, pyy3) = (s(0, -1), s(0, -2), s(0, -3), s(0, 1), s(0, 2), s(0, 3));
        let (pxm, pxm2, pxm3, pxx, pxx2, pxx3) = (s(-1, 0), s(-2, 0), s(-3, 0), s(1, 0), s(2, 0), s(3, 0));
        let guessx = (pxm + pc + pxx) * 2.0 - pxx2 - pxm2;
        let diffx = ((pxm2 - pc).abs() + (pxx2 - pc).abs() + (pxm - pxx).abs()) * 3.0 + ((pxx3 - pxx).abs() + (pxm3 - pxm).abs()) * 2.0;
        let guessy = (pym + pc + pyy) * 2.0 - pyy2 - pym2;
        let diffy = ((pym2 - pc).abs() + (pyy2 - pc).abs() + (pym - pyy).abs()) * 3.0 + ((pyy3 - pyy).abs() + (pym3 - pym).abs()) * 2.0;
        if diffx > diffy {
            (guessy * 0.25).min(pym.max(pyy)).max(pym.min(pyy))
        } else {
            (guessx * 0.25).min(pxm.max(pxx)).max(pxm.min(pxx))
        }
    }

    /// A pixel within [`BORDER`] of the sensor's edge (upstream's `rcd_ppg_border`).
    fn border_pixel(&self, x: usize, y: usize) -> Rgb {
        let (w, h) = (self.width, self.height);
        let f = self.fc(x, y);
        let pc = self.s(x, y);
        // The outermost ring: 3×3 averages.
        if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
            return std::array::from_fn(|c| if c == f { pc } else { self.avg3(x, y, c).unwrap_or(pc) });
        }
        // Own sample, green, then the other colours from colour differences (step 3).
        // A neighbour's own channel is its sample, its green `border_green`.
        let g = |x: usize, y: usize| self.border_green(x, y);
        let mut out = [0.0f32; 3];
        out[f] = pc;
        out[1] = g(x, y);
        let (t, b, l, r) = ((x, y - 1), (x, y + 1), (x - 1, y), (x + 1, y));
        let diff = |a: (usize, usize), b: (usize, usize), c1: f32| (self.s(a.0, a.1) + self.s(b.0, b.1) + 2.0 * c1 - g(a.0, a.1) - g(b.0, b.1)) * 0.5;
        if f == 1 {
            if self.fc(x + 1, y) == 0 {
                out[2] = diff(t, b, out[1]);
                out[0] = diff(l, r, out[1]);
            } else {
                out[0] = diff(t, b, out[1]);
                out[2] = diff(l, r, out[1]);
            }
        } else {
            let c = 2 - f;
            let (tl, tr, bl, br) = ((x - 1, y - 1), (x + 1, y - 1), (x - 1, y + 1), (x + 1, y + 1));
            let (s, c1) = (|p: (usize, usize)| self.s(p.0, p.1), out[1]);
            let gg = |p: (usize, usize)| g(p.0, p.1);
            let diff1 = (s(tl) - s(br)).abs() + (gg(tl) - c1).abs() + (gg(br) - c1).abs();
            let guess1 = s(tl) + s(br) + 2.0 * c1 - gg(tl) - gg(br);
            let diff2 = (s(tr) - s(bl)).abs() + (gg(tr) - c1).abs() + (gg(bl) - c1).abs();
            let guess2 = s(tr) + s(bl) + 2.0 * c1 - gg(tr) - gg(bl);
            out[c] = if diff1 > diff2 {
                guess2 * 0.5
            } else if diff1 < diff2 {
                guess1 * 0.5
            } else {
                (guess1 + guess2) * 0.25
            };
        }
        out
    }
}

#[inline]
fn sqf(x: f32) -> f32 {
    x * x
}

#[inline]
fn intp(a: f32, b: f32, c: f32) -> f32 {
    a * (b - c) + c
}

/// Scratch buffers for a tile, reused from one to the next.
struct Scratch {
    cfa: Vec<f32>,
    rgb: [Vec<f32>; 3],
    vh_dir: Vec<f32>,
    /// PQ_Dir, and the low pass filter before it (upstream shares them).
    pq_dir: Vec<f32>,
    p_hpf: Vec<f32>,
    q_hpf: Vec<f32>,
}

/// `region` of the sensor demosaiced, from `patch` (which must hold the region and
/// [`BORDER`] + 2 photosites around it, as far as the sensor goes). Values as the
/// patch's samples (balanced, normalised).
pub fn demosaic(patch: &Patch, region: Region) -> Image {
    let (w, h) = (patch.width, patch.height);
    let mut img = Image::new(region.width, region.height);
    // The band along the sensor's edges.
    for y in region.y..region.bottom() {
        for x in region.x..region.right() {
            if x < BORDER || y < BORDER || x >= w - BORDER || y >= h - BORDER {
                img.pixels[(y - region.y) * region.width + (x - region.x)] = patch.border_pixel(x, y);
            }
        }
    }
    // The rest, in tiles: each gives the VALID × VALID pixels BORDER in from its edges.
    let (ix0, iy0) = (region.x.max(BORDER), region.y.max(BORDER));
    let (ix1, iy1) = (region.right().min(w - BORDER), region.bottom().min(h - BORDER));
    if ix0 >= ix1 || iy0 >= iy1 {
        return img;
    }
    let mut scratch = Scratch {
        cfa: vec![0.0; TILE * TILE],
        rgb: std::array::from_fn(|_| vec![0.0; TILE * TILE]),
        vh_dir: vec![0.0; TILE * TILE],
        pq_dir: vec![0.0; TILE * TILE / 2],
        p_hpf: vec![0.0; TILE * TILE / 2],
        q_hpf: vec![0.0; TILE * TILE / 2],
    };
    // Tiles start on even photosites (BORDER is even).
    let mut ty = iy0 & !1;
    while ty < iy1 {
        let mut tx = ix0 & !1;
        while tx < ix1 {
            tile(patch, &mut scratch, (tx - BORDER, ty - BORDER), region, (ix0, iy0, ix1, iy1), &mut img);
            tx += VALID;
        }
        ty += VALID;
    }
    img
}

/// One tile, from `(col_start, row_start)` on the sensor: its exact pixels within the
/// `inner` box (sensor coordinates) written to `img` (which covers `region`).
fn tile(patch: &Patch, sc: &mut Scratch, (col_start, row_start): (usize, usize), region: Region, inner: (usize, usize, usize, usize), img: &mut Image) {
    let row_end = (row_start + TILE).min(patch.y0 + patch.h).min(patch.height);
    let col_end = (col_start + TILE).min(patch.x0 + patch.w).min(patch.width);
    let tile_rows = row_end - row_start;
    let tile_cols = col_end - col_start;
    let cfa_of = &patch.cfa;
    let fc = |row: usize, col: usize| cfa_of.fc(row, col);
    let Scratch { cfa, rgb, vh_dir, pq_dir, p_hpf, q_hpf } = sc;

    // Step 0: fill data.
    for row in 0..tile_rows {
        let (c0, c1) = (fc(row, 0), fc(row, 1));
        for col in 0..tile_cols {
            let indx = row * TILE + col;
            let v = patch.s(col_start + col, row_start + row);
            cfa[indx] = v;
            rgb[c0][indx] = v;
            rgb[c1][indx] = v;
        }
    }

    // Step 1: vertical and horizontal interpolation directions.
    let hpf_v = |cfa: &[f32], indx: usize| sqf((cfa[indx - W3] - cfa[indx - W1] - cfa[indx + W1] + cfa[indx + W3]) - 3.0 * (cfa[indx - W2] + cfa[indx + W2]) + 6.0 * cfa[indx]);
    let hpf_h = |cfa: &[f32], indx: usize| sqf((cfa[indx - 3] - cfa[indx - 1] - cfa[indx + 1] + cfa[indx + 3]) - 3.0 * (cfa[indx - 2] + cfa[indx + 2]) + 6.0 * cfa[indx]);
    let mut buffer_v = [[0.0f32; TILE - 8]; 3];
    for row in 3..(tile_rows.saturating_sub(3)).min(5) {
        for col in 4..tile_cols.saturating_sub(4) {
            buffer_v[row - 3][col - 4] = hpf_v(cfa, row * TILE + col);
        }
    }
    let mut buffer_h = [0.0f32; TILE];
    let (mut v0, mut v1, mut v2) = (0usize, 1usize, 2usize);
    for row in 4..tile_rows.saturating_sub(4) {
        for col in 3..tile_cols - 3 {
            buffer_h[col - 3] = hpf_h(cfa, row * TILE + col);
        }
        for col in 4..tile_cols - 4 {
            buffer_v[v2][col - 4] = hpf_v(cfa, (row + 1) * TILE + col);
        }
        for col in 4..tile_cols - 4 {
            let indx = row * TILE + col;
            let v_stat = EPSSQ.max(buffer_v[v0][col - 4] + buffer_v[v1][col - 4] + buffer_v[v2][col - 4]);
            let h_stat = EPSSQ.max(buffer_h[col - 4] + buffer_h[col - 3] + buffer_h[col - 2]);
            vh_dir[indx] = v_stat / (v_stat + h_stat);
        }
        (v0, v1, v2) = (v1, v2, v0);
    }

    // Step 2: the low pass filter (in PQ_Dir's buffer, as upstream).
    let lpf = &mut *pq_dir;
    for row in 2..tile_rows.saturating_sub(2) {
        let mut col = 2 + (fc(row, 0) & 1);
        while col < tile_cols - 2 {
            let indx = row * TILE + col;
            lpf[indx / 2] = cfa[indx]
                + 0.5 * (cfa[indx - W1] + cfa[indx + W1] + cfa[indx - 1] + cfa[indx + 1])
                + 0.25 * (cfa[indx - W1 - 1] + cfa[indx - W1 + 1] + cfa[indx + W1 - 1] + cfa[indx + W1 + 1]);
            col += 2;
        }
    }

    // Step 3: green at the red and blue photosites.
    for row in 4..tile_rows.saturating_sub(4) {
        let mut col = 4 + (fc(row, 0) & 1);
        while col < tile_cols - 4 {
            let indx = row * TILE + col;
            let lpindx = indx / 2;
            let cfai = cfa[indx];
            let n_grad = EPS + (cfa[indx - W1] - cfa[indx + W1]).abs() + (cfai - cfa[indx - W2]).abs() + (cfa[indx - W1] - cfa[indx - W3]).abs() + (cfa[indx - W2] - cfa[indx - W4]).abs();
            let s_grad = EPS + (cfa[indx - W1] - cfa[indx + W1]).abs() + (cfai - cfa[indx + W2]).abs() + (cfa[indx + W1] - cfa[indx + W3]).abs() + (cfa[indx + W2] - cfa[indx + W4]).abs();
            let w_grad = EPS + (cfa[indx - 1] - cfa[indx + 1]).abs() + (cfai - cfa[indx - 2]).abs() + (cfa[indx - 1] - cfa[indx - 3]).abs() + (cfa[indx - 2] - cfa[indx - 4]).abs();
            let e_grad = EPS + (cfa[indx - 1] - cfa[indx + 1]).abs() + (cfai - cfa[indx + 2]).abs() + (cfa[indx + 1] - cfa[indx + 3]).abs() + (cfa[indx + 2] - cfa[indx + 4]).abs();

            let lpfi = lpf[lpindx];
            let n_est = cfa[indx - W1] * (lpfi + lpfi) / (EPS + lpfi + lpf[lpindx - W1]);
            let s_est = cfa[indx + W1] * (lpfi + lpfi) / (EPS + lpfi + lpf[lpindx + W1]);
            let w_est = cfa[indx - 1] * (lpfi + lpfi) / (EPS + lpfi + lpf[lpindx - 1]);
            let e_est = cfa[indx + 1] * (lpfi + lpfi) / (EPS + lpfi + lpf[lpindx + 1]);

            let v_est = (s_grad * n_est + n_grad * s_est) / (n_grad + s_grad);
            let h_est = (w_grad * e_est + e_grad * w_est) / (e_grad + w_grad);

            let central = vh_dir[indx];
            let neighbourhood = 0.25 * (vh_dir[indx - W1 - 1] + vh_dir[indx - W1 + 1] + vh_dir[indx + W1 - 1] + vh_dir[indx + W1 + 1]);
            let disc = if (0.5 - central).abs() < (0.5 - neighbourhood).abs() { neighbourhood } else { central };
            rgb[1][indx] = intp(disc, h_est, v_est);
            col += 2;
        }
    }

    // Step 4.0: the P/Q diagonals' colour difference high pass filter.
    for row in 3..tile_rows.saturating_sub(3) {
        let mut col = 3;
        while col < tile_cols - 3 {
            let indx = row * TILE + col;
            let indx2 = indx / 2;
            p_hpf[indx2] = sqf((cfa[indx - W3 - 3] - cfa[indx - W1 - 1] - cfa[indx + W1 + 1] + cfa[indx + W3 + 3]) - 3.0 * (cfa[indx - W2 - 2] + cfa[indx + W2 + 2]) + 6.0 * cfa[indx]);
            q_hpf[indx2] = sqf((cfa[indx - W3 + 3] - cfa[indx - W1 + 1] - cfa[indx + W1 - 1] + cfa[indx + W3 - 3]) - 3.0 * (cfa[indx - W2 + 2] + cfa[indx + W2 - 2]) + 6.0 * cfa[indx]);
            col += 2;
        }
    }
    // Step 4.1: P/Q directional discrimination strength (over the low pass filter, which
    // isn't needed any more).
    let pq_dir = lpf;
    for row in 4..tile_rows.saturating_sub(4) {
        let mut col = 4 + (fc(row, 0) & 1);
        while col < tile_cols - 4 {
            let indx = row * TILE + col;
            let (indx2, indx3, indx4) = (indx / 2, (indx - W1 - 1) / 2, (indx + W1 - 1) / 2);
            let p_stat = EPSSQ.max(p_hpf[indx3] + p_hpf[indx2] + p_hpf[indx4 + 1]);
            let q_stat = EPSSQ.max(q_hpf[indx3 + 1] + q_hpf[indx2] + q_hpf[indx4]);
            pq_dir[indx2] = p_stat / (p_stat + q_stat);
            col += 2;
        }
    }

    // Step 4.2: red and blue at the blue and red photosites.
    for row in 4..tile_rows.saturating_sub(4) {
        let mut col = 4 + (fc(row, 0) & 1);
        while col < tile_cols - 4 {
            let indx = row * TILE + col;
            let c = 2 - fc(row, col);
            let (pqindx, pqindx2, pqindx3) = (indx / 2, (indx - W1 - 1) / 2, (indx + W1 - 1) / 2);
            let central = pq_dir[pqindx];
            let neighbourhood = 0.25 * (pq_dir[pqindx2] + pq_dir[pqindx2 + 1] + pq_dir[pqindx3] + pq_dir[pqindx3 + 1]);
            let disc = if (0.5 - central).abs() < (0.5 - neighbourhood).abs() { neighbourhood } else { central };

            let (rc, r1) = (&rgb[c], &rgb[1]);
            let nw_grad = EPS + (rc[indx - W1 - 1] - rc[indx + W1 + 1]).abs() + (rc[indx - W1 - 1] - rc[indx - W3 - 3]).abs() + (r1[indx] - r1[indx - W2 - 2]).abs();
            let ne_grad = EPS + (rc[indx - W1 + 1] - rc[indx + W1 - 1]).abs() + (rc[indx - W1 + 1] - rc[indx - W3 + 3]).abs() + (r1[indx] - r1[indx - W2 + 2]).abs();
            let sw_grad = EPS + (rc[indx - W1 + 1] - rc[indx + W1 - 1]).abs() + (rc[indx + W1 - 1] - rc[indx + W3 - 3]).abs() + (r1[indx] - r1[indx + W2 - 2]).abs();
            let se_grad = EPS + (rc[indx - W1 - 1] - rc[indx + W1 + 1]).abs() + (rc[indx + W1 + 1] - rc[indx + W3 + 3]).abs() + (r1[indx] - r1[indx + W2 + 2]).abs();

            let nw_est = rc[indx - W1 - 1] - r1[indx - W1 - 1];
            let ne_est = rc[indx - W1 + 1] - r1[indx - W1 + 1];
            let sw_est = rc[indx + W1 - 1] - r1[indx + W1 - 1];
            let se_est = rc[indx + W1 + 1] - r1[indx + W1 + 1];

            let p_est = (nw_grad * se_est + se_grad * nw_est) / (nw_grad + se_grad);
            let q_est = (ne_grad * sw_est + sw_grad * ne_est) / (ne_grad + sw_grad);
            let value = r1[indx] + intp(disc, q_est, p_est);
            rgb[c][indx] = value;
            col += 2;
        }
    }

    // Step 4.3: red and blue at the green photosites.
    for row in 4..tile_rows.saturating_sub(4) {
        let mut col = 4 + (fc(row, 1) & 1);
        while col < tile_cols - 4 {
            let indx = row * TILE + col;
            let central = vh_dir[indx];
            let neighbourhood = 0.25 * (vh_dir[indx - W1 - 1] + vh_dir[indx - W1 + 1] + vh_dir[indx + W1 - 1] + vh_dir[indx + W1 + 1]);
            let disc = if (0.5 - central).abs() < (0.5 - neighbourhood).abs() { neighbourhood } else { central };
            let r1 = &rgb[1];
            let rgb1 = r1[indx];
            let n1 = EPS + (rgb1 - r1[indx - W2]).abs();
            let s1 = EPS + (rgb1 - r1[indx + W2]).abs();
            let w1 = EPS + (rgb1 - r1[indx - 2]).abs();
            let e1 = EPS + (rgb1 - r1[indx + 2]).abs();
            let (rgb1mw1, rgb1pw1, rgb1m1, rgb1p1) = (r1[indx - W1], r1[indx + W1], r1[indx - 1], r1[indx + 1]);
            for c in [0, 2] {
                let rc = &rgb[c];
                let sn_abs = (rc[indx - W1] - rc[indx + W1]).abs();
                let ew_abs = (rc[indx - 1] - rc[indx + 1]).abs();
                let n_grad = n1 + sn_abs + (rc[indx - W1] - rc[indx - W3]).abs();
                let s_grad = s1 + sn_abs + (rc[indx + W1] - rc[indx + W3]).abs();
                let w_grad = w1 + ew_abs + (rc[indx - 1] - rc[indx - 3]).abs();
                let e_grad = e1 + ew_abs + (rc[indx + 1] - rc[indx + 3]).abs();
                let n_est = rc[indx - W1] - rgb1mw1;
                let s_est = rc[indx + W1] - rgb1pw1;
                let w_est = rc[indx - 1] - rgb1m1;
                let e_est = rc[indx + 1] - rgb1p1;
                let v_est = (n_grad * s_est + s_grad * n_est) / (n_grad + s_grad);
                let h_est = (e_grad * w_est + w_grad * e_est) / (e_grad + w_grad);
                rgb[c][indx] = rgb1 + intp(disc, h_est, v_est);
            }
            col += 2;
        }
    }

    // The tile's exact pixels, within what's asked.
    let (ix0, iy0, ix1, iy1) = inner;
    let (y0, y1) = ((row_start + BORDER).max(iy0), (row_end - BORDER).min(iy1));
    let (x0, x1) = ((col_start + BORDER).max(ix0), (col_end - BORDER).min(ix1));
    for y in y0..y1 {
        for x in x0..x1 {
            let idx = (y - row_start) * TILE + (x - col_start);
            img.pixels[(y - region.y) * region.width + (x - region.x)] = std::array::from_fn(|c| rgb[c][idx].max(0.0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RGGB: Bayer = Bayer([[0, 1], [1, 2]]);

    /// A mosaic of `f(x, y)` (an RGB image) through `cfa`, as a patch of the whole sensor.
    fn mosaic(w: usize, h: usize, cfa: Bayer, f: impl Fn(usize, usize) -> Rgb) -> Patch {
        let samples = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| f(x, y)[cfa.fc(y, x)]).collect();
        Patch { x0: 0, y0: 0, w, h, samples, width: w, height: h, cfa }
    }

    /// Pseudo-random, repeatable.
    fn noise(x: usize, y: usize, c: usize) -> f32 {
        let mut v = (x as u32).wrapping_mul(73856093) ^ (y as u32).wrapping_mul(19349663) ^ (c as u32).wrapping_mul(83492791);
        v ^= v >> 13;
        v = v.wrapping_mul(0x5bd1e995);
        v ^= v >> 15;
        (v % 1000) as f32 / 1000.0
    }

    #[test]
    fn detects_bayer_patterns_only() {
        assert!(Bayer::detect(|x, y| RGGB.fc(y, x)).is_some());
        let gbrg = Bayer::detect(|x, y| [[1, 2], [0, 1]][y & 1][x & 1]).unwrap();
        assert_eq!(gbrg.0, [[1, 2], [0, 1]]);
        // X-Trans-like: period 6.
        assert!(Bayer::detect(|x, y| [1, 1, 0, 1, 1, 2][(x + y) % 6]).is_none());
        // Two reds.
        assert!(Bayer::detect(|x, _| [0, 0][x & 1]).is_none());
    }

    #[test]
    fn a_flat_field_stays_flat() {
        for cfa in [RGGB, Bayer([[1, 0], [2, 1]]), Bayer([[2, 1], [1, 0]])] {
            let p = mosaic(150, 130, cfa, |_, _| [0.4, 0.4, 0.4]);
            let img = demosaic(&p, Region::full(150, 130));
            for (i, px) in img.pixels.iter().enumerate() {
                assert!(px.iter().all(|&v| (v - 0.4).abs() < 1e-4), "{cfa:?} {} {}: {px:?}", i % 150, i / 150);
            }
        }
    }

    #[test]
    fn a_region_matches_the_whole() {
        let (w, h) = (260, 230);
        let p = mosaic(w, h, RGGB, |x, y| std::array::from_fn(|c| noise(x / 3, y / 3, c) * 0.8 + 0.1));
        let whole = demosaic(&p, Region::full(w, h));
        // Inside, at the corners and edges, at odd and even places, smaller than a tile.
        for r in [
            Region { x: 37, y: 51, width: 150, height: 120 },
            Region { x: 0, y: 0, width: 33, height: 17 },
            Region { x: 200, y: 181, width: 60, height: 49 },
            Region { x: 5, y: 120, width: 9, height: 7 },
            Region { x: 101, y: 0, width: 1, height: 230 },
        ] {
            // The patch the region needs, as `demosaic.rs` cuts it.
            let m = BORDER + 2;
            let (x0, y0) = (r.x.saturating_sub(m), r.y.saturating_sub(m));
            let (x1, y1) = ((r.right() + m).min(w), (r.bottom() + m).min(h));
            let samples = (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).map(|(x, y)| p.s(x, y)).collect();
            let patch = Patch { x0, y0, w: x1 - x0, h: y1 - y0, samples, ..p };
            let part = demosaic(&patch, r);
            for y in 0..r.height {
                for x in 0..r.width {
                    assert_eq!(part.get(x, y), whole.get(r.x + x, r.y + y), "{r:?} at {x},{y}");
                }
            }
        }
    }

    #[test]
    fn smooth_colours_come_back() {
        // A smooth, saturated image: RCD gets it back closely, away from the border.
        let (w, h) = (200, 160);
        let f = |x: usize, y: usize| {
            let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
            [0.2 + 0.6 * u, 0.3 + 0.4 * (6.0 * v).sin().abs() * 0.5, 0.7 - 0.5 * u * v]
        };
        let p = mosaic(w, h, RGGB, f);
        let img = demosaic(&p, Region::full(w, h));
        let mut worst = 0.0f32;
        for y in BORDER..h - BORDER {
            for x in BORDER..w - BORDER {
                let (a, b) = (img.get(x, y), f(x, y));
                worst = (0..3).fold(worst, |m, c| m.max((a[c] - b[c]).abs()));
            }
        }
        assert!(worst < 0.01, "{worst}");
    }
}
