//! Per-pixel operations, fused into a single pass.
//!
//! Everything after the spatial stages is a function of the pixel alone, so it is
//! compiled once per render into a [`PointOps`] (gains folded together, curves baked
//! into lookup tables) and applied in one loop that also encodes to 8-bit sRGB.
//! This is the part that re-runs on every slider move, so it has to be cheap.
//!
//! Order: exposure → colour calibration → saturation/vibrance → shadows/highlights →
//! colour primaries (all in linear Rec.2020, each kind possibly several times) →
//! filmic (to display-linear sRGB primaries) → sRGB encoding.
//!
//! A masked instance (`crate::ops::mask`) blends its output with its input per pixel:
//! its parametric part is evaluated here, on its input, and its drawn part is read from
//! the planes that come with the spatial image ([`PointOps::render_masked`]).

use crate::color::{LUMA_REC2020, MIDDLE_GREY, Mat3, REC709_FROM_REC2020, luminance, mul_vec, srgb_oetf};
use crate::ops::calibration::CalibrationStage;
use crate::image::{Image, Rgb, Rgba8};
use crate::ops::filmic::Filmic;
use crate::ops::lut::{BitsLut, CEILING, FINE, FLOOR, Lut3d};
use crate::ops::mask::{self, Drawn, MaskPlane, MaskStage};
use crate::ops::primaries::ColorPrimariesStage;
use std::rc::Rc;
use crate::params::{self, EditParams, Module};

/// Shadows/highlights gain as a function of luminance: smooth bells centred in the
/// shadows (-3 EV from middle grey) and highlights (+2 EV).
fn shadows_highlights_gain(y: f32, shadows: f32, highlights: f32) -> f32 {
    let ev = (y / MIDDLE_GREY).log2();
    let bell = |centre: f32, width: f32| (-(ev - centre).powi(2) / (2.0 * width * width)).exp();
    (shadows * 1.5 * bell(-3.0, 1.5) + highlights * 1.5 * bell(2.0, 1.5)).exp2()
}

/// Grid size of filmic's 3D lookup table. 65³ keeps 99.9 % of pixels within 1–2
/// levels (8-bit) of the exact computation; smaller grids show visible errors.
pub const FILMIC_LUT_SIZE: usize = 65;

/// Filmic, with its per-channel curve as a 1D table and (optionally) the whole
/// colour transform baked into a 3D table over log-encoded RGB.
pub struct FilmicStage {
    filmic: Filmic,
    curve: BitsLut<f32>,
    lut: Option<Lut3d>,
    lut_max: f32,
}

impl FilmicStage {
    pub fn new(p: &crate::params::Filmic, lut_size: Option<usize>) -> Self {
        let filmic = Filmic::new(p);
        let curve = BitsLut::new(FLOOR, CEILING, FINE, |v| filmic.spline.tone_map(v));
        // From 2 EV below the black point (displayed as black anyway) to 4 EV above
        // the white point; brighter pixels take the exact path.
        let grey = MIDDLE_GREY.log2();
        let lut = lut_size.map(|n| {
            // Stored sRGB-encoded: interpolation error is then perceptually uniform.
            Lut3d::new(n, grey + p.black_exposure - 2.0, grey + p.white_exposure + 4.0, |c| {
                filmic.apply_compressed(c, |v| curve.eval(v)).map(srgb_oetf)
            })
        });
        let lut_max = lut.as_ref().map_or(0.0, Lut3d::max_input);
        Self { filmic, curve, lut, lut_max }
    }

    pub fn has_lut(&self) -> bool {
        self.lut.is_some()
    }

    /// Display-linear output.
    fn apply(&self, px: Rgb) -> Rgb {
        self.filmic.apply_compressed(self.filmic.prepare(px), |v| self.curve.eval(v))
    }

    /// 8-bit sRGB output, through the 3D table when possible.
    #[inline]
    fn apply_u8(&self, px: Rgb, encode: &BitsLut<u8>) -> [u8; 3] {
        let c = self.filmic.prepare(px);
        match &self.lut {
            Some(lut) if c[0].max(c[1]).max(c[2]) <= self.lut_max => lut.eval(c).map(|v| (v * 255.0 + 0.5) as u8),
            _ => self.filmic.apply_compressed(c, |v| self.curve.eval(v)).map(|v| encode.eval(v)),
        }
    }
}

/// One compiled point module.
enum Step {
    /// `(x - offset) × gain` per channel: exposure (black level, gain). Consecutive
    /// ones are folded into one.
    Affine { offset: Rgb, gain: Rgb },
    Calibration(Box<CalibrationStage>),
    Saturation { saturation: f32, vibrance: f32 },
    /// Gain indexed by luminance.
    ShadowsHighlights(BitsLut<f32>),
    ColorPrimaries(Rc<ColorPrimariesStage>),
    /// A masked instance.
    Masked(Box<Masked>),
}

/// A step applied through a mask.
struct Masked {
    step: Step,
    mask: MaskStage,
    /// The instance's id: its drawn plane's, if it has a drawn part.
    id: String,
}

impl Step {
    fn exposure(p: &params::Exposure) -> Self {
        Step::Affine { offset: [p.black; 3], gain: [p.ev.exp2(); 3] }
    }

    fn color(p: &params::Color) -> Option<Self> {
        let saturation = 1.0 + p.saturation.clamp(-1.0, 1.0);
        let vibrance = p.vibrance.clamp(-1.0, 1.0);
        (saturation != 1.0 || vibrance != 0.0).then_some(Step::Saturation { saturation, vibrance })
    }

    fn shadows_highlights(p: &params::ShadowsHighlights) -> Option<Self> {
        let (shadows, highlights) = (p.shadows.clamp(-1.0, 1.0), p.highlights.clamp(-1.0, 1.0));
        (shadows != 0.0 || highlights != 0.0)
            .then(|| Step::ShadowsHighlights(BitsLut::new(FLOOR, CEILING, FINE + 1, |y| shadows_highlights_gain(y, shadows, highlights))))
    }

    /// The step on one pixel; masks take their drawn part as 1.
    #[inline]
    fn apply(&self, c: Rgb) -> Rgb {
        self.apply_at(c, 1.0)
    }

    /// The step on one pixel where a mask's drawn part is `drawn`.
    #[inline]
    fn apply_at(&self, c: Rgb, drawn: f32) -> Rgb {
        match self {
            Step::Affine { offset, gain } => affine(c, offset, gain),
            Step::Calibration(stage) => stage.apply(c),
            &Step::Saturation { saturation, vibrance } => saturate(c, saturation, vibrance),
            Step::ShadowsHighlights(lut) => shadows_highlights(c, lut),
            Step::ColorPrimaries(stage) => stage.apply(c),
            Step::Masked(m) => {
                let a = m.mask.eval(c, drawn);
                if a > 0.0 { mask::blend(c, m.step.apply(c), a) } else { c }
            }
        }
    }

    /// Position in the fixed chain.
    fn rank(&self) -> u8 {
        match self {
            Step::Affine { .. } => 0,
            Step::Calibration(_) => 1,
            Step::Saturation { .. } => 2,
            Step::ShadowsHighlights(_) => 3,
            Step::ColorPrimaries(_) => 4,
            // Never in the fixed chain.
            Step::Masked(_) => u8::MAX,
        }
    }
}

#[inline(always)]
fn affine(c: Rgb, offset: &Rgb, gain: &Rgb) -> Rgb {
    [(c[0] - offset[0]) * gain[0], (c[1] - offset[1]) * gain[1], (c[2] - offset[2]) * gain[2]]
}

#[inline(always)]
fn saturate(c: Rgb, saturation: f32, vibrance: f32) -> Rgb {
    let y = luminance(c);
    let mut k = saturation;
    if vibrance != 0.0 {
        let max = c[0].max(c[1]).max(c[2]);
        let min = c[0].min(c[1]).min(c[2]);
        // Relative chroma in [0, 1]: vibrance acts most on muted colours.
        let chroma = if max > 1e-6 { ((max - min) / max).clamp(0.0, 1.0) } else { 0.0 };
        k = (k * (1.0 + vibrance * (1.0 - chroma))).max(0.0);
    }
    c.map(|v| y + (v - y) * k)
}

#[inline(always)]
fn shadows_highlights(c: Rgb, lut: &BitsLut<f32>) -> Rgb {
    let gain = lut.eval(c[0] * LUMA_REC2020[0] + c[1] * LUMA_REC2020[1] + c[2] * LUMA_REC2020[2]);
    c.map(|v| v * gain)
}

/// An unmasked step on many pixels: one loop per kind of step, so that the step's
/// type is matched once rather than per pixel.
#[inline]
fn apply_unmasked(step: &Step, pixels: &mut [Rgb]) {
    match step {
        Step::Affine { offset, gain } => pixels.iter_mut().for_each(|c| *c = affine(*c, offset, gain)),
        Step::Calibration(stage) => stage.apply_all(pixels),
        &Step::Saturation { saturation, vibrance } => pixels.iter_mut().for_each(|c| *c = saturate(*c, saturation, vibrance)),
        Step::ShadowsHighlights(lut) => pixels.iter_mut().for_each(|c| *c = shadows_highlights(*c, lut)),
        Step::ColorPrimaries(stage) => pixels.iter_mut().for_each(|c| *c = stage.apply(*c)),
        Step::Masked(_) => pixels.iter_mut().for_each(|c| *c = step.apply(*c)),
    }
}

#[inline(never)]
fn apply_steps(steps: &[Step], px: Rgb) -> Rgb {
    steps.iter().fold(px, |c, step| step.apply(c))
}

/// Most pixels [`PointOps::adjust_all`] takes at once.
const MAX_CHUNK: usize = 64;

/// The compiled point modules. Looping over steps costs ~7 % of the whole pass, so
/// the usual shape (at most one step of each type, in order) gets a fixed chain.
enum Chain {
    Fixed {
        /// Identity (`(x - 0)·1`, exact) when there is none.
        affine: (Rgb, Rgb),
        calibration: Option<Box<CalibrationStage>>,
        saturation: Option<(f32, f32)>,
        shadows_highlights: Option<BitsLut<f32>>,
        primaries: Option<Rc<ColorPrimariesStage>>,
    },
    Steps(Vec<Step>),
}

impl Chain {
    fn new(steps: Vec<Step>) -> Self {
        let masked = steps.iter().any(|s| matches!(s, Step::Masked(_)));
        if masked || !steps.windows(2).all(|w| w[0].rank() < w[1].rank()) {
            return Chain::Steps(steps);
        }
        let (mut affine, mut calibration, mut saturation, mut shadows_highlights, mut primaries) = (([0.0; 3], [1.0; 3]), None, None, None, None);
        for step in steps {
            match step {
                Step::Affine { offset, gain } => affine = (offset, gain),
                Step::Calibration(stage) => calibration = Some(stage),
                Step::Saturation { saturation: s, vibrance } => saturation = Some((s, vibrance)),
                Step::ShadowsHighlights(lut) => shadows_highlights = Some(lut),
                Step::ColorPrimaries(stage) => primaries = Some(stage),
                Step::Masked(_) => unreachable!("masked steps use the generic chain"),
            }
        }
        Chain::Fixed { affine, calibration, saturation, shadows_highlights, primaries }
    }
}

pub struct PointOps {
    /// The enabled point modules before filmic, in pipeline order.
    chain: Chain,
    filmic: Option<Rc<FilmicStage>>,
    /// Used when filmic is off: clip in Rec.709.
    to_rec709: Mat3,
    /// Display-linear → 8-bit sRGB.
    encode: BitsLut<u8>,
}

impl PointOps {
    /// Point operations with exact filmic, for an image whose as-shot light is unknown
    /// (colour calibration's "as shot" does no adaptation).
    pub fn new(p: &EditParams) -> Self {
        Self::with_filmic_lut(p, None, None)
    }

    /// `as_shot`: the xy chromaticity of the file's as-shot light ([`crate::RawPhoto`]).
    /// `lut_size: None` evaluates filmic exactly for every pixel.
    pub fn with_filmic_lut(p: &EditParams, as_shot: Option<[f32; 2]>, lut_size: Option<usize>) -> Self {
        let filmic = p.get::<params::Filmic>().map(|f| Rc::new(FilmicStage::new(f, lut_size)));
        Self::with_filmic(p, as_shot, filmic)
    }

    /// Use a prepared (typically cached) filmic stage; `None` disables filmic.
    pub fn with_filmic(p: &EditParams, as_shot: Option<[f32; 2]>, filmic: Option<Rc<FilmicStage>>) -> Self {
        Self::with_stages(p, as_shot, filmic, &mut |cp| Rc::new(ColorPrimariesStage::build(cp)))
    }

    /// Like [`with_filmic`](Self::with_filmic), with colour primaries tables from `primaries`
    /// (typically a cache), called for each instance that changes anything.
    pub fn with_stages(
        p: &EditParams,
        as_shot: Option<[f32; 2]>,
        filmic: Option<Rc<FilmicStage>>,
        primaries: &mut dyn FnMut(&params::ColorPrimaries) -> Rc<ColorPrimariesStage>,
    ) -> Self {
        let mut steps: Vec<Step> = Vec::new();
        for instance in p.modules.iter().filter(|m| m.enabled) {
            let step = match &instance.module {
                Module::Exposure(e) => Step::exposure(e),
                Module::ColorCalibration(c) => match CalibrationStage::new(c, as_shot) {
                    Some(stage) => Step::Calibration(Box::new(stage)),
                    None => continue,
                },
                Module::Color(c) => match Step::color(c) {
                    Some(step) => step,
                    None => continue,
                },
                Module::ShadowsHighlights(sh) => match Step::shadows_highlights(sh) {
                    Some(step) => step,
                    None => continue,
                },
                Module::ColorPrimaries(cp) if !cp.is_identity() => Step::ColorPrimaries(primaries(cp)),
                _ => continue,
            };
            let step = match mask::active(instance) {
                Some(m) => {
                    let drawn = Drawn::of(p, m).is_some();
                    Step::Masked(Box::new(Masked { step, mask: MaskStage::new(m, drawn), id: instance.id.clone() }))
                }
                None => step,
            };
            // (x - o1)·g1 then (y - o2)·g2  =  (x - (o1 + o2/g1))·g1·g2
            if let (Some(Step::Affine { offset, gain }), Step::Affine { offset: o2, gain: g2 }) = (steps.last_mut(), &step) {
                if gain.iter().all(|&g| g > 0.0) {
                    *offset = [0, 1, 2].map(|i| offset[i] + o2[i] / gain[i]);
                    *gain = [0, 1, 2].map(|i| gain[i] * g2[i]);
                    continue;
                }
            }
            steps.push(step);
        }

        Self {
            chain: Chain::new(steps),
            filmic,
            to_rec709: REC709_FROM_REC2020,
            encode: BitsLut::new(FLOOR, 1.0, FINE, |v| (srgb_oetf(v) * 255.0 + 0.5) as u8),
        }
    }

    /// Scene-referred adjustments, in the working space (linear Rec.2020). Masks take
    /// their drawn part as 1: use [`adjust_image`](Self::adjust_image) for an image with
    /// its mask planes.
    #[inline(always)]
    pub fn adjust(&self, px: Rgb) -> Rgb {
        match &self.chain {
            Chain::Fixed { affine, calibration, saturation, shadows_highlights, primaries } => {
                fixed_chain(px, affine, calibration, saturation, shadows_highlights, primaries)
            }
            Chain::Steps(steps) => apply_steps(steps, px),
        }
    }

    /// One pixel: scene-linear Rec.2020 → display-linear sRGB primaries.
    #[inline]
    pub fn display(&self, px: Rgb) -> Rgb {
        let c = self.adjust(px);
        match &self.filmic {
            Some(f) => f.apply(c),
            None => mul_vec(&self.to_rec709, c).map(|v| v.clamp(0.0, 1.0)),
        }
    }

    /// [`adjust`](Self::adjust) on many pixels, one module at a time: each module's
    /// loop has independent pixels for the CPU to overlap. One pixel through the whole
    /// chain is a long dependency chain (colour calibration alone has four matrix
    /// products and three divisions), which made the fused pass latency-bound.
    ///
    /// `planes[i]` is the drawn plane of step `i` if it is masked with one; `start`, the
    /// index of `pixels[0]` in those planes.
    fn adjust_all(&self, pixels: &mut [Rgb], planes: &[Option<&[f32]>], start: usize) {
        match &self.chain {
            Chain::Fixed { affine: (offset, gain), calibration, saturation, shadows_highlights, primaries } => {
                pixels.iter_mut().for_each(|c| *c = affine(*c, offset, gain));
                if let Some(stage) = calibration {
                    stage.apply_all(pixels);
                }
                if let &Some((s, v)) = saturation {
                    pixels.iter_mut().for_each(|c| *c = saturate(*c, s, v));
                }
                if let Some(lut) = shadows_highlights {
                    pixels.iter_mut().for_each(|c| *c = self::shadows_highlights(*c, lut));
                }
                if let Some(stage) = primaries {
                    pixels.iter_mut().for_each(|c| *c = stage.apply(*c));
                }
            }
            Chain::Steps(steps) => {
                for (i, step) in steps.iter().enumerate() {
                    match step {
                        Step::Calibration(stage) => stage.apply_all(pixels),
                        Step::Masked(m) => {
                            // The mask, the step on a copy, then the blend: each a loop of
                            // independent pixels, like the rest of the pass.
                            let n = pixels.len();
                            let mut alpha = [0.0f32; MAX_CHUNK];
                            match planes.get(i).copied().flatten() {
                                Some(plane) => m.mask.eval_all(pixels, &plane[start..start + n], &mut alpha[..n]),
                                // A missing plane (none given) leaves the pixels alone.
                                None if m.mask.drawn => continue,
                                None => m.mask.eval_all(pixels, &[], &mut alpha[..n]),
                            }
                            if alpha[..n].iter().all(|&a| a <= 0.0) {
                                continue;
                            }
                            let mut out = [[0.0f32; 3]; MAX_CHUNK];
                            let out = &mut out[..n];
                            out.copy_from_slice(pixels);
                            apply_unmasked(&m.step, out);
                            for ((c, o), &a) in pixels.iter_mut().zip(out.iter()).zip(&alpha[..n]) {
                                *c = mask::blend(*c, *o, a);
                            }
                        }
                        _ => apply_unmasked(step, pixels),
                    }
                }
            }
        }
    }

    /// The drawn plane of each step, from `masks` (see [`adjust_all`](Self::adjust_all)).
    fn planes<'a>(&self, masks: &'a [MaskPlane]) -> Vec<Option<&'a [f32]>> {
        match &self.chain {
            Chain::Fixed { .. } => Vec::new(),
            Chain::Steps(steps) => steps
                .iter()
                .map(|s| match s {
                    Step::Masked(m) if m.mask.drawn => masks.iter().find(|p| p.id == m.id).map(|p| p.alpha.as_slice()),
                    _ => None,
                })
                .collect(),
        }
    }

    /// [`adjust`](Self::adjust) on a whole image, with the drawn planes of its masks.
    pub fn adjust_image(&self, img: &Image, masks: &[MaskPlane]) -> Vec<Rgb> {
        let mut out = img.pixels.clone();
        let planes = self.planes(masks);
        for (i, chunk) in out.chunks_mut(MAX_CHUNK).enumerate() {
            self.adjust_all(chunk, &planes, i * MAX_CHUNK);
        }
        out
    }

    /// An adjusted pixel to 8-bit sRGB.
    #[inline]
    fn encode(&self, c: Rgb) -> [u8; 3] {
        match &self.filmic {
            Some(f) => f.apply_u8(c, &self.encode),
            None => mul_vec(&self.to_rec709, c).map(|v| self.encode.eval(v.clamp(0.0, 1.0))),
        }
    }

    /// One pixel, all the way to 8-bit sRGB.
    #[inline]
    pub fn apply(&self, px: Rgb) -> [u8; 3] {
        self.encode(self.adjust(px))
    }

    /// Apply to a whole image and encode as 8-bit sRGB. Masked instances with a drawn
    /// part do nothing: see [`render_masked`](Self::render_masked).
    pub fn render(&self, img: &Image) -> Rgba8 {
        self.render_masked(img, &[])
    }

    /// [`render`](Self::render), with the drawn planes of the masks over `img`'s pixels
    /// (by instance id; see `Developer::spatial`).
    pub fn render_masked(&self, img: &Image, masks: &[MaskPlane]) -> Rgba8 {
        const CHUNK: usize = MAX_CHUNK;
        let planes = self.planes(masks);
        let mut data = vec![255u8; img.pixels.len() * 4];
        let mut buffer = [[0.0f32; 3]; CHUNK];
        for (i, (pixels, out)) in img.pixels.chunks(CHUNK).zip(data.chunks_mut(CHUNK * 4)).enumerate() {
            let buffer = &mut buffer[..pixels.len()];
            buffer.copy_from_slice(pixels);
            self.adjust_all(buffer, &planes, i * CHUNK);
            for (c, out) in buffer.iter().zip(out.chunks_exact_mut(4)) {
                out[..3].copy_from_slice(&self.encode(*c));
            }
        }
        Rgba8 { width: img.width, height: img.height, data }
    }
}

#[inline(always)]
fn fixed_chain(
    px: Rgb,
    (offset, gain): &(Rgb, Rgb),
    calibration: &Option<Box<CalibrationStage>>,
    saturation: &Option<(f32, f32)>,
    sh: &Option<BitsLut<f32>>,
    primaries: &Option<Rc<ColorPrimariesStage>>,
) -> Rgb {
    let mut c = affine(px, offset, gain);
    if let Some(stage) = calibration {
        c = stage.apply(c);
    }
    if let &Some((saturation, vibrance)) = saturation {
        c = saturate(c, saturation, vibrance);
    }
    if let Some(lut) = sh {
        c = shadows_highlights(c, lut);
    }
    if let Some(stage) = primaries {
        c = stage.apply(c);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::REC2020_FROM_REC709;

    fn ops(f: impl FnOnce(&mut EditParams)) -> PointOps {
        let mut p = EditParams::default();
        p.get_mut::<params::Exposure>().ev = 0.0;
        p.remove(params::ModuleKind::Filmic);
        p.remove(params::ModuleKind::ColorCalibration);
        f(&mut p);
        PointOps::new(&p)
    }

    fn approx(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
    }

    #[test]
    fn exposure_doubles() {
        assert!(approx(ops(|p| p.get_mut::<params::Exposure>().ev = 1.0).adjust([0.1, 0.2, 0.3]), [0.2, 0.4, 0.6], 1e-6));
    }

    #[test]
    fn exposure_instances_add_up() {
        let o = ops(|p| {
            p.get_mut::<params::Exposure>().black = 0.01;
            p.add(params::Exposure { ev: 1.0, black: 0.02 });
            p.add(params::Exposure { ev: 3.0, black: 0.0 });
            p.modules.last_mut().unwrap().enabled = false;
        });
        assert!(matches!(o.chain, Chain::Fixed { calibration: None, saturation: None, shadows_highlights: None, primaries: None, .. }));
        // ((0.1 - 0.01) - 0.02) · 2
        assert!(approx(o.adjust([0.1; 3]), [0.14; 3], 1e-6));
    }

    #[test]
    fn repeated_steps_use_the_generic_chain() {
        let o = ops(|p| {
            p.get_mut::<params::Color>().saturation = -0.5;
            p.add(params::Color { saturation: -1.0, vibrance: 0.0 });
        });
        assert!(matches!(&o.chain, Chain::Steps(steps) if steps.len() == 3));
        let [r, g, b] = o.adjust([0.5, 0.2, 0.1]);
        assert!((r - g).abs() < 1e-6 && (g - b).abs() < 1e-6);
    }

    #[test]
    fn desaturate_gives_grey() {
        let [r, g, b] = ops(|p| p.get_mut::<params::Color>().saturation = -1.0).adjust([0.5, 0.2, 0.1]);
        assert!((r - g).abs() < 1e-6 && (g - b).abs() < 1e-6);
    }

    #[test]
    fn calibration_runs_after_exposure() {
        let o = ops(|p| {
            p.get_mut::<params::Exposure>().ev = 1.0;
            let c = p.get_mut::<params::ColorCalibration>();
            c.illuminant = params::Illuminant::Daylight;
            c.temperature = 4000.0;
        });
        assert!(matches!(o.chain, Chain::Fixed { calibration: Some(_), .. }));
        // Adapting from a warm light makes neutrals bluer.
        let out = o.adjust([0.1; 3]);
        assert!(out[2] > out[0] && luminance(out) > 0.15, "{out:?}");
    }

    #[test]
    fn shadows_lift_darks_more_than_brights() {
        let o = ops(|p| p.get_mut::<params::ShadowsHighlights>().shadows = 1.0);
        let dark = o.adjust([0.02; 3])[0] / 0.02;
        let bright = o.adjust([1.0; 3])[0];
        assert!(dark > 1.5 && (bright - 1.0).abs() < 0.05, "{dark} {bright}");
    }

    #[test]
    fn filmic_lut_matches_exact_curve() {
        let mut p = EditParams::default();
        p.get_mut::<params::Exposure>().ev = 0.0;
        p.remove(params::ModuleKind::ColorCalibration);
        let o = PointOps::new(&p);
        let exact = Filmic::new(p.get::<params::Filmic>().unwrap());
        for v in [1e-4f32, 0.01, MIDDLE_GREY, 0.5, 1.0, 4.0, 100.0] {
            let got = o.display(mul_vec(&REC2020_FROM_REC709, [v; 3]));
            let want = exact.apply(mul_vec(&REC2020_FROM_REC709, [v; 3]), |x| exact.spline.tone_map(x));
            assert!(approx(got, want, 3e-3), "{v}: {got:?} vs {want:?}");
        }
    }

    #[test]
    fn render_encodes_srgb() {
        let img = Image { width: 2, height: 1, pixels: vec![[0.0; 3], [1.0; 3]] };
        let out = ops(|_| {}).render(&img);
        assert_eq!(out.data, [0, 0, 0, 255, 255, 255, 255, 255]);
    }
}
