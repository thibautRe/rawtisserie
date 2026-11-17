//! Loader and CPU executor for the `.anselnn` denoising networks (roadmap 3.5).
//!
//! A port of Ansel's `src/common/nn_model.c` (GPL-3.0-or-later), at upstream
//! `248dcec22` (2026-11-17), for the models trained in
//! [ansel-denoise](https://github.com/aurelienpierreeng/ansel-denoise). Like upstream it
//! knows nothing about the pipeline: planar `f32` planes in, planes out.
//!
//! File format (little-endian): the magic `ANSELDN1`, a `u32` JSON header length, the
//! JSON header (`{"cfg": …, "tensors": [{name, shape, offset, size}, …]}`), then the
//! `f32` tensors, offsets relative to the payload.
//!
//! Topology ("unet"): `depth` encoder levels of two 3×3 conv + GELU with a 2×2 stride-2
//! conv between levels, a two-conv bottleneck, then per level a 1×1 conv, a nearest ×2
//! upsample, the skip concatenated, and two 3×3 conv + GELU; a final 3×3 conv predicts
//! the noise. "unet-ms" adds a coarse net on superpixel-binned RGB whose output guides
//! the fine one.
//!
//! Deviations from upstream:
//! - single-threaded (no OpenMP); the caller tiles and may spread tiles over workers;
//! - 3×3 convolutions (nearly all the work) use a register-blocked kernel, 8 output
//!   channels × 4 pixels, on zero-padded copies of their input (the decoder's concat
//!   materialised, its half-resolution part upsampled). Each output still accumulates
//!   in upstream's (ic, ky, kx) order with separate multiply and add, so the results
//!   are the same; wasm gets explicit SIMD there, as V8 spills the portable version;
//! - GELU's `erf` is a branch-free rational approximation (Eigen's), within 4·10⁻⁷ of
//!   fdlibm's, so it vectorises; upstream calls the platform's `erff`.
//!
//! Against upstream's PyTorch fixture (`tests/nn_parity.rs`): 2·10⁻⁷ max abs error,
//! natively and in wasm (tolerance 2·10⁻⁴).

use serde_json::Value;

const MAGIC: &[u8; 8] = b"ANSELDN1";
const MAX_DEPTH: usize = 8;
/// Output channels computed together in the convolution's inner loop (upstream's
/// `NN_OC_BLOCK`): each input value feeds that many accumulators.
const OC_BLOCK: usize = 4;
/// The 3×3 kernel's register block: output channels × pixels.
const KB_OC: usize = 8;
const KB_PX: usize = 4;
/// Scales of the low-band fusion pyramid, in photosites (`DT_NN_FUSION_FINEST`/`COARSEST`).
pub const FUSION_FINEST: usize = 16;
pub const FUSION_COARSEST: usize = 64;

#[derive(Debug, thiserror::Error)]
#[error("invalid denoising model: {0}")]
pub struct ModelError(String);

fn err<T>(msg: impl Into<String>) -> Result<T, ModelError> {
    Err(ModelError(msg.into()))
}

/// One convolution: weights `(out_ch, in_ch, k, k)` and biases, as offsets in the blob.
#[derive(Debug, Clone, Copy, Default)]
struct Conv {
    w: usize,
    b: usize,
    out_ch: usize,
    in_ch: usize,
    k: usize,
}

#[derive(Debug, Clone, Default)]
struct Unet {
    base: usize,
    depth: usize,
    in_ch: usize,
    out_ch: usize,
    enc1: Vec<Conv>,
    enc2: Vec<Conv>,
    down: Vec<Conv>,
    bot1: Conv,
    bot2: Conv,
    up: Vec<Conv>,
    dec1: Vec<Conv>,
    dec2: Vec<Conv>,
    head: Conv,
}

/// The size of one net.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetConfig {
    pub base: usize,
    pub depth: usize,
    pub in_channels: usize,
    pub out_channels: usize,
}

#[derive(Debug)]
pub struct Model {
    fine: Unet,
    coarse: Option<Unet>,
    bin_bayer: usize,
    bin_xtrans: usize,
    anchor: usize,
    blob: Vec<f32>,
}

struct Tensors<'a> {
    list: &'a [Value],
    payload_len: usize,
}

impl Tensors<'_> {
    fn find(&self, name: &str, floats: usize) -> Result<usize, ModelError> {
        for t in self.list {
            if t.get("name").and_then(Value::as_str) != Some(name) {
                continue;
            }
            let (Some(offset), Some(size)) = (t.get("offset").and_then(Value::as_u64), t.get("size").and_then(Value::as_u64)) else {
                return err(format!("tensor {name} without offset or size"));
            };
            let (offset, size) = (offset as usize, size as usize);
            if size != floats * 4 || offset % 4 != 0 || offset + size > self.payload_len {
                return err(format!("tensor {name} has an unexpected size or offset"));
            }
            return Ok(offset / 4);
        }
        err(format!("missing tensor {name}"))
    }

    fn conv(&self, prefix: &str, out_ch: usize, in_ch: usize, k: usize) -> Result<Conv, ModelError> {
        let w = self.find(&format!("{prefix}.weight"), out_ch * in_ch * k * k)?;
        let b = self.find(&format!("{prefix}.bias"), out_ch)?;
        Ok(Conv { w, b, out_ch, in_ch, k })
    }

    /// One U-Net, by PyTorch state-dict names (`stage` is "" for "unet", "fine." or
    /// "coarse." for "unet-ms").
    fn unet(&self, stage: &str, c: NetConfig) -> Result<Unet, ModelError> {
        let NetConfig { base, depth, in_channels, out_channels } = c;
        let mut u = Unet { base, depth, in_ch: in_channels, out_ch: out_channels, ..Default::default() };
        let mut cin = in_channels;
        for l in 0..depth {
            let w = base << l;
            u.enc1.push(self.conv(&format!("{stage}enc.{l}.0"), w, cin, 3)?);
            u.enc2.push(self.conv(&format!("{stage}enc.{l}.2"), w, w, 3)?);
            u.down.push(self.conv(&format!("{stage}down.{l}"), w, w, 2)?);
            cin = w;
        }
        let wb = base << depth;
        u.bot1 = self.conv(&format!("{stage}bottleneck.0"), wb, base << (depth - 1), 3)?;
        u.bot2 = self.conv(&format!("{stage}bottleneck.2"), wb, wb, 3)?;
        // The decoder lists were built from the deepest level up: up.0/dec.0 work on
        // the bottleneck's output, up.(depth-1)/dec.(depth-1) on level 0's.
        for i in 0..depth {
            let w_skip = base << (depth - 1 - i);
            u.up.push(self.conv(&format!("{stage}up.{i}"), w_skip, 2 * w_skip, 1)?);
            u.dec1.push(self.conv(&format!("{stage}dec.{i}.0"), w_skip, 2 * w_skip, 3)?);
            u.dec2.push(self.conv(&format!("{stage}dec.{i}.2"), w_skip, w_skip, 3)?);
        }
        u.head = self.conv(&format!("{stage}head"), out_channels, base, 3)?;
        Ok(u)
    }
}

fn net_config(cfg: Option<&Value>, out_max: usize) -> Result<NetConfig, ModelError> {
    let get = |k: &str| cfg.and_then(|c| c.get(k)).and_then(Value::as_u64).map(|v| v as usize);
    let (Some(base), Some(depth), Some(in_channels), Some(out_channels)) = (get("base"), get("depth"), get("in_channels"), get("out_channels")) else {
        return err("incomplete net configuration");
    };
    if !(1..=512).contains(&base) || !(1..=MAX_DEPTH).contains(&depth) || !(1..=16).contains(&in_channels) || !(1..=out_max).contains(&out_channels) {
        return err("net configuration out of the supported range");
    }
    Ok(NetConfig { base, depth, in_channels, out_channels })
}

fn gcd(a: usize, b: usize) -> usize {
    if b == 0 { a } else { gcd(b, a % b) }
}

fn lcm(a: usize, b: usize) -> usize {
    if a == 0 || b == 0 { a.max(b) } else { a / gcd(a, b) * b }
}

impl Model {
    pub fn from_bytes(bytes: &[u8]) -> Result<Model, ModelError> {
        if bytes.len() < 12 || &bytes[..8] != MAGIC {
            return err("not an ANSELDN1 file");
        }
        let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        if header_len == 0 || header_len > 64 << 20 || bytes.len() < 12 + header_len {
            return err("truncated header");
        }
        let header: Value = serde_json::from_slice(&bytes[12..12 + header_len]).map_err(|e| ModelError(format!("header: {e}")))?;
        let payload = &bytes[12 + header_len..];
        let (Some(cfg), Some(list)) = (header.get("cfg"), header.get("tensors").and_then(Value::as_array)) else {
            return err("header without cfg or tensors");
        };
        let tensors = Tensors { list, payload_len: payload.len() };
        let (fine, coarse, bin_bayer, bin_xtrans, anchor) = match cfg.get("arch").and_then(Value::as_str) {
            Some("unet") => (tensors.unet("", net_config(Some(cfg), 1)?)?, None, 1, 1, 0),
            Some("unet-ms") => {
                let bin = |k: &str| cfg.get("bin").and_then(|b| b.get(k)).and_then(Value::as_u64).map(|v| v as usize);
                let (Some(bayer), Some(xtrans)) = (bin("bayer"), bin("xtrans")) else {
                    return err("missing bin factors");
                };
                if !(2..=16).contains(&bayer) || !(2..=16).contains(&xtrans) {
                    return err("bin factors out of the supported range");
                }
                let anchor = cfg.get("anchor").and_then(Value::as_u64).map(|a| a as usize).filter(|a| (8..=256).contains(a)).unwrap_or(0);
                let fine = tensors.unet("fine.", net_config(cfg.get("fine"), 1)?)?;
                let coarse = tensors.unet("coarse.", net_config(cfg.get("coarse"), 8)?)?;
                (fine, Some(coarse), bayer, xtrans, anchor)
            }
            _ => return err("unsupported architecture"),
        };
        // `sigma_calibration` in the cfg is deliberately ignored, as upstream does: the
        // σ map's scaling is entirely the module's (visible) parameters.
        let blob = payload.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        Ok(Model { fine, coarse, bin_bayer, bin_xtrans, anchor, blob })
    }

    /// Input planes of the fine net: 5 for "unet" (mosaic, R, G, B one-hot, σ), 8 for
    /// "unet-ms" (plus the coarse net's RGB, upsampled).
    pub fn in_channels(&self) -> usize {
        self.fine.in_ch
    }

    pub fn fine_config(&self) -> NetConfig {
        let u = &self.fine;
        NetConfig { base: u.base, depth: u.depth, in_channels: u.in_ch, out_channels: u.out_ch }
    }

    pub fn coarse_config(&self) -> Option<NetConfig> {
        self.coarse.as_ref().map(|u| NetConfig { base: u.base, depth: u.depth, in_channels: u.in_ch, out_channels: u.out_ch })
    }

    /// Superpixel size of the coarse stage for the sensor's CFA family, 1 without one.
    pub fn bin(&self, xtrans: bool) -> usize {
        match (&self.coarse, xtrans) {
            (None, _) => 1,
            (Some(_), true) => self.bin_xtrans,
            (Some(_), false) => self.bin_bayer,
        }
    }

    /// Scale (photosites) below which the output's low band is anchored to the input's,
    /// 0 for none.
    pub fn anchor(&self) -> usize {
        self.anchor
    }

    /// What the width and height given to [`Model::forward`] must be multiples of, for
    /// either CFA family (upstream's `dt_nn_model_alignment`).
    pub fn alignment(&self) -> usize {
        let mut align = 1 << self.fine.depth;
        if let Some(c) = &self.coarse {
            align = lcm(align, self.bin_bayer << c.depth);
            align = lcm(align, self.bin_xtrans << c.depth);
        }
        if self.anchor > 0 {
            align = lcm(align, FUSION_COARSEST);
        }
        align
    }

    /// Runs one stage on planar `input` (`width × height`, multiples of the stage's
    /// `2^depth`). `coarse` picks the coarse net (input: binned R, G, B and their σ;
    /// output: 3 planes), else the fine one (output: 1 plane). With `residual` the head
    /// is subtracted from the matching input planes (the denoised signal), else the raw
    /// head (the predicted noise) is returned.
    pub fn forward(&self, coarse: bool, input: &[f32], width: usize, height: usize, residual: bool) -> Option<Vec<f32>> {
        let u = if coarse { self.coarse.as_ref()? } else { &self.fine };
        let align = 1 << u.depth;
        if width == 0 || height == 0 || width % align != 0 || height % align != 0 || input.len() < u.in_ch * width * height {
            return None;
        }
        Some(self.unet_forward(u, input, width, height, residual))
    }

    fn unet_forward(&self, u: &Unet, input: &[f32], width: usize, height: usize, residual: bool) -> Vec<f32> {
        let wh = width * height;
        let mut skips: Vec<Vec<f32>> = Vec::with_capacity(u.depth);
        let (mut cw, mut ch) = (width, height);
        let mut cur: Option<Vec<f32>> = None;

        for l in 0..u.depth {
            let src = cur.as_deref().unwrap_or(input);
            let mut tmp = vec![0.0; u.enc1[l].out_ch * cw * ch];
            self.conv3(&u.enc1[l], src, cw, ch, &mut tmp);
            gelu(&mut tmp);
            let mut skip = vec![0.0; u.enc2[l].out_ch * cw * ch];
            self.conv3(&u.enc2[l], &tmp, cw, ch, &mut skip);
            gelu(&mut skip);
            drop(tmp);
            let mut next = vec![0.0; u.down[l].out_ch * (cw / 2) * (ch / 2)];
            self.conv2d(&u.down[l], &skip, cw, ch, 2, 0, &mut next);
            skips.push(skip);
            cur = Some(next);
            cw /= 2;
            ch /= 2;
        }

        let src = cur.take().unwrap();
        let mut tmp = vec![0.0; u.bot1.out_ch * cw * ch];
        self.conv3(&u.bot1, &src, cw, ch, &mut tmp);
        gelu(&mut tmp);
        drop(src);
        let mut x = vec![0.0; u.bot2.out_ch * cw * ch];
        self.conv3(&u.bot2, &tmp, cw, ch, &mut x);
        gelu(&mut x);
        drop(tmp);

        for i in 0..u.depth {
            let l = u.depth - 1 - i;
            // The 1×1 conv runs before the nearest upsample: same values, a quarter of
            // the pixels.
            let mut v = vec![0.0; u.up[i].out_ch * cw * ch];
            self.conv2d(&u.up[i], &x, cw, ch, 1, 0, &mut v);
            drop(x);
            cw *= 2;
            ch *= 2;
            let skip = std::mem::take(&mut skips[l]);
            let mut d1 = vec![0.0; u.dec1[i].out_ch * cw * ch];
            self.conv3_cat2(&u.dec1[i], &skip, u.base << l, &v, cw, ch, &mut d1);
            gelu(&mut d1);
            drop((v, skip));
            let mut d2 = vec![0.0; u.dec2[i].out_ch * cw * ch];
            self.conv3(&u.dec2[i], &d1, cw, ch, &mut d2);
            gelu(&mut d2);
            x = d2;
        }

        let mut head = vec![0.0; u.out_ch * wh];
        self.conv3(&u.head, &x, width, height, &mut head);
        if residual {
            for (h, i) in head.iter_mut().zip(input) {
                *h = i - *h;
            }
        }
        head
    }

    /// A 3×3, stride 1, zero-padded conv: the register-blocked kernel when the output
    /// channels allow it, else [`Model::conv2d`].
    fn conv3(&self, cv: &Conv, input: &[f32], w: usize, h: usize, out: &mut [f32]) {
        if cv.out_ch % KB_OC != 0 {
            return self.conv2d(cv, input, w, h, 1, 1, out);
        }
        let mut padded = vec![0.0f32; cv.in_ch * (w + 2) * (h + 2)];
        pad_into(&mut padded, input, cv.in_ch, w, h);
        self.conv3_padded(cv, &padded, w, h, out);
    }

    /// [`Model::conv3`] over the concatenation of `a` (`in_ch_a` channels) and `b` (the
    /// rest, half resolution, nearest-upsampled).
    #[allow(clippy::too_many_arguments)]
    fn conv3_cat2(&self, cv: &Conv, a: &[f32], in_ch_a: usize, b: &[f32], w: usize, h: usize, out: &mut [f32]) {
        if cv.out_ch % KB_OC != 0 {
            return self.conv2d_cat2(cv, a, in_ch_a, b, w, h, out);
        }
        let pplane = (w + 2) * (h + 2);
        let mut padded = vec![0.0f32; cv.in_ch * pplane];
        pad_into(&mut padded[..in_ch_a * pplane], a, in_ch_a, w, h);
        let (bw, bh) = (w / 2, h / 2);
        for c in 0..cv.in_ch - in_ch_a {
            let plane = &b[c * bw * bh..(c + 1) * bw * bh];
            let dst = &mut padded[(in_ch_a + c) * pplane..(in_ch_a + c + 1) * pplane];
            for y in 0..h {
                let brow = &plane[(y >> 1) * bw..][..bw];
                for (x, d) in dst[(y + 1) * (w + 2) + 1..][..w].iter_mut().enumerate() {
                    *d = brow[x >> 1];
                }
            }
        }
        self.conv3_padded(cv, &padded, w, h, out);
    }

    /// The 3×3 kernel on a 1-pixel zero-padded input: `KB_OC` output channels × `KB_PX`
    /// pixels accumulate in registers, each in upstream's (ic, ky, kx) order, so the
    /// results are the same as [`Model::conv2d`]'s.
    fn conv3_padded(&self, cv: &Conv, padded: &[f32], w: usize, h: usize, out: &mut [f32]) {
        let (pw, pplane) = (w + 2, (w + 2) * (h + 2));
        let in_ch = cv.in_ch;
        // Weights repacked as [block][ic][tap][KB_OC].
        let mut packed = vec![0.0f32; cv.out_ch * in_ch * 9];
        for blk in 0..cv.out_ch / KB_OC {
            for ic in 0..in_ch {
                for t in 0..9 {
                    for o in 0..KB_OC {
                        packed[((blk * in_ch + ic) * 9 + t) * KB_OC + o] = self.blob[cv.w + ((blk * KB_OC + o) * in_ch + ic) * 9 + t];
                    }
                }
            }
        }
        for blk in 0..cv.out_ch / KB_OC {
            let wb = &packed[blk * in_ch * 9 * KB_OC..][..in_ch * 9 * KB_OC];
            let bias: [f32; KB_OC] = std::array::from_fn(|o| self.blob[cv.b + blk * KB_OC + o]);
            for oy in 0..h {
                let mut x0 = 0;
                while x0 + KB_PX <= w {
                    let acc = kernel_block(wb, padded, oy * pw + x0, pw, pplane, in_ch, &bias);
                    for o in 0..KB_OC {
                        out[(blk * KB_OC + o) * w * h + oy * w + x0..][..KB_PX].copy_from_slice(&acc[o]);
                    }
                    x0 += KB_PX;
                }
                for x in x0..w {
                    for o in 0..KB_OC {
                        let mut a = bias[o];
                        for ic in 0..in_ch {
                            for ky in 0..3 {
                                for kx in 0..3 {
                                    a += wb[(ic * 9 + ky * 3 + kx) * KB_OC + o] * padded[ic * pplane + (oy + ky) * pw + x + kx];
                                }
                            }
                        }
                        out[(blk * KB_OC + o) * w * h + oy * w + x] = a;
                    }
                }
            }
        }
    }

    /// `out[oc] = bias[oc] + Σ_ic conv(in[ic])`, zero padding. Upstream's `_conv2d`:
    /// output rows `OC_BLOCK` channels at a time, accumulated in (ic, ky, kx) order.
    #[allow(clippy::too_many_arguments)]
    fn conv2d(&self, cv: &Conv, input: &[f32], w: usize, h: usize, stride: usize, pad: usize, out: &mut [f32]) {
        let k = cv.k;
        let ow = (w + 2 * pad - k) / stride + 1;
        let oh = (h + 2 * pad - k) / stride + 1;
        let inhw = w * h;
        let mut acc = vec![0.0f32; OC_BLOCK * ow];
        for oy in 0..oh {
            for ocb in (0..cv.out_ch).step_by(OC_BLOCK) {
                let nb = OC_BLOCK.min(cv.out_ch - ocb);
                self.init_bias(cv, ocb, nb, ow, &mut acc);
                for ic in 0..cv.in_ch {
                    let plane = &input[ic * inhw..(ic + 1) * inhw];
                    for ky in 0..k {
                        let iy = (oy * stride + ky) as isize - pad as isize;
                        if iy < 0 || iy >= h as isize {
                            continue;
                        }
                        let row = &plane[iy as usize * w..(iy as usize + 1) * w];
                        for kx in 0..k {
                            let shift = kx as isize - pad as isize;
                            let wi = cv.w + (ocb * cv.in_ch + ic) * k * k + ky * k + kx;
                            if stride == 1 {
                                self.accumulate_row(cv, wi, nb, ow, row, shift, &mut acc);
                            } else {
                                self.accumulate_strided(cv, wi, nb, ow, row, shift, stride, &mut acc);
                            }
                        }
                    }
                }
                for r in 0..nb {
                    out[((ocb + r) * oh + oy) * ow..][..ow].copy_from_slice(&acc[r * ow..(r + 1) * ow]);
                }
            }
        }
    }

    /// [`Model::conv2d`] for a 3×3 conv over the concatenation of `a` (`in_ch_a`
    /// channels, full resolution) and `b` (the rest, half resolution, nearest-upsampled).
    #[allow(clippy::too_many_arguments)]
    fn conv2d_cat2(&self, cv: &Conv, a: &[f32], in_ch_a: usize, b: &[f32], w: usize, h: usize, out: &mut [f32]) {
        let k = cv.k;
        let pad = 1;
        let inhw = w * h;
        let bw = w / 2;
        let bhw = bw * (h / 2);
        let mut acc = vec![0.0f32; OC_BLOCK * w];
        let mut upsampled = vec![0.0f32; w];
        for oy in 0..h {
            for ocb in (0..cv.out_ch).step_by(OC_BLOCK) {
                let nb = OC_BLOCK.min(cv.out_ch - ocb);
                self.init_bias(cv, ocb, nb, w, &mut acc);
                for ic in 0..cv.in_ch {
                    for ky in 0..k {
                        let iy = (oy + ky) as isize - pad;
                        if iy < 0 || iy >= h as isize {
                            continue;
                        }
                        let iy = iy as usize;
                        let row: &[f32] = if ic < in_ch_a {
                            &a[ic * inhw + iy * w..][..w]
                        } else {
                            let brow = &b[(ic - in_ch_a) * bhw + (iy >> 1) * bw..][..bw];
                            for (x, u) in upsampled.iter_mut().enumerate() {
                                *u = brow[x >> 1];
                            }
                            &upsampled
                        };
                        for kx in 0..k {
                            let shift = kx as isize - pad;
                            let wi = cv.w + (ocb * cv.in_ch + ic) * k * k + ky * k + kx;
                            self.accumulate_row(cv, wi, nb, w, row, shift, &mut acc);
                        }
                    }
                }
                for r in 0..nb {
                    out[(ocb + r) * inhw + oy * w..][..w].copy_from_slice(&acc[r * w..(r + 1) * w]);
                }
            }
        }
    }

    fn init_bias(&self, cv: &Conv, ocb: usize, nb: usize, ow: usize, acc: &mut [f32]) {
        for r in 0..nb {
            acc[r * ow..(r + 1) * ow].fill(self.blob[cv.b + ocb + r]);
        }
    }

    /// `acc[r][ox] += w[r] · row[ox + shift]` for the output columns whose tap is inside
    /// the row (stride 1).
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    fn accumulate_row(&self, cv: &Conv, wi: usize, nb: usize, ow: usize, row: &[f32], shift: isize, acc: &mut [f32]) {
        let ox0 = (-shift).max(0) as usize;
        let ox1 = (row.len() as isize - shift).min(ow as isize).max(ox0 as isize) as usize;
        let n = ox1 - ox0;
        let src = &row[(ox0 as isize + shift) as usize..][..n];
        let wstride = cv.in_ch * cv.k * cv.k;
        if nb == OC_BLOCK {
            let ws = [0, 1, 2, 3].map(|r| self.blob[wi + r * wstride]);
            let (a0, rest) = acc.split_at_mut(ow);
            let (a1, rest) = rest.split_at_mut(ow);
            let (a2, a3) = rest.split_at_mut(ow);
            let (a0, a1, a2, a3) = (&mut a0[ox0..ox1], &mut a1[ox0..ox1], &mut a2[ox0..ox1], &mut a3[ox0..ox1]);
            for i in 0..n {
                let x = src[i];
                a0[i] += ws[0] * x;
                a1[i] += ws[1] * x;
                a2[i] += ws[2] * x;
                a3[i] += ws[3] * x;
            }
        } else {
            for r in 0..nb {
                let wr = self.blob[wi + r * wstride];
                let a = &mut acc[r * ow + ox0..r * ow + ox1];
                for (a, x) in a.iter_mut().zip(src) {
                    *a += wr * x;
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn accumulate_strided(&self, cv: &Conv, wi: usize, nb: usize, ow: usize, row: &[f32], shift: isize, stride: usize, acc: &mut [f32]) {
        let wstride = cv.in_ch * cv.k * cv.k;
        for r in 0..nb {
            let wr = self.blob[wi + r * wstride];
            let a = &mut acc[r * ow..(r + 1) * ow];
            for (ox, a) in a.iter_mut().enumerate() {
                let ix = (ox * stride) as isize + shift;
                if ix >= 0 && (ix as usize) < row.len() {
                    *a += wr * row[ix as usize];
                }
            }
        }
    }
}

/// One register block of the 3×3 kernel: `KB_OC` output channels × `KB_PX` pixels
/// starting at `base` in the padded planes, accumulated in (ic, ky, kx) order.
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn kernel_block(wb: &[f32], padded: &[f32], base: usize, pw: usize, pplane: usize, in_ch: usize, bias: &[f32; KB_OC]) -> [[f32; KB_PX]; KB_OC] {
    let mut acc: [[f32; KB_PX]; KB_OC] = std::array::from_fn(|o| [bias[o]; KB_PX]);
    for ic in 0..in_ch {
        let wic = &wb[ic * 9 * KB_OC..][..9 * KB_OC];
        for ky in 0..3 {
            let row = &padded[ic * pplane + base + ky * pw..][..KB_PX + 2];
            for kx in 0..3 {
                let ws = &wic[(ky * 3 + kx) * KB_OC..][..KB_OC];
                let xs: [f32; KB_PX] = std::array::from_fn(|p| row[kx + p]);
                for o in 0..KB_OC {
                    for p in 0..KB_PX {
                        acc[o][p] += ws[o] * xs[p];
                    }
                }
            }
        }
    }
    acc
}

/// [`kernel_block`] with explicit wasm SIMD: V8 doesn't keep the portable version's
/// accumulators in registers. Separate multiply and add, so the results are the same.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
fn kernel_block(wb: &[f32], padded: &[f32], base: usize, pw: usize, pplane: usize, in_ch: usize, bias: &[f32; KB_OC]) -> [[f32; KB_PX]; KB_OC] {
    use std::arch::wasm32::*;
    const _: () = assert!(KB_PX == 4 && KB_OC == 8);
    let mut acc: [v128; KB_OC] = std::array::from_fn(|o| f32x4_splat(bias[o]));
    for ic in 0..in_ch {
        let wic = &wb[ic * 9 * KB_OC..][..9 * KB_OC];
        for ky in 0..3 {
            let row = &padded[ic * pplane + base + ky * pw..][..KB_PX + 2];
            for kx in 0..3 {
                let ws = &wic[(ky * 3 + kx) * KB_OC..][..KB_OC];
                // SAFETY: `row` has KB_PX + 2 values, so 4 from `kx` ≤ 2 are in bounds.
                let xs = unsafe { v128_load(row.as_ptr().add(kx) as *const v128) };
                for o in 0..KB_OC {
                    acc[o] = f32x4_add(acc[o], f32x4_mul(f32x4_splat(ws[o]), xs));
                }
            }
        }
    }
    acc.map(|a| [f32x4_extract_lane::<0>(a), f32x4_extract_lane::<1>(a), f32x4_extract_lane::<2>(a), f32x4_extract_lane::<3>(a)])
}

/// Copies `channels` planes (`w × h`) into the middle of 1-pixel zero-padded planes.
fn pad_into(dst: &mut [f32], src: &[f32], channels: usize, w: usize, h: usize) {
    let pplane = (w + 2) * (h + 2);
    for c in 0..channels {
        for y in 0..h {
            dst[c * pplane + (y + 1) * (w + 2) + 1..][..w].copy_from_slice(&src[c * w * h + y * w..][..w]);
        }
    }
}

/// Exact GELU, as PyTorch's `nn.GELU(approximate='none')`.
fn gelu(x: &mut [f32]) {
    for v in x {
        *v = 0.5 * *v * (1.0 + fast_erf(*v * std::f32::consts::FRAC_1_SQRT_2));
    }
}

/// Branch-free `erf` (Eigen's `generic_fast_erf_float`, a rational approximation on
/// [-4, 4]), so GELU vectorises.
#[allow(clippy::excessive_precision)]
#[inline(always)]
pub fn fast_erf(x: f32) -> f32 {
    let x = x.clamp(-4.0, 4.0);
    let x2 = x * x;
    let mut p = -2.72614225801306e-10f32;
    p = p * x2 + 2.77068142495902e-08;
    p = p * x2 - 2.10102402082508e-06;
    p = p * x2 - 5.69250639462346e-05;
    p = p * x2 - 7.34990630326855e-04;
    p = p * x2 - 2.95459980854025e-03;
    p = p * x2 - 1.60960333262415e-02;
    let mut q = -1.45660718464996e-05f32;
    q = q * x2 - 2.13374055278905e-04;
    q = q * x2 - 1.68282697438203e-03;
    q = q * x2 - 7.37332916720468e-03;
    q = q * x2 - 1.42647390514189e-02;
    x * p / q
}

/// Superpixel-bin the fine planes `[mosaic, R, G, B one-hot, …]` (`pw × ph`): `rgb` (3
/// planes, `pw/bin × ph/bin`) gets each block's mean per colour, `count` the number of
/// photosites of that colour (upstream's `dt_nn_bin_planes`).
pub fn bin_planes(planes: &[f32], pw: usize, ph: usize, bin: usize, rgb: &mut [f32], count: &mut [f32]) {
    let plane = pw * ph;
    let (cw, ch) = (pw / bin, ph / bin);
    let mosaic = &planes[..plane];
    for c in 0..3 {
        let onehot = &planes[(1 + c) * plane..(2 + c) * plane];
        for cy in 0..ch {
            for cx in 0..cw {
                let (mut sum, mut cnt) = (0.0f32, 0.0f32);
                for y in cy * bin..(cy + 1) * bin {
                    for x in cx * bin..(cx + 1) * bin {
                        let i = y * pw + x;
                        sum += mosaic[i] * onehot[i];
                        cnt += onehot[i];
                    }
                }
                let o = c * cw * ch + cy * cw + cx;
                count[o] = cnt;
                rgb[o] = sum / cnt.max(1.0);
            }
        }
    }
}

/// Nearest-neighbour upsampling of `channels` planes (`w × h`) by `factor`.
pub fn upsample_nearest(input: &[f32], channels: usize, w: usize, h: usize, factor: usize, out: &mut [f32]) {
    let (ow, oh) = (w * factor, h * factor);
    for c in 0..channels {
        let ip = &input[c * w * h..(c + 1) * w * h];
        let op = &mut out[c * ow * oh..(c + 1) * ow * oh];
        for y in 0..oh {
            let irow = &ip[(y / factor) * w..][..w];
            for (x, o) in op[y * ow..(y + 1) * ow].iter_mut().enumerate() {
                *o = irow[x / factor];
            }
        }
    }
}

/// `erf` for `f32`: fdlibm's `erff` as in musl (`src/math/erff.c`).
///
/// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved. Developed at
/// SunPro, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and
/// distribute this software is freely granted, provided that this notice is preserved.
/// Conversion to float by Ian Lance Taylor, Cygnus Support.
#[allow(clippy::excessive_precision)]
pub fn erf(x: f32) -> f32 {
    const ERX: f32 = 8.4506291151e-01;
    const EFX8: f32 = 1.0270333290e+00;
    const PP: [f32; 5] = [1.2837916613e-01, -3.2504209876e-01, -2.8481749818e-02, -5.7702702470e-03, -2.3763017452e-05];
    const QQ: [f32; 5] = [3.9791721106e-01, 6.5022252500e-02, 5.0813062117e-03, 1.3249473704e-04, -3.9602282413e-06];
    const PA: [f32; 7] = [-2.3621185683e-03, 4.1485610604e-01, -3.7220788002e-01, 3.1834661961e-01, -1.1089469492e-01, 3.5478305072e-02, -2.1663755178e-03];
    const QA: [f32; 6] = [1.0642088205e-01, 5.4039794207e-01, 7.1828655899e-02, 1.2617121637e-01, 1.3637083583e-02, 1.1984500103e-02];
    const RA: [f32; 8] = [-9.8649440333e-03, -6.9385856390e-01, -1.0558626175e+01, -6.2375331879e+01, -1.6239666748e+02, -1.8460508728e+02, -8.1287437439e+01, -9.8143291473e+00];
    const SA: [f32; 8] = [1.9651271820e+01, 1.3765776062e+02, 4.3456588745e+02, 6.4538726807e+02, 4.2900814819e+02, 1.0863500214e+02, 6.5702495575e+00, -6.0424413532e-02];
    const RB: [f32; 7] = [-9.8649431020e-03, -7.9928326607e-01, -1.7757955551e+01, -1.6063638306e+02, -6.3756646729e+02, -1.0250950928e+03, -4.8351919556e+02];
    const SB: [f32; 7] = [3.0338060379e+01, 3.2579251099e+02, 1.5367296143e+03, 3.1998581543e+03, 2.5530502930e+03, 4.7452853394e+02, -2.2440952301e+01];

    let bits = x.to_bits();
    let sign = bits >> 31 != 0;
    let ix = bits & 0x7fff_ffff;
    if ix >= 0x7f80_0000 {
        return 1.0 - 2.0 * sign as u8 as f32 + 1.0 / x;
    }
    if ix < 0x3f58_0000 {
        // |x| < 0.84375
        if ix < 0x3180_0000 {
            return 0.125 * (8.0 * x + EFX8 * x);
        }
        let z = x * x;
        let r = PP[0] + z * (PP[1] + z * (PP[2] + z * (PP[3] + z * PP[4])));
        let s = 1.0 + z * (QQ[0] + z * (QQ[1] + z * (QQ[2] + z * (QQ[3] + z * QQ[4]))));
        return x + x * (r / s);
    }
    let y = if ix < 0x40c0_0000 {
        // |x| < 6
        let erfc = if ix < 0x3fa0_0000 {
            // |x| < 1.25
            let s = x.abs() - 1.0;
            let p = PA[0] + s * (PA[1] + s * (PA[2] + s * (PA[3] + s * (PA[4] + s * (PA[5] + s * PA[6])))));
            let q = 1.0 + s * (QA[0] + s * (QA[1] + s * (QA[2] + s * (QA[3] + s * (QA[4] + s * QA[5])))));
            1.0 - ERX - p / q
        } else {
            let ax = x.abs();
            let s = 1.0 / (ax * ax);
            let (r, ss) = if ix < 0x4036_db6d {
                (
                    RA[0] + s * (RA[1] + s * (RA[2] + s * (RA[3] + s * (RA[4] + s * (RA[5] + s * (RA[6] + s * RA[7])))))),
                    1.0 + s * (SA[0] + s * (SA[1] + s * (SA[2] + s * (SA[3] + s * (SA[4] + s * (SA[5] + s * (SA[6] + s * SA[7]))))))),
                )
            } else {
                (
                    RB[0] + s * (RB[1] + s * (RB[2] + s * (RB[3] + s * (RB[4] + s * (RB[5] + s * RB[6]))))),
                    1.0 + s * (SB[0] + s * (SB[1] + s * (SB[2] + s * (SB[3] + s * (SB[4] + s * (SB[5] + s * SB[6])))))),
                )
            };
            let z = f32::from_bits(ax.to_bits() & 0xffff_e000);
            (-z * z - 0.5625).exp() * ((z - ax) * (z + ax) + r / ss).exp() / ax
        };
        1.0 - erfc
    } else {
        1.0 - f32::from_bits(0x0380_0000) // 1 - 2^-120
    };
    if sign { -y } else { y }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_erf_is_close_to_erf() {
        let max = (-60_000..=60_000).map(|i| i as f32 / 10_000.0).map(|x| (fast_erf(x) - erf(x)).abs()).fold(0.0f32, f32::max);
        eprintln!("fast_erf max abs error {max:e}");
        assert!(max < 1e-6, "{max}");
    }

    #[test]
    fn erf_matches_known_values() {
        for (x, e) in [(0.0f32, 0.0f64), (0.1, 0.1124629160), (0.5, 0.5204998778), (1.0, 0.8427007929), (2.0, 0.9953222650), (3.5, 0.9999992569), (-0.7, -0.6778011938)] {
            assert!((erf(x) as f64 - e).abs() < 2e-7, "erf({x}) = {} vs {e}", erf(x));
        }
    }
}
