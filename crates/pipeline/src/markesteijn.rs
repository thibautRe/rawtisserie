//! Markesteijn demosaicing (Frank Markesteijn's algorithm, after dcraw 9.20) for Fujifilm
//! X-Trans sensors at full resolution (roadmap 3.9): a port of Ansel's
//! `src/iop/demosaic/markesteijn.c` (`xtrans_markesteijn_interpolate`, GPL-3.0-or-later).
//! Ansel's default for X-Trans is the 1-pass variant ([`PASSES`]); 3 passes work too.
//!
//! Deviations from upstream:
//! - It works on a patch of the sensor and gives a region of it, in upstream's tiles: the
//!   grid is fixed on the sensor (from `-pad`, every `TS - 2 pad` photosites), and a
//!   region runs the tiles that hold its pixels, from a patch holding those tiles'
//!   photosites ([`patch_bounds`]). So a region is exactly the whole's pixels, whatever
//!   the algorithm reads; tiles at the sensor's edges mirror it as upstream does.
//! - The samples it reads are balanced and normalised by the caller (`demosaic.rs`):
//!   upstream runs after white balance.
//! - Its scratch buffers are separate rather than aliased (gmin/gmax and the homogeneity
//!   maps share the YPbPr buffer upstream), and zeroed once per call; what they hold
//!   outside a tile's computed area never reaches the output.
//! - The output is clamped at 0, as RCD's.
//!
//! It keeps upstream's integer arithmetic (C's truncating `/` and `%` on rows and columns
//! that may be negative, as Rust's on `i32`): compare with it line by line.

use crate::image::{Image, Region};

/// Ansel's default for X-Trans: Markesteijn 1-pass.
pub const PASSES: usize = 1;
/// Tile size (upstream's `TS`, to keep a tile in L2 cache).
const TS: i32 = 122;
const TT: usize = (TS * TS) as usize;

/// The smallest sensor it demosaics: the mirrored border needs more than its padding.
pub const MIN_SIZE: usize = 40;

/// Padding of a tile: extra passes spread errors further in from its edges.
fn pad_tile(passes: usize) -> i32 {
    if passes == 1 { 12 } else { 17 }
}

/// An X-Trans CFA: the colour (0 red, 1 green, 2 blue) of each photosite of a 6×6 block
/// starting on coordinates multiple of 6, by row then column.
#[derive(Clone, Copy, Debug)]
pub struct XTrans(pub [[u8; 6]; 6]);

impl XTrans {
    /// `colour(x, y)` of a sensor as an X-Trans pattern, if it is one (period 6, 8 red, 20
    /// green and 8 blue photosites in a block, with a solitary green).
    pub fn detect(colour: impl Fn(usize, usize) -> usize) -> Option<XTrans> {
        let p: [[u8; 6]; 6] = std::array::from_fn(|y| std::array::from_fn(|x| colour(x, y) as u8));
        let periodic = (0..12).all(|y| (0..12).all(|x| colour(x, y) as u8 == p[y % 6][x % 6]));
        let mut count = [0; 3];
        p.iter().flatten().for_each(|&c| count[(c as usize).min(2)] += 1);
        let xtrans = XTrans(p);
        (periodic && count == [8, 20, 8] && xtrans.hexagons().is_some()).then_some(xtrans)
    }

    /// Upstream's `FCxtrans` (row and column from -600).
    #[inline]
    fn fc(&self, row: i32, col: i32) -> usize {
        self.0[((row + 600) % 6) as usize][((col + 600) % 6) as usize] as usize
    }

    /// The green hexagon around each non-green photosite and vice versa (upstream's
    /// `allhex`, offsets in a tile's buffer), for rows and columns mod 3, and where the
    /// solitary green is (`sgrow`, `sgcol`), if there's one.
    fn hexagons(&self) -> Option<Hexagons> {
        const ORTH: [i32; 12] = [1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0, 1];
        const PATT: [[i32; 16]; 2] = [[0, 1, 0, -1, 2, 0, -1, 0, 1, 1, 1, -1, 0, 0, 0, 0], [0, 1, 0, -2, 1, 0, -2, 0, 1, 1, -2, -2, 1, -1, -1, 1]];
        let mut allhex = [[[0i32; 8]; 3]; 3];
        let mut solitary = None;
        for row in 0..3i32 {
            for col in 0..3i32 {
                let mut ng = 0;
                let mut d = 0;
                while d < 10 {
                    let g = (self.fc(row, col) == 1) as i32;
                    if self.fc(row + ORTH[d], col + ORTH[d + 2]) == 1 {
                        ng = 0;
                    } else {
                        ng += 1;
                    }
                    // Four non-green photosites around it: the solitary green.
                    if ng == 4 {
                        solitary = Some((row, col));
                    }
                    if ng == g + 1 {
                        for c in 0..8usize {
                            let v = ORTH[d] * PATT[g as usize][c * 2] + ORTH[d + 1] * PATT[g as usize][c * 2 + 1];
                            let h = ORTH[d + 2] * PATT[g as usize][c * 2] + ORTH[d + 3] * PATT[g as usize][c * 2 + 1];
                            allhex[row as usize][col as usize][c ^ ((g as usize * 2) & d)] = h + v * TS;
                        }
                    }
                    d += 2;
                }
            }
        }
        let (sgrow, sgcol) = solitary?;
        Some(Hexagons { allhex, sgrow, sgcol })
    }
}

struct Hexagons {
    allhex: [[[i32; 8]; 3]; 3],
    sgrow: i32,
    sgcol: i32,
}

impl Hexagons {
    /// Upstream's `hexmap`.
    #[inline]
    fn at(&self, row: i32, col: i32) -> &[i32; 8] {
        &self.allhex[((row + 600) % 3) as usize][((col + 600) % 3) as usize]
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
    pub cfa: XTrans,
}

impl Patch {
    #[inline]
    fn s(&self, x: i32, y: i32) -> f32 {
        self.samples[(y as usize - self.y0) * self.w + (x as usize - self.x0)]
    }
}

/// The tiles (first and last index on each axis) that hold `region`'s pixels.
fn tiles(region: Region, passes: usize) -> ((i32, i32), (i32, i32)) {
    let step = (TS - 2 * pad_tile(passes)) as usize;
    let along = |start: usize, end: usize| ((start / step) as i32, ((end - 1) / step) as i32);
    (along(region.x, region.right()), along(region.y, region.bottom()))
}

/// The patch of the sensor (`x0, y0, x1, y1`) that [`demosaic`] needs for `region`: the
/// photosites of the tiles that hold its pixels, and one more around them (what a tile
/// beyond the sensor's edge interpolates its mirror from).
pub fn patch_bounds(width: usize, height: usize, region: Region, passes: usize) -> (usize, usize, usize, usize) {
    let pad = pad_tile(passes);
    let step = TS - 2 * pad;
    let ((kx0, kx1), (ky0, ky1)) = tiles(region, passes);
    let span = |k0: i32, k1: i32, size: usize| {
        let (start, end) = (k0 * step - pad - 1, (k1 * step - pad + TS).min(size as i32 + pad) + 1);
        (start.max(0) as usize, (end.max(0) as usize).min(size))
    };
    let ((x0, x1), (y0, y1)) = (span(kx0, kx1, width), span(ky0, ky1, height));
    (x0, y0, x1, y1)
}

/// Scratch buffers for a tile, reused from one to the next.
struct Scratch {
    /// `ndir` tiles of RGB.
    rgb: Vec<[f32; 3]>,
    gmin: Vec<f32>,
    gmax: Vec<f32>,
    /// Y, Pb and Pr planes.
    yuv: Vec<f32>,
    drv: Vec<f32>,
    homo: Vec<u8>,
    homosum: Vec<u8>,
}

#[inline]
fn sqr(x: f32) -> f32 {
    x * x
}

/// Upstream's `CLAMPS`.
#[inline]
fn clamps(a: f32, l: f32, h: f32) -> f32 {
    if a > l {
        if a < h { a } else { h }
    } else {
        l
    }
}

/// `region` of the sensor demosaiced with `passes` (1 or 3), from `patch` (which must hold
/// [`patch_bounds`]). Values as the patch's samples (balanced, normalised).
pub fn demosaic(patch: &Patch, region: Region, passes: usize) -> Image {
    let mut img = Image::new(region.width, region.height);
    let hex = patch.cfa.hexagons().expect("an X-Trans pattern");
    let ndir = if passes > 1 { 8 } else { 4 };
    let mut sc = Scratch {
        rgb: vec![[0.0; 3]; ndir * TT],
        gmin: vec![0.0; TT],
        gmax: vec![0.0; TT],
        yuv: vec![0.0; 3 * TT],
        drv: vec![0.0; ndir * TT],
        homo: vec![0; ndir * TT],
        homosum: vec![0; ndir * TT],
    };
    let pad = pad_tile(passes);
    let step = TS - 2 * pad;
    let ((kx0, kx1), (ky0, ky1)) = tiles(region, passes);
    for ky in ky0..=ky1 {
        for kx in kx0..=kx1 {
            tile(patch, &mut sc, &hex, passes, (ky * step - pad, kx * step - pad), region, &mut img);
        }
    }
    img
}

/// One tile, from `(top, left)` on the sensor: its pixels within `region` written to
/// `img` (which covers `region`).
fn tile(p: &Patch, sc: &mut Scratch, hexagons: &Hexagons, passes: usize, (top, left): (i32, i32), region: Region, img: &mut Image) {
    const DIR: [i32; 4] = [1, TS, TS + 1, TS - 1];
    let (width, height) = (p.width as i32, p.height as i32);
    let fc = |row: i32, col: i32| p.cfa.fc(row, col);
    let (sgrow, sgcol) = (hexagons.sgrow, hexagons.sgcol);
    let ndir = if passes > 1 { 8 } else { 4 };
    let pad_tile = pad_tile(passes);
    let Scratch { rgb, gmin, gmax, yuv, drv, homo, homosum } = sc;
    // Index in a tile buffer of `(row, col)` (sensor coordinates).
    let at = |row: i32, col: i32| (row - top) * TS + (col - left);
    let u = |i: i32| i as usize;

    let mut mrow = (top + TS).min(height + pad_tile);
    let mut mcol = (left + TS).min(width + pad_tile);

    // Copy the tile from the sensor, mirroring (or interpolating) beyond its edges.
    let translate = |n: i32, size: i32| if n >= size { 2 * size - n - 2 } else { n.abs() };
    for row in top..mrow {
        for col in left..mcol {
            let pix = &mut rgb[u(at(row, col))];
            if col >= 0 && row >= 0 && col < width && row < height {
                let f = fc(row, col);
                *pix = [0.0; 3];
                pix[f] = p.s(col, row);
            } else {
                let c = fc(row, col);
                *pix = [0.0; 3];
                let (cy, cx) = (translate(row, height), translate(col, width));
                if c == fc(cy, cx) {
                    pix[c] = p.s(cx, cy);
                } else {
                    // Interpolate if the mirrored photosite is another colour.
                    let (mut sum, mut count) = (0.0f32, 0u8);
                    for y in row - 1..=row + 1 {
                        for x in col - 1..=col + 1 {
                            let (yy, xx) = (translate(y, height), translate(x, width));
                            if fc(yy, xx) == c {
                                sum += p.s(xx, yy);
                                count += 1;
                            }
                        }
                    }
                    pix[c] = sum / count as f32;
                }
            }
        }
    }

    // Duplicate rgb[0] to rgb[1], rgb[2] and rgb[3].
    for c in 1..=3 {
        rgb.copy_within(0..TT, c * TT);
    }

    // Set green1 and green3 to the minimum and maximum allowed values: each red/blue
    // pair gets the min/max of the greens around it.
    let pad_g1_g3 = 3;
    let mut row = top + pad_g1_g3;
    while row < mrow - pad_g1_g3 {
        // max at 0 means a new pair, whose min/max are to compute.
        let (mut min, mut max) = (f32::MAX, 0.0f32);
        let mut col = left + pad_g1_g3;
        while col < mcol - pad_g1_g3 {
            if fc(row, col) == 1 {
                (min, max) = (f32::MAX, 0.0);
                col += 1;
                continue;
            }
            if max == 0.0 {
                let pix = at(row, col);
                let hex = hexagons.at(row, col);
                for &o in &hex[..6] {
                    let val = rgb[u(pix + o)][1];
                    if min > val {
                        min = val;
                    }
                    if max < val {
                        max = val;
                    }
                }
            }
            gmin[u(at(row, col))] = min;
            gmax[u(at(row, col))] = max;
            // Vertical red/blue pairs.
            match (row - sgrow) % 3 {
                // Hop down a row, to the pair's second photosite.
                1 => {
                    if row < mrow - 4 {
                        row += 1;
                        col -= 1;
                    }
                }
                // Then, unless the row is done, up and right to the next pair.
                2 => {
                    (min, max) = (f32::MAX, 0.0);
                    col += 2;
                    if col < mcol - 4 && row > top + 3 {
                        row -= 1;
                    }
                }
                _ => {}
            }
            col += 1;
        }
        row += 1;
    }

    // Interpolate green horizontally, vertically, and along both diagonals.
    let pad_g_interp = 3;
    for row in top + pad_g_interp..mrow - pad_g_interp {
        for col in left + pad_g_interp..mcol - pad_g_interp {
            let f = fc(row, col);
            if f == 1 {
                continue;
            }
            let pix = at(row, col);
            let hex = hexagons.at(row, col);
            let g = |o: i32| rgb[u(pix + o)][1];
            let v = |o: i32| rgb[u(pix + o)][f];
            let mut color = [0.0f32; 4];
            color[0] = 0.6796875 * (g(hex[1]) + g(hex[0])) - 0.1796875 * (g(2 * hex[1]) + g(2 * hex[0]));
            color[1] = 0.87109375 * g(hex[3]) + g(hex[2]) * 0.13 + 0.359375 * (v(0) - v(-hex[2]));
            for c in 0..2 {
                color[2 + c] = 0.640625 * g(hex[4 + c]) + 0.359375 * g(-2 * hex[4 + c]) + 0.12890625 * (2.0 * v(0) - v(3 * hex[4 + c]) - v(-3 * hex[4 + c]));
            }
            let flip = ((row - sgrow) % 3 == 0) as usize;
            for (c, &value) in color.iter().enumerate() {
                rgb[(c ^ flip) * TT + u(pix)][1] = clamps(value, gmin[u(pix)], gmax[u(pix)]);
            }
        }
    }

    // The tile set the passes work on: rgb[0..4], then (from the second pass) a copy of it
    // in rgb[4..8].
    let mut base = 0usize;
    for pass in 0..passes {
        if pass == 1 {
            rgb.copy_within(0..4 * TT, 4 * TT);
            base = 4;
        }
        let rgb = &mut rgb[base * TT..];

        // Recalculate green from interpolated values of closer pixels.
        if pass > 0 {
            let pad_g_recalc = 6;
            for row in top + pad_g_recalc..mrow - pad_g_recalc {
                for col in left + pad_g_recalc..mcol - pad_g_recalc {
                    let f = fc(row, col);
                    if f == 1 {
                        continue;
                    }
                    let hex = hexagons.at(row, col);
                    let i = at(row, col);
                    for d in 3..6usize {
                        let rfx = ((d - 2) ^ ((row - sgrow) % 3 == 0) as usize) as i32 * TS * TS + i;
                        let r = |o: i32, c: usize| rgb[u(rfx + o)][c];
                        let val = r(-2 * hex[d], 1) + 2.0 * r(hex[d], 1) - r(-2 * hex[d], f) - 2.0 * r(hex[d], f) + 3.0 * r(0, f);
                        rgb[u(rfx)][1] = clamps(val / 3.0, gmin[u(i)], gmax[u(i)]);
                    }
                }
            }
        }

        // Interpolate red and blue values for solitary green pixels.
        let pad_rb_g = if passes == 1 { 6 } else { 5 };
        let mut row = (top - sgrow + pad_rb_g + 2) / 3 * 3 + sgrow;
        while row < mrow - pad_rb_g {
            let mut col = (left - sgcol + pad_rb_g + 2) / 3 * 3 + sgcol;
            while col < mcol - pad_rb_g {
                let mut rfx = at(row, col);
                let mut h = fc(row, col + 1);
                let mut diff = [0.0f32; 6];
                // Interpolated colour: red/blue, then pass; twice the result.
                let mut color = [[0.0f32; 6]; 2];
                // Six passes, alternating horizontal and vertical (i), starting with red
                // or blue (h), whichever is closest. Passes 0 and 1 go to rgb[0] and
                // rgb[1]; 3 and 5 to rgb[2] and rgb[3], the best of horizontal and
                // vertical.
                let mut i = 1i32;
                for d in 0..6usize {
                    for c in 0..2 {
                        let o = i << c;
                        let r = |o: i32, c: usize| rgb[u(rfx + o)][c];
                        let g = 2.0 * r(0, 1) - r(o, 1) - r(-o, 1);
                        color[(h != 0) as usize][d] = g + r(o, h) + r(-o, h);
                        if d > 1 {
                            diff[d] += sqr(r(o, 1) - r(-o, 1) - r(o, h) + r(-o, h)) + sqr(g);
                        }
                        h ^= 2;
                    }
                    if d < 2 || d & 1 != 0 {
                        let d_out = d - (d > 1 && diff[d - 1] < diff[d]) as usize;
                        rgb[u(rfx)][0] = color[0][d_out] / 2.0;
                        rgb[u(rfx)][2] = color[1][d_out] / 2.0;
                        rfx += TS * TS;
                    }
                    i ^= TS ^ 1;
                    h ^= 2;
                }
                col += 3;
            }
            row += 3;
        }

        // Interpolate red for blue pixels and vice versa.
        let pad_rb_br = if passes == 1 { 6 } else { 5 };
        for row in top + pad_rb_br..mrow - pad_rb_br {
            for col in left + pad_rb_br..mcol - pad_rb_br {
                let f = 2 - fc(row, col);
                if f == 1 {
                    continue;
                }
                let mut rfx = at(row, col);
                let c = if (row - sgrow) % 3 != 0 { TS } else { 1 };
                let h = 3 * (c ^ TS ^ 1);
                for d in 0..4i32 {
                    let r = |o: i32, ch: usize| rgb[u(rfx + o)][ch];
                    let i = if d > 1
                        || ((d ^ c) & 1) != 0
                        || ((r(0, 1) - r(c, 1)).abs() + (r(0, 1) - r(-c, 1)).abs()) < 2.0 * ((r(0, 1) - r(h, 1)).abs() + (r(0, 1) - r(-h, 1)).abs())
                    {
                        c
                    } else {
                        h
                    };
                    rgb[u(rfx)][f] = (r(i, f) + r(-i, f) + 2.0 * r(0, 1) - r(i, 1) - r(-i, 1)) / 2.0;
                    rfx += TS * TS;
                }
            }
        }

        // Fill in red and blue for 2×2 blocks of green.
        let pad_g22 = if passes == 1 { 8 } else { 4 };
        for row in top + pad_g22..mrow - pad_g22 {
            if (row - sgrow) % 3 == 0 {
                continue;
            }
            for col in left + pad_g22..mcol - pad_g22 {
                if (col - sgcol) % 3 == 0 {
                    continue;
                }
                let mut rfx = at(row, col);
                let hex = hexagons.at(row, col);
                let mut d = 0;
                while d < ndir {
                    let r = |o: i32, ch: usize| rgb[u(rfx + o)][ch];
                    // Red and blue only read the neighbours.
                    let [red, blue] = if hex[d] + hex[d + 1] != 0 {
                        let g = 3.0 * r(0, 1) - 2.0 * r(hex[d], 1) - r(hex[d + 1], 1);
                        [0, 2].map(|c| (g + 2.0 * r(hex[d], c) + r(hex[d + 1], c)) / 3.0)
                    } else {
                        let g = 2.0 * r(0, 1) - r(hex[d], 1) - r(hex[d + 1], 1);
                        [0, 2].map(|c| (g + r(hex[d], c) + r(hex[d + 1], c)) / 2.0)
                    };
                    rgb[u(rfx)][0] = red;
                    rgb[u(rfx)][2] = blue;
                    d += 2;
                    rfx += TS * TS;
                }
            }
        }
    }

    // From here on, tile coordinates.
    mrow -= top;
    mcol -= left;

    // Convert to a perceptual space (Rec. 2020 YPbPr, as upstream) and differentiate in
    // every direction.
    let (y_, pb, pr) = (0, TT, 2 * TT);
    for d in 0..ndir {
        let pad_yuv = if passes == 1 { 8 } else { 13 };
        for row in pad_yuv..mrow - pad_yuv {
            for col in pad_yuv..mcol - pad_yuv {
                let i = u(row * TS + col);
                let rx = rgb[d * TT + i];
                let y = 0.2627 * rx[0] + 0.6780 * rx[1] + 0.0593 * rx[2];
                yuv[y_ + i] = y;
                yuv[pb + i] = (rx[2] - y) * 0.56433;
                yuv[pr + i] = (rx[0] - y) * 0.67815;
            }
        }
        let f = DIR[d & 3];
        let pad_drv = if passes == 1 { 9 } else { 14 };
        for row in pad_drv..mrow - pad_drv {
            for col in pad_drv..mcol - pad_drv {
                let i = row * TS + col;
                let second = |plane: usize| sqr(2.0 * yuv[plane + u(i)] - yuv[plane + u(i + f)] - yuv[plane + u(i - f)]);
                drv[d * TT + u(i)] = second(y_) + second(pb) + second(pr);
            }
        }
    }

    // Homogeneity maps from the derivatives.
    homo.fill(0);
    let pad_homo = if passes == 1 { 10 } else { 15 };
    let ts = TS as usize;
    for row in pad_homo..mrow - pad_homo {
        for col in pad_homo..mcol - pad_homo {
            let i = u(row * TS + col);
            let mut tr = f32::MAX;
            for d in 0..ndir {
                if tr > drv[d * TT + i] {
                    tr = drv[d * TT + i];
                }
            }
            tr *= 8.0;
            // The 3×3 neighbours at or under the threshold (upstream adds them one by one).
            for d in 0..ndir {
                let n = &drv[d * TT + i - ts - 1..][..2 * ts + 3];
                let count = |r: usize| (n[r] <= tr) as u8 + (n[r + 1] <= tr) as u8 + (n[r + 2] <= tr) as u8;
                homo[d * TT + i] += count(0) + count(ts) + count(2 * ts);
            }
        }
    }

    // 5×5 sums of the homogeneity maps, for each pixel and direction: upstream rolls them
    // along the row (in u8, from 0 where homo is 0); they're sums of the column sums.
    let mut colsum = [0u8; TS as usize];
    for d in 0..ndir {
        let (homo, homosum) = (&homo[d * TT..][..TT], &mut homosum[d * TT..][..TT]);
        for row in pad_tile..mrow - pad_tile {
            let (c0, c1) = (u(pad_tile - 2), u(mcol - pad_tile + 2));
            let rows: [&[u8]; 5] = std::array::from_fn(|v| &homo[u(row + v as i32 - 2) * ts..][..ts]);
            for (c, sum) in colsum.iter_mut().enumerate().take(c1).skip(c0) {
                *sum = rows[0][c] + rows[1][c] + rows[2][c] + rows[3][c] + rows[4][c];
            }
            let out = &mut homosum[u(row) * ts..][..ts];
            for col in u(pad_tile)..u(mcol - pad_tile) {
                out[col] = colsum[col - 2] + colsum[col - 1] + colsum[col] + colsum[col + 1] + colsum[col + 2];
            }
        }
    }

    // Average the most homogeneous directions, for the pixels within `region`.
    let (r0, r1) = ((pad_tile + top).max(region.y as i32), (mrow - pad_tile + top).min(region.bottom() as i32));
    let (c0, c1) = ((pad_tile + left).max(region.x as i32), (mcol - pad_tile + left).min(region.right() as i32));
    for y in r0..r1 {
        for x in c0..c1 {
            let i = u((y - top) * TS + (x - left));
            let mut hm = [0u8; 8];
            let mut maxval = 0u8;
            for d in 0..ndir {
                hm[d] = homosum[d * TT + i];
                maxval = maxval.max(hm[d]);
            }
            maxval -= maxval >> 3;
            for d in 0..ndir - 4 {
                if hm[d] < hm[d + 4] {
                    hm[d] = 0;
                } else if hm[d] > hm[d + 4] {
                    hm[d + 4] = 0;
                }
            }
            let (mut avg, mut n) = ([0.0f32; 3], 0.0f32);
            for d in 0..ndir {
                if hm[d] >= maxval {
                    let px = rgb[d * TT + i];
                    for c in 0..3 {
                        avg[c] += px[c];
                    }
                    n += 1.0;
                }
            }
            img.pixels[(y as usize - region.y) * region.width + (x as usize - region.x)] = avg.map(|v| (v / n).max(0.0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::Rgb;

    /// Fujifilm X-T30's pattern (as rawler gives it, by row).
    const XT30: XTrans = XTrans([
        [1, 1, 0, 1, 1, 2],
        [1, 1, 2, 1, 1, 0],
        [2, 0, 1, 0, 2, 1],
        [1, 1, 2, 1, 1, 0],
        [1, 1, 0, 1, 1, 2],
        [0, 2, 1, 2, 0, 1],
    ]);

    /// A mosaic of `f(x, y)` (an RGB image) through `cfa`, as a patch of the whole sensor.
    fn mosaic(w: usize, h: usize, cfa: XTrans, f: impl Fn(usize, usize) -> Rgb) -> Patch {
        let samples = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| f(x, y)[cfa.0[y % 6][x % 6] as usize]).collect();
        Patch { x0: 0, y0: 0, w, h, samples, width: w, height: h, cfa }
    }

    /// The pattern shifted by `(dx, dy)` (another crop of the sensor).
    fn shifted(cfa: XTrans, dx: usize, dy: usize) -> XTrans {
        XTrans(std::array::from_fn(|y| std::array::from_fn(|x| cfa.0[(y + dy) % 6][(x + dx) % 6])))
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
    fn detects_x_trans_patterns_only() {
        assert!(XTrans::detect(|x, y| XT30.0[y % 6][x % 6] as usize).is_some());
        for (dx, dy) in [(1, 0), (0, 1), (2, 3), (5, 5)] {
            let s = shifted(XT30, dx, dy);
            assert!(XTrans::detect(|x, y| s.0[y % 6][x % 6] as usize).is_some(), "{dx},{dy}");
        }
        // Bayer.
        assert!(XTrans::detect(|x, y| [[0, 1], [1, 2]][y & 1][x & 1]).is_none());
    }

    #[test]
    fn a_flat_field_stays_flat() {
        for passes in [1, 3] {
            for (dx, dy) in [(0, 0), (1, 2), (4, 1)] {
                let cfa = shifted(XT30, dx, dy);
                let p = mosaic(150, 130, cfa, |_, _| [0.4, 0.4, 0.4]);
                let img = demosaic(&p, Region::full(150, 130), passes);
                for (i, px) in img.pixels.iter().enumerate() {
                    assert!(px.iter().all(|&v| (v - 0.4).abs() < 1e-4), "{passes} {dx},{dy} {} {}: {px:?}", i % 150, i / 150);
                }
            }
        }
    }

    #[test]
    fn a_region_matches_the_whole() {
        let (w, h) = (260, 230);
        for passes in [1, 3] {
            let p = mosaic(w, h, shifted(XT30, 2, 1), |x, y| std::array::from_fn(|c| noise(x / 3, y / 3, c) * 0.8 + 0.1));
            let whole = demosaic(&p, Region::full(w, h), passes);
            // Inside, at the corners and edges, across tiles, smaller than a tile.
            for r in [
                Region { x: 37, y: 51, width: 150, height: 120 },
                Region { x: 0, y: 0, width: 33, height: 17 },
                Region { x: 200, y: 181, width: 60, height: 49 },
                Region { x: 5, y: 120, width: 9, height: 7 },
                Region { x: 101, y: 0, width: 1, height: 230 },
            ] {
                let (x0, y0, x1, y1) = patch_bounds(w, h, r, passes);
                let samples = (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).map(|(x, y)| p.s(x as i32, y as i32)).collect();
                let patch = Patch { x0, y0, w: x1 - x0, h: y1 - y0, samples, ..p };
                let part = demosaic(&patch, r, passes);
                for y in 0..r.height {
                    for x in 0..r.width {
                        assert_eq!(part.get(x, y), whole.get(r.x + x, r.y + y), "{passes} {r:?} at {x},{y}");
                    }
                }
            }
        }
    }

    #[test]
    fn smooth_colours_come_back() {
        let (w, h) = (200, 160);
        let f = |x: usize, y: usize| {
            let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
            [0.2 + 0.6 * u, 0.3 + 0.4 * (6.0 * v).sin().abs() * 0.5, 0.7 - 0.5 * u * v]
        };
        for passes in [1, 3] {
            let p = mosaic(w, h, XT30, f);
            let img = demosaic(&p, Region::full(w, h), passes);
            let mut worst = 0.0f32;
            for y in 4..h - 4 {
                for x in 4..w - 4 {
                    let (a, b) = (img.get(x, y), f(x, y));
                    worst = (0..3).fold(worst, |m, c| m.max((a[c] - b[c]).abs()));
                }
            }
            assert!(worst < 0.01, "{passes}: {worst}");
        }
    }
}
