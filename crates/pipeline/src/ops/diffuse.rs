//! Diffuse or sharpen (roadmap 3.7), a port of Ansel's `src/iop/diffuse.c`
//! (GPL-3.0-or-later; upstream at `aurelienpierreeng/ansel`, with `pixel/bspline.h` and
//! `iop/noise_generator.h`): a multiscale anisotropic heat-transfer model. Each
//! iteration splits the image into à-trous B-spline bands (detail `HF` over a low pass
//! `LF`, one per octave), then rebuilds it from the coarsest band down, diffusing each
//! with four 3×3 operators: the low pass's and the detail's, each oriented along the
//! low pass's gradient (1st and 3rd order) or the detail's (2nd and 4th). Positive
//! speeds diffuse (blur, denoise, inpaint), negative ones sharpen (deblur, local
//! contrast). An edge-sensitivity term divides the update by the band's local energy
//! so edges are spared. Bands are weighted by a Gaussian over their size (a central
//! radius and a span), in full-resolution pixels.
//!
//! The arithmetic follows upstream (including its fast `exp` approximation), with
//! these deviations:
//!
//! * **Exposure.** Upstream runs after exposure; this runs in the spatial stage,
//!   before it. The gradient-driven anisotropy and the luminance threshold depend on
//!   the image's level, so the image is scaled by Ansel's default exposure push
//!   (+0.7 EV, also ours) for the module and back after: the same parameters do what
//!   they do in Ansel on a default edit. The rest (the energy is a ratio of detail to
//!   low pass) doesn't depend on the level.
//! * **Inpainting noise** (luminance threshold > 0) is seeded with each pixel's
//!   position in the whole frame, so a region renders the same noise as the whole
//!   image. Upstream derives its seed from the buffer offset.
//! * **Layout.** Each channel is diffused on its own plane (upstream's channels never
//!   mix either), and the 3×3 kernels are expanded into a few neighbour sums rather
//!   than convolved, so the loops vectorise. Same values, up to float rounding.
//! * **Identity.** With every speed and the sharpness at 0 the module does nothing
//!   (upstream would still clip negatives and fill the inpainting mask with noise).

use crate::image::Image;
use crate::params::Diffuse;

/// Most bands (upstream's `MAX_NUM_SCALES`).
const MAX_SCALES: usize = 10;
/// Most iterations (upstream's slider maximum).
pub const MAX_ITERATIONS: usize = 500;
/// Standard deviation of the 5-tap B-spline filter.
const B_SPLINE_SIGMA: f32 = 1.055_365_1;
/// The PDE's time step for a spatial step of 1.
const KAPPA: f32 = 0.25;
/// Ansel's default exposure push, +0.7 EV: the level the parameters are tuned for.
const EXPOSURE_REF: f32 = 1.624_504_8;
const FILTER: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

/// One band's coefficients.
#[derive(Clone, Copy, Debug)]
struct Band {
    /// Distance between the taps, in pixels (2^band).
    mult: usize,
    /// The four speeds, times `KAPPA` and the band's weight.
    abcd: [f32; 4],
    /// Detail gain: 1 + sharpness × the band's weight.
    strength: f32,
    /// Edge sensitivity, scaled by the band's size.
    regularization: f32,
}

/// The module at a render scale.
#[derive(Clone, Debug)]
pub struct DiffuseOp {
    iterations: usize,
    bands: Vec<Band>,
    /// Squared anisotropy of each operator.
    anisotropy: [f32; 4],
    /// 1 for an isotropic operator (anisotropy 0), else 0.
    isotropic: [f32; 4],
    /// 1 for an operator along the gradient (negative anisotropy), 0 along isophotes.
    gradient: [f32; 4],
    variance_threshold: f32,
    /// Luminance threshold of the inpainting mask (at the reference level); 0: none.
    threshold: f32,
    active: bool,
}

/// The standard deviation of `s + 1` stacked B-spline blurs, an octave apart.
fn equivalent_sigma_at_step(sigma: f32, s: usize) -> f32 {
    (0..=s).fold(0.0f32, |acc, i| (acc * acc + ((1u32 << i) as f32 * sigma).powi(2)).sqrt())
}

/// How many bands reach a blur of `sigma_final` (upstream's
/// `num_steps_to_reach_equivalent_sigma`).
fn num_steps_to_reach_equivalent_sigma(sigma_filter: f32, sigma_final: f32) -> usize {
    let mut s = 0;
    let mut radius = sigma_filter;
    while radius < sigma_final {
        s += 1;
        radius = (radius * radius + ((1u64 << s.min(62)) as f32 * sigma_filter).powi(2)).sqrt();
    }
    s + 1
}

/// Ansel's `dt_fast_expf`: meant for [-100, 0], about -0.06 off at 0.
#[inline(always)]
fn fast_exp(x: f32) -> f32 {
    const I1: i32 = 0x3f80_0000;
    const I2: i32 = 0x402D_F854;
    // Below -94 the result is 0 either way; clamping first keeps the conversion in range
    // (and NaN out), so it needs no saturation and vectorises.
    let y = I1 as f32 + x.max(-100.0) * (I2 - I1) as f32;
    // SAFETY: `y` is finite and within [-1.1e9, 1.1e9] ⊂ i32.
    let k0 = unsafe { y.to_int_unchecked::<i32>() };
    f32::from_bits(k0.max(0) as u32)
}

impl DiffuseOp {
    /// The module at `scale` output pixels per full-resolution pixel.
    pub fn new(p: &Diffuse, scale: f32) -> Self {
        let zoom = 1.0 / scale.max(1e-6);
        let iterations = (p.iterations.round().max(1.0) as usize).min(MAX_ITERATIONS);
        let radius_center = p.radius_center.max(0.0);
        let span = p.radius.max(1e-6);
        let final_radius = (p.radius.max(0.0) + radius_center) * 2.0 * scale;
        let scales = num_steps_to_reach_equivalent_sigma(B_SPLINE_SIGMA, final_radius).clamp(1, MAX_SCALES);
        let regularization = 10f32.powf(p.edge_sensitivity) - 1.0;
        let speeds = [p.speed1, p.speed2, p.speed3, p.speed4];
        let bands = (0..scales)
            .map(|s| {
                // The band's size in full-resolution pixels.
                let real_radius = equivalent_sigma_at_step(B_SPLINE_SIGMA, s) * zoom;
                let norm = (-(real_radius - radius_center).powi(2) / (span * span)).exp();
                Band {
                    mult: 1 << s,
                    abcd: speeds.map(|v| v * KAPPA * norm),
                    strength: p.sharpness * norm + 1.0,
                    regularization: regularization / 9.0 * real_radius * real_radius,
                }
            })
            .collect();
        let anisotropy = [p.anisotropy1, p.anisotropy2, p.anisotropy3, p.anisotropy4];
        Self {
            iterations,
            bands,
            anisotropy: anisotropy.map(|a| a * a),
            isotropic: anisotropy.map(|a| if a == 0.0 { 1.0 } else { 0.0 }),
            gradient: anisotropy.map(|a| if a < 0.0 { 1.0 } else { 0.0 }),
            variance_threshold: 10f32.powf(p.edge_threshold),
            threshold: p.luminance_threshold.max(0.0),
            active: speeds.iter().any(|&v| v != 0.0) || p.sharpness != 0.0,
        }
    }

    /// Whether the module changes the image.
    pub fn active(&self) -> bool {
        self.active
    }

    /// How far, in output pixels, the module reads around each pixel: per iteration, the
    /// decomposition's taps (2 × 2^band on each side, cumulated) and the diffusion's
    /// (2^band, on the way back up).
    pub fn reach(&self) -> usize {
        if !self.active {
            return 0;
        }
        let per_iteration = 3 * ((1usize << self.bands.len()) - 1);
        self.iterations.saturating_mul(per_iteration)
    }

    /// Apply the module to `img`, whose top-left pixel is at `origin` in the whole frame.
    pub fn apply(&self, img: &mut Image, origin: (usize, usize)) {
        if !self.active || img.pixels.is_empty() {
            return;
        }
        let (width, height) = (img.width, img.height);
        let mut planes: [Vec<f32>; 3] =
            std::array::from_fn(|c| img.pixels.iter().map(|px| px[c] * EXPOSURE_REF).collect());

        let mask = (self.threshold > 0.0).then(|| {
            let mask: Vec<bool> =
                (0..width * height).map(|i| planes.iter().any(|p| p[i] > self.threshold)).collect();
            inpaint(&mut planes, &mask, width, origin);
            mask
        });

        let mut work = Work::new(width, height, self.bands.len());
        for plane in &mut planes {
            for _ in 0..self.iterations {
                self.wavelets(plane, &mut work, mask.as_deref(), width, height);
            }
        }
        for (i, px) in img.pixels.iter_mut().enumerate() {
            *px = std::array::from_fn(|c| planes[c][i] / EXPOSURE_REF);
        }
    }

    /// One iteration on one channel, in place.
    fn wavelets(&self, plane: &mut Vec<f32>, w: &mut Work, mask: Option<&[bool]>, width: usize, height: usize) {
        let scales = self.bands.len();
        // Decompose: plane → HF[0] + low → HF[1] + low → …
        decompose(plane, &mut w.hf[0], &mut w.low, width, height, 1, &mut w.row);
        for s in 1..scales {
            decompose(&w.low, &mut w.hf[s], &mut w.other, width, height, 1 << s, &mut w.row);
            std::mem::swap(&mut w.low, &mut w.other);
        }
        // Rebuild from the coarsest band down, diffusing each; the finest lands in `plane`.
        for s in (0..scales).rev() {
            let out = if s == 0 { &mut *plane } else { &mut w.other };
            self.diffuse_band(&w.hf[s], &w.low, out, &mut w.ratio, &mut w.rows, mask, width, height, &self.bands[s]);
            if s != 0 {
                std::mem::swap(&mut w.low, &mut w.other);
            }
        }
    }

    /// Upstream's `heat_PDE_diffusion`: `out = max(0, LF + HF·strength + update / energy)`.
    #[allow(clippy::too_many_arguments)]
    fn diffuse_band(
        &self,
        hf: &[f32],
        lf: &[f32],
        out: &mut [f32],
        ratio: &mut [f32],
        rows: &mut Rows,
        mask: Option<&[bool]>,
        width: usize,
        height: usize,
        band: &Band,
    ) {
        // The energy sums (HF / LF)² over the 3×3 neighbourhood.
        for ((r, &h), &l) in ratio.iter_mut().zip(hf).zip(lf) {
            let q = h / l.max(1e-8);
            *r = q * q;
        }
        let m = band.mult;
        let k = Kernels::new(self, band);
        for i in 0..height {
            let neighbours = [i.saturating_sub(m), i, (i + m).min(height - 1)];
            rows.load(lf, hf, ratio, neighbours, width, m);
            let o = &mut out[i * width..(i + 1) * width];
            // The 3×3 neighbourhood as nine slices of exactly `width`, so that the loop
            // has no bounds checks left and vectorises.
            let (l, h, r) = (taps(&rows.lf, m, width), taps(&rows.hf, m, width), taps(&rows.ratio, m, width));
            for start in (0..width).step_by(CHUNK) {
                let end = (start + CHUNK).min(width);
                k.chunk(&part(&l, start, end), &part(&h, start, end), &part(&r, start, end), &mut o[start..end]);
            }
        }
        if let Some(mask) = mask {
            // Outside the inpainting mask, the band is left as it is.
            for (((o, &h), &l), &inside) in out.iter_mut().zip(hf).zip(lf).zip(mask) {
                if !inside {
                    *o = (h + l).max(0.0);
                }
            }
        }
    }
}

/// Pixels per [`Kernels::chunk`].
const CHUNK: usize = 64;

/// A band's constants for [`Kernels::chunk`].
struct Kernels {
    anisotropy: [f32; 4],
    isotropic: [f32; 4],
    gradient: [f32; 4],
    abcd: [f32; 4],
    strength: f32,
    variance_threshold: f32,
    regularization: f32,
}

/// The orientation of a gradient: `cos²`, `sin²`, `cos·sin` (cos along the rows'
/// direction, upstream's `x`, which is vertical), and its magnitude.
#[cfg(test)]
fn orientation(n: &[f32; 9]) -> (f32, f32, f32, f32) {
    orientation_of((n[7] - n[1]) * 0.5, (n[5] - n[3]) * 0.5)
}

/// [`orientation`] from the gradient: vertical `gx`, horizontal `gy`.
#[inline(always)]
fn orientation_of(gx: f32, gy: f32) -> (f32, f32, f32, f32) {
    let magnitude = (gx * gx + gy * gy).sqrt();
    // arg(grad) = 0 when the magnitude is 0, without a branch.
    let nonzero = if magnitude != 0.0 { 1.0 } else { 0.0 };
    let inv = 1.0 / (magnitude + (1.0 - nonzero));
    let (c, s) = (gx * inv + (1.0 - nonzero), gy * inv);
    (c * c, s * s, c * s, magnitude)
}

impl Kernels {
    fn new(op: &DiffuseOp, band: &Band) -> Self {
        Self {
            anisotropy: op.anisotropy,
            isotropic: op.isotropic,
            gradient: op.gradient,
            abcd: band.abcd,
            strength: band.strength,
            variance_threshold: op.variance_threshold,
            regularization: band.regularization,
        }
    }

    /// The reference for [`add_isotropic`] and [`add_anisotropic`]: operator `k`
    /// applied to a neighbourhood given by its sums (see `Sums`), oriented
    /// by `(cc, ss, cs)` with `c2 = exp(-|grad|·anisotropy)`: upstream's `compute_kernel`
    /// + convolution, with the 3×3 kernel expanded. Isotropic: Oono & Puri's Laplacian.
    /// Anisotropic, along isophotes: `a11 = cc + c2·ss`, `a22 = c2·cc + ss`,
    /// `a12 = (c2 − 1)·cs`; along the gradient, `a11` and `a22` swapped and `a12`
    /// negated; the kernel `[[a12/2, a22, −a12/2], [a11, −2(a11 + a22), a11], [−a12/2, a22, a12/2]]`.
    #[cfg(test)]
    fn derivative(&self, k: usize, n: Sums, (cc, ss, cs): (f32, f32, f32), c2: f32) -> f32 {
        let iso = 0.25 * n.corners + 0.5 * (n.vertical + n.horizontal) - 3.0 * n.center;
        let (g, m) = (self.gradient[k], c2 - 1.0);
        let a00 = (1.0 + g * m) * cc + (1.0 + (1.0 - g) * m) * ss;
        let a11 = (1.0 + (1.0 - g) * m) * cc + (1.0 + g * m) * ss;
        let b11 = 0.5 * (1.0 - 2.0 * g) * m * cs;
        let aniso = b11 * n.cross + a11 * n.vertical + a00 * n.horizontal - 2.0 * (a00 + a11) * n.center;
        let w = self.isotropic[k];
        w * iso + (1.0 - w) * aniso
    }

    /// Up to [`CHUNK`] output pixels from the nine taps of their low-pass, detail and
    /// squared-ratio neighbourhoods: the same as `pixel` (the reference, in tests) on each, as a few
    /// short loops over the pixels (structure of arrays) without branches or calls, so
    /// that they vectorise. Each operator gets its own loop, compiled for its direction,
    /// and none at speed 0 (upstream adds it times 0); gradients are only measured for
    /// the anisotropic ones.
    #[inline(always)]
    fn chunk(&self, l: &[&[f32]; 9], h: &[&[f32]; 9], r: &[&[f32]; 9], out: &mut [f32]) {
        let n = out.len().min(CHUNK).min(l[0].len());
        let out = &mut out[..n];
        let mut lows = SumsChunk::default();
        let mut details = SumsChunk::default();
        lows.load(l, n);
        details.load(h, n);
        let [r0, r1, r2, r3, r4, r5, r6, r7, r8] = r.map(|s| &s[..n]);
        let mut energy = [0.0f32; CHUNK];
        let energy = &mut energy[..n];
        for i in 0..n {
            let sum = r0[i] + r1[i] + r2[i] + r3[i] + r4[i] + r5[i] + r6[i] + r7[i] + r8[i];
            energy[i] = (self.variance_threshold + sum * self.regularization).max(1e-8);
        }
        // Operators 0 and 2 follow the low pass's gradient, 1 and 3 the detail's; 0 and 1
        // act on the low pass, 2 and 3 on the detail.
        let on = |k: usize| self.abcd[k] != 0.0;
        let oriented = |k: usize| on(k) && self.isotropic[k] == 0.0;
        if oriented(0) || oriented(2) {
            lows.orient(n);
        }
        if oriented(1) || oriented(3) {
            details.orient(n);
        }
        let mut update = [0.0f32; CHUNK];
        let update = &mut update[..n];
        // `c2 = exp(-|grad|·anisotropy)`, shared by the operators with the same gradient
        // and anisotropy (upstream's presets often pair 1st and 3rd, 2nd and 4th).
        let mut c2 = [[0.0f32; CHUNK]; 2];
        let mut c2_for: [Option<f32>; 2] = [None; 2];
        for k in (0..4).filter(|&k| on(k)) {
            let sums = if k < 2 { &lows } else { &details };
            let (speed, anisotropy) = (self.abcd[k], self.anisotropy[k]);
            if self.isotropic[k] != 0.0 {
                add_isotropic(update, sums, speed, n);
                continue;
            }
            let side = k % 2;
            let orientation = if side == 0 { &lows } else { &details };
            if c2_for[side] != Some(anisotropy) {
                let (magnitude, c2) = (&orientation.magnitude[..n], &mut c2[side][..n]);
                for i in 0..n {
                    c2[i] = fast_exp(-magnitude[i] * anisotropy);
                }
                c2_for[side] = Some(anisotropy);
            }
            if self.gradient[k] != 0.0 {
                add_anisotropic::<true>(update, sums, orientation, &c2[side], speed, n);
            } else {
                add_anisotropic::<false>(update, sums, orientation, &c2[side], speed, n);
            }
        }
        let (lc, hc) = (&lows.center[..n], &details.center[..n]);
        for i in 0..n {
            out[i] = (hc[i] * self.strength + update[i] / energy[i] + lc[i]).max(0.0);
        }
    }

    /// One output pixel from its low-pass and detail neighbourhoods and their summed
    /// squared detail-to-low-pass ratio (the reference for [`chunk`](Self::chunk)).
    #[cfg(test)]
    fn pixel(&self, l: &[f32; 9], h: &[f32; 9], energy: f32) -> f32 {
        let energy = (self.variance_threshold + energy * self.regularization).max(1e-8);
        let (lcc, lss, lcs, lmag) = orientation(l);
        let (hcc, hss, hcs, hmag) = orientation(h);
        let (lo, hi) = ((lcc, lss, lcs), (hcc, hss, hcs));
        let (ln, hn) = (Sums::of(l), Sums::of(h));
        let d0 = self.derivative(0, ln, lo, fast_exp(-lmag * self.anisotropy[0]));
        let d1 = self.derivative(1, ln, hi, fast_exp(-hmag * self.anisotropy[1]));
        let d2 = self.derivative(2, hn, lo, fast_exp(-lmag * self.anisotropy[2]));
        let d3 = self.derivative(3, hn, hi, fast_exp(-hmag * self.anisotropy[3]));
        let update = d0 * self.abcd[0] + d1 * self.abcd[1] + d2 * self.abcd[2] + d3 * self.abcd[3];
        (h[4] * self.strength + update / energy + l[4]).max(0.0)
    }
}

/// What the 3×3 operators read of a neighbourhood `n` (row-major, upstream's `x`
/// vertical): the corners crosswise `n0 − n2 − n6 + n8` and summed, the vertical and
/// horizontal neighbours' sums, and the centre.
#[cfg(test)]
#[derive(Clone, Copy, Debug)]
struct Sums {
    cross: f32,
    corners: f32,
    vertical: f32,
    horizontal: f32,
    center: f32,
}

#[cfg(test)]
impl Sums {
    fn of(n: &[f32; 9]) -> Self {
        Self {
            cross: n[0] - n[2] - n[6] + n[8],
            corners: n[0] + n[2] + n[6] + n[8],
            vertical: n[1] + n[7],
            horizontal: n[3] + n[5],
            center: n[4],
        }
    }
}

/// The neighbour sums (see `Sums`) and the gradient of up to [`CHUNK`] pixels, as arrays.
struct SumsChunk {
    cross: [f32; CHUNK],
    corners: [f32; CHUNK],
    vertical: [f32; CHUNK],
    horizontal: [f32; CHUNK],
    center: [f32; CHUNK],
    gx: [f32; CHUNK],
    gy: [f32; CHUNK],
    /// The gradient's orientation (see [`orientation`]), after [`orient`](Self::orient).
    cc: [f32; CHUNK],
    ss: [f32; CHUNK],
    cs: [f32; CHUNK],
    magnitude: [f32; CHUNK],
}

impl Default for SumsChunk {
    fn default() -> Self {
        let z = [0.0; CHUNK];
        Self { cross: z, corners: z, vertical: z, horizontal: z, center: z, gx: z, gy: z, cc: z, ss: z, cs: z, magnitude: z }
    }
}

impl SumsChunk {
    #[inline(always)]
    fn load(&mut self, taps: &[&[f32]; 9], n: usize) {
        let [t0, t1, t2, t3, t4, t5, t6, t7, t8] = taps.map(|s| &s[..n]);
        let (cross, corners, vertical, horizontal, center, gx, gy) = (
            &mut self.cross[..n],
            &mut self.corners[..n],
            &mut self.vertical[..n],
            &mut self.horizontal[..n],
            &mut self.center[..n],
            &mut self.gx[..n],
            &mut self.gy[..n],
        );
        for i in 0..n {
            cross[i] = t0[i] - t2[i] - t6[i] + t8[i];
            corners[i] = t0[i] + t2[i] + t6[i] + t8[i];
            vertical[i] = t1[i] + t7[i];
            horizontal[i] = t3[i] + t5[i];
            center[i] = t4[i];
            gx[i] = (t7[i] - t1[i]) * 0.5;
            gy[i] = (t5[i] - t3[i]) * 0.5;
        }
    }

    #[inline(always)]
    fn orient(&mut self, n: usize) {
        let (gx, gy) = (&self.gx[..n], &self.gy[..n]);
        let (cc, ss, cs, magnitude) = (&mut self.cc[..n], &mut self.ss[..n], &mut self.cs[..n], &mut self.magnitude[..n]);
        for i in 0..n {
            (cc[i], ss[i], cs[i], magnitude[i]) = orientation_of(gx[i], gy[i]);
        }
    }
}

/// `update += speed × (Oono & Puri's isotropic Laplacian of the neighbourhoods)`.
#[inline(always)]
fn add_isotropic(update: &mut [f32], s: &SumsChunk, speed: f32, n: usize) {
    let (update, corners, vertical, horizontal, center) = (&mut update[..n], &s.corners[..n], &s.vertical[..n], &s.horizontal[..n], &s.center[..n]);
    for i in 0..n {
        update[i] += speed * (0.25 * corners[i] + 0.5 * (vertical[i] + horizontal[i]) - 3.0 * center[i]);
    }
}

/// `update += speed × (the anisotropic operator of the neighbourhoods in `s`, oriented
/// by `o`, with `c2 = exp(-|grad|·anisotropy)`), along isophotes or (`GRADIENT`) along
/// the gradient: upstream's rotated anisotropic kernel, expanded (its reference form,
/// `Kernels::derivative`, is checked against upstream's in the tests).
#[inline(always)]
fn add_anisotropic<const GRADIENT: bool>(update: &mut [f32], s: &SumsChunk, o: &SumsChunk, c2: &[f32], speed: f32, n: usize) {
    let (update, c2) = (&mut update[..n], &c2[..n]);
    let (cross, vertical, horizontal, center) = (&s.cross[..n], &s.vertical[..n], &s.horizontal[..n], &s.center[..n]);
    let (cc, ss, cs) = (&o.cc[..n], &o.ss[..n], &o.cs[..n]);
    for i in 0..n {
        let c2 = c2[i];
        let (a00, a11, a01) = if GRADIENT {
            (c2 * cc[i] + ss[i], cc[i] + c2 * ss[i], (1.0 - c2) * cs[i])
        } else {
            (cc[i] + c2 * ss[i], c2 * cc[i] + ss[i], (c2 - 1.0) * cs[i])
        };
        let d = 0.5 * a01 * cross[i] + a11 * vertical[i] + a00 * horizontal[i] - 2.0 * (a00 + a11) * center[i];
        update[i] += speed * d;
    }
}

/// Scratch buffers for one channel, reused across iterations.
struct Work {
    hf: Vec<Vec<f32>>,
    low: Vec<f32>,
    other: Vec<f32>,
    ratio: Vec<f32>,
    row: Vec<f32>,
    rows: Rows,
}

impl Work {
    fn new(width: usize, height: usize, scales: usize) -> Self {
        let n = width * height;
        Self {
            hf: vec![vec![0.0; n]; scales],
            low: vec![0.0; n],
            other: vec![0.0; n],
            ratio: vec![0.0; n],
            row: Vec::new(),
            rows: Rows::default(),
        }
    }
}

/// The three rows a band's diffusion reads around one row, padded by `mult` on each
/// side with their edge pixels (upstream clamps the coordinates), so that the inner loop
/// has no bounds to check.
#[derive(Default)]
struct Rows {
    lf: [Vec<f32>; 3],
    hf: [Vec<f32>; 3],
    ratio: [Vec<f32>; 3],
}

/// The 3×3 neighbourhood of a row's pixels in padded `rows`, as nine slices of `width`.
fn taps(rows: &[Vec<f32>; 3], m: usize, width: usize) -> [&[f32]; 9] {
    std::array::from_fn(|t| &rows[t / 3][(t % 3) * m..(t % 3) * m + width])
}

fn part<'a>(taps: &[&'a [f32]; 9], start: usize, end: usize) -> [&'a [f32]; 9] {
    taps.map(|s| &s[start..end])
}

fn padded_row(dst: &mut Vec<f32>, src: &[f32], pad: usize) {
    dst.clear();
    dst.extend(std::iter::repeat_n(src[0], pad));
    dst.extend_from_slice(src);
    dst.extend(std::iter::repeat_n(src[src.len() - 1], pad));
}

impl Rows {
    fn load(&mut self, lf: &[f32], hf: &[f32], ratio: &[f32], rows: [usize; 3], width: usize, pad: usize) {
        for (j, &y) in rows.iter().enumerate() {
            let span = y * width..(y + 1) * width;
            padded_row(&mut self.lf[j], &lf[span.clone()], pad);
            padded_row(&mut self.hf[j], &hf[span.clone()], pad);
            padded_row(&mut self.ratio[j], &ratio[span], pad);
        }
    }
}

/// One à-trous step (upstream's `decompose_2D_Bspline`): `lf` is `input` blurred with the
/// 5-tap B-spline, taps `mult` apart, clamped at the edges and to ≥ 0 after each pass;
/// `hf = input − lf`.
fn decompose(input: &[f32], hf: &mut [f32], lf: &mut [f32], width: usize, height: usize, mult: usize, row: &mut Vec<f32>) {
    let mut column = vec![0.0f32; width];
    for y in 0..height {
        let taps: [usize; 5] = std::array::from_fn(|k| (y as isize + (k as isize - 2) * mult as isize).clamp(0, height as isize - 1) as usize);
        let rows: [&[f32]; 5] = taps.map(|t| &input[t * width..(t + 1) * width]);
        for (x, v) in column.iter_mut().enumerate() {
            *v = (FILTER[0] * rows[0][x] + FILTER[1] * rows[1][x] + FILTER[2] * rows[2][x] + FILTER[3] * rows[3][x] + FILTER[4] * rows[4][x]).max(0.0);
        }
        padded_row(row, &column, 2 * mult);
        let out = &mut lf[y * width..(y + 1) * width];
        for (x, o) in out.iter_mut().enumerate() {
            *o = (FILTER[0] * row[x] + FILTER[1] * row[x + mult] + FILTER[2] * row[x + 2 * mult] + FILTER[3] * row[x + 3 * mult] + FILTER[4] * row[x + 4 * mult]).max(0.0);
        }
        let inp = &input[y * width..(y + 1) * width];
        for ((h, &i), &l) in hf[y * width..(y + 1) * width].iter_mut().zip(inp).zip(out.iter()) {
            *h = i - l;
        }
    }
}

// ── Inpainting noise (upstream's `inpaint_mask`, `iop/noise_generator.h`) ─────────

fn splitmix32(seed: u64) -> u32 {
    let r = (seed ^ (seed >> 33)).wrapping_mul(0x62a9_d9ed_7997_05f5);
    let r = (r ^ (r >> 28)).wrapping_mul(0xcb24_d0a5_c88c_35b3);
    (r >> 32) as u32
}

fn xoshiro128plus(state: &mut [u32; 4]) -> f32 {
    let result = state[0].wrapping_add(state[3]);
    let t = state[1] << 9;
    state[2] ^= state[0];
    state[3] ^= state[1];
    state[1] ^= state[2];
    state[0] ^= state[3];
    state[2] ^= t;
    state[3] = state[3].rotate_left(11);
    (result >> 8) as f32 * (1.0 / 16_777_216.0)
}

fn gaussian_noise(mu: f32, sigma: f32, flip: bool, state: &mut [u32; 4]) -> f32 {
    let u1 = xoshiro128plus(state).max(f32::MIN_POSITIVE);
    let u2 = xoshiro128plus(state);
    let r = (-2.0 * u1.ln()).sqrt();
    let angle = 2.0 * std::f32::consts::PI * u2;
    let noise = if flip { r * angle.cos() } else { r * angle.sin() };
    noise * sigma + mu
}

/// Replace the pixels inside the mask with Gaussian noise of their own value as mean
/// and deviation, the diffusion's starting point for reconstructing them.
fn inpaint(planes: &mut [Vec<f32>; 3], mask: &[bool], width: usize, origin: (usize, usize)) {
    for k in (0..mask.len()).filter(|&k| mask[k]) {
        let (i, j) = ((k / width + origin.1) as u64, (k % width + origin.0) as u64);
        let mut state = [splitmix32(j + 1), splitmix32((j + 1) * (i + 3)), splitmix32(1337), splitmix32(666)];
        for _ in 0..4 {
            xoshiro128plus(&mut state);
        }
        let flip = i % 2 == 1 || j % 2 == 1;
        for plane in planes.iter_mut() {
            let v = plane[k];
            plane[k] = gaussian_noise(v, v, flip, &mut state).abs();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: usize, height: usize, f: impl Fn(usize, usize) -> [f32; 3]) -> Image {
        let mut img = Image::new(width, height);
        for y in 0..height {
            for x in 0..width {
                img.pixels[y * width + x] = f(x, y);
            }
        }
        img
    }

    /// A noisy edge: dark left half, bright right half, with a deterministic texture.
    fn edge(width: usize, height: usize) -> Image {
        image(width, height, |x, y| {
            let base = if x < width / 2 { 0.05 } else { 0.4 };
            let t = (((x * 7919 + y * 104_729) % 97) as f32 / 97.0 - 0.5) * 0.04;
            [base + t, (base + t) * 0.9, (base + t) * 0.8]
        })
    }

    /// Sum of squared differences between horizontal neighbours: the image's detail.
    fn detail(img: &Image) -> f64 {
        let mut s = 0.0;
        for y in 0..img.height {
            for x in 1..img.width {
                let (a, b) = (img.get(x - 1, y), img.get(x, y));
                s += ((a[1] - b[1]) as f64).powi(2);
            }
        }
        s
    }

    /// Upstream's kernel, built and convolved as in `compute_kernel` / `build_matrix`.
    fn reference_derivative(b: &[f32; 9], cc: f32, ss: f32, cs: f32, c2: f32, anisotropy: f32) -> f32 {
        let kernel: [f32; 9] = if anisotropy == 0.0 {
            [0.25, 0.5, 0.25, 0.5, -3.0, 0.5, 0.25, 0.5, 0.25]
        } else {
            let (a00, a11, a01) =
                if anisotropy > 0.0 { (cc + c2 * ss, c2 * cc + ss, (c2 - 1.0) * cs) } else { (c2 * cc + ss, cc + c2 * ss, (1.0 - c2) * cs) };
            let b11 = a01 * 0.5;
            [b11, a11, -b11, a00, -2.0 * (a00 + a11), a00, -b11, a11, b11]
        };
        kernel.iter().zip(b).map(|(k, v)| k * v).sum()
    }

    #[test]
    fn expanded_kernels_match_upstream() {
        let b = [0.3, 0.7, 0.2, 0.9, 0.5, 0.1, 0.4, 0.8, 0.6];
        let (cc, ss, cs, _) = orientation(&b);
        for anisotropy in [0.0, 2.0, -3.0] {
            let p = Diffuse { anisotropy1: anisotropy, speed1: 1.0, ..Diffuse::default() };
            let op = DiffuseOp::new(&p, 1.0);
            let k = Kernels::new(&op, &op.bands[0]);
            for c2 in [1.0, 0.6, 0.05] {
                let ours = k.derivative(0, Sums::of(&b), (cc, ss, cs), c2);
                let theirs = reference_derivative(&b, cc, ss, cs, c2, anisotropy);
                assert!((ours - theirs).abs() < 1e-6, "anisotropy {anisotropy}, c2 {c2}: {ours} vs {theirs}");
            }
        }
    }

    #[test]
    fn chunks_match_pixels() {
        let p = Diffuse { anisotropy1: 2.0, anisotropy2: -1.0, anisotropy3: 0.0, anisotropy4: 3.0, edge_sensitivity: 1.5, sharpness: 0.3, ..deblur() };
        let op = DiffuseOp::new(&p, 1.0);
        let k = Kernels::new(&op, &op.bands[1]);
        let n = 70;
        let value = |t: usize, i: usize, salt: usize| (((t * 31 + i * 17 + salt * 7) % 23) as f32 / 23.0) * 0.5 + 0.01;
        let l: Vec<Vec<f32>> = (0..9).map(|t| (0..n).map(|i| value(t, i, 1)).collect()).collect();
        let h: Vec<Vec<f32>> = (0..9).map(|t| (0..n).map(|i| value(t, i, 2) - 0.25).collect()).collect();
        let r: Vec<Vec<f32>> = (0..9).map(|t| (0..n).map(|i| value(t, i, 3)).collect()).collect();
        let slices = |v: &Vec<Vec<f32>>, s: usize, e: usize| -> [Vec<f32>; 9] { std::array::from_fn(|t| v[t][s..e].to_vec()) };
        for (s, e) in [(0, 64), (64, 70)] {
            let (lc, hc, rc) = (slices(&l, s, e), slices(&h, s, e), slices(&r, s, e));
            let mut out = vec![0.0; e - s];
            k.chunk(&lc.each_ref().map(|v| v.as_slice()), &hc.each_ref().map(|v| v.as_slice()), &rc.each_ref().map(|v| v.as_slice()), &mut out);
            for i in 0..e - s {
                let lp: [f32; 9] = std::array::from_fn(|t| lc[t][i]);
                let hp: [f32; 9] = std::array::from_fn(|t| hc[t][i]);
                let energy: f32 = (0..9).map(|t| rc[t][i]).sum();
                let want = k.pixel(&lp, &hp, energy);
                assert!((out[i] - want).abs() <= 1e-5 * want.abs().max(1.0), "{i}: {} vs {want}", out[i]);
            }
        }
    }

    fn deblur() -> Diffuse {
        Diffuse { iterations: 16.0, radius: 10.0, speed1: -0.25, speed2: 0.125, speed3: -0.125, speed4: 0.0625, ..Diffuse::default() }
    }

    #[test]
    fn fast_exp_matches_upstream() {
        assert_eq!(fast_exp(-200.0), 0.0);
        assert_eq!(fast_exp(f32::NEG_INFINITY), 0.0);
        assert_eq!(fast_exp(f32::NAN), 0.0);
        assert!((fast_exp(0.0) - 1.0).abs() < 0.07);
        // The bits upstream's C gives (gcc, x86-64).
        assert_eq!(fast_exp(0.0).to_bits(), 1_065_353_216);
        assert_eq!(fast_exp(-1.0).to_bits(), 1_053_951_936);
        assert_eq!(fast_exp(-2.5).to_bits(), 1_036_849_984);
    }

    #[test]
    fn scales_follow_the_radius_and_the_render_scale() {
        let p = Diffuse { radius: 8.0, radius_center: 0.0, speed1: 1.0, ..Diffuse::default() };
        let full = DiffuseOp::new(&p, 1.0).bands.len();
        let quarter = DiffuseOp::new(&p, 0.25).bands.len();
        assert!(full > quarter, "{full} vs {quarter}");
        let wide = Diffuse { radius: 512.0, radius_center: 512.0, ..p };
        assert_eq!(DiffuseOp::new(&wide, 1.0).bands.len(), MAX_SCALES);
    }

    #[test]
    fn neutral_parameters_do_nothing() {
        let op = DiffuseOp::new(&Diffuse { speed1: 0.0, speed2: 0.0, speed3: 0.0, speed4: 0.0, sharpness: 0.0, ..Diffuse::default() }, 1.0);
        assert!(!op.active());
        assert_eq!(op.reach(), 0);
        let mut img = edge(40, 30);
        let before = img.pixels.clone();
        op.apply(&mut img, (0, 0));
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn positive_speeds_diffuse_and_negative_ones_sharpen() {
        let base = Diffuse { iterations: 4.0, radius: 4.0, radius_center: 0.0, edge_sensitivity: 0.0, ..Diffuse::default() };
        let original = edge(64, 48);
        let run = |speed: f32| {
            let p = Diffuse { speed1: speed, speed2: speed, speed3: speed, speed4: speed, ..base };
            let mut img = original.clone();
            DiffuseOp::new(&p, 1.0).apply(&mut img, (0, 0));
            assert!(img.pixels.iter().flatten().all(|v| v.is_finite() && *v >= 0.0));
            detail(&img)
        };
        let d = detail(&original);
        assert!(run(0.5) < d * 0.8, "diffusion should remove detail");
        assert!(run(-0.25) > d * 1.1, "sharpening should add detail");
    }

    #[test]
    fn regions_get_the_same_inpainting_noise() {
        // Every pixel above the threshold: the noise must depend on frame coordinates.
        let p = Diffuse { luminance_threshold: 0.01, speed4: 0.5, anisotropy4: 2.0, iterations: 1.0, radius: 2.0, ..Diffuse::default() };
        let op = DiffuseOp::new(&p, 1.0);
        let whole = image(48, 48, |_, _| [0.5, 0.5, 0.5]);
        let mut a = whole.clone();
        let mut planes: [Vec<f32>; 3] = std::array::from_fn(|c| a.pixels.iter().map(|px| px[c]).collect());
        inpaint(&mut planes, &vec![true; 48 * 48], 48, (0, 0));
        let mut part: [Vec<f32>; 3] = std::array::from_fn(|_| vec![0.5; 16 * 16]);
        inpaint(&mut part, &vec![true; 16 * 16], 16, (20, 10));
        for y in 0..16 {
            for x in 0..16 {
                assert_eq!(part[1][y * 16 + x], planes[1][(y + 10) * 48 + x + 20]);
            }
        }
        op.apply(&mut a, (0, 0));
        assert!(a.pixels.iter().flatten().all(|v| v.is_finite()));
    }
}
