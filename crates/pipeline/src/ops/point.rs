//! Per-pixel operations, fused into a single pass.
//!
//! Everything after the spatial stages is a function of the pixel alone, so it is
//! compiled once per render into a [`PointOps`] (gains folded together, curves baked
//! into lookup tables) and applied in one loop that also encodes to 8-bit sRGB.
//! This is the part that re-runs on every slider move, so it has to be cheap.
//!
//! Order: exposure → colour calibration → colour balance → colour primaries → tone curve (all in linear Rec.2020, each kind possibly several times) →
//! filmic (to display-linear output primaries) → creative LUTs (on encoded sRGB, see
//! [`Looks`]) → encoding. The output space is sRGB except for exports
//! ([`PointOps::for_space`]).
//!
//! A masked instance (`crate::ops::mask`) blends its output with its input per pixel,
//! in its blend mode (`crate::ops::blend`): its parametric part is evaluated here, on
//! its input, and its drawn part is read from the planes that come with the spatial
//! image ([`PointOps::render_masked`]). A creative LUT's mask is measured on filmic's
//! input, and it blends display-referred, on encoded sRGB.
//!
//! A tone curve preserving detail reads its mask's statistics from planes of its own
//! that come the same way (`crate::ops::tone_curve::plane_ids`).

use crate::color::{MIDDLE_GREY, Mat3, mul_vec};
use crate::ops::blend::Blend;
use crate::ops::calibration::CalibrationStage;
use crate::ops::color_balance::ColorBalanceStage;
use crate::ops::clut::{Clut, ClutStore, Interpolation};
use crate::image::{Image, Rgb, Rgba8};
use crate::ops::filmic::Filmic;
use crate::ops::lut::{BitsLut, CEILING, FINE, FLOOR, Lut3d};
use crate::ops::mask::{self, Drawn, MaskPlane, MaskStage};
use crate::ops::primaries::ColorPrimariesStage;
use crate::ops::tone_curve::ToneCurveStage;
use crate::output::ColorSpace;
use std::rc::Rc;
use crate::params::{self, EditParams, Module};

/// Grid size of filmic's 3D lookup table. 65³ keeps 99.9 % of pixels within 1–2
/// levels (8-bit) of the exact computation; smaller grids show visible errors.
pub const FILMIC_LUT_SIZE: usize = 65;

/// A creative LUT instance: its table, how it's interpolated, and its mask.
#[derive(Clone)]
pub struct Look {
    pub lut: Rc<Clut>,
    pub interpolation: Interpolation,
    /// Its active mask, if it has one, with its instance id (its drawn plane's) and
    /// whether it has a drawn part.
    pub mask: Option<(String, params::Mask, bool)>,
}

impl Look {
    /// Whether it does the same to every pixel of a colour: unmasked, or masked by
    /// opacity, invert and blend alone. Filmic's table can then hold it.
    fn uniform(&self) -> bool {
        self.mask.as_ref().is_none_or(|(_, m, drawn)| !drawn && !m.has_ranges())
    }
}

/// The LUTs of `p`'s enabled LUT instances, in order, skipping those `luts` doesn't have.
pub fn looks_of(p: &EditParams, luts: &ClutStore) -> Vec<Look> {
    p.modules
        .iter()
        .filter(|m| m.enabled)
        .filter_map(|m| {
            let Module::Lut(l) = &m.module else { return None };
            let lut = luts.get(&l.lut.as_ref()?.id)?.clone();
            let mask = mask::active(m).map(|k| (m.id.clone(), k.clone(), Drawn::of(p, k).is_some()));
            Some(Look { lut, interpolation: l.interpolation, mask })
        })
        .collect()
}

/// The LUTs filmic's table can hold: the first ones, up to one that isn't uniform.
pub fn bakeable(looks: &[Look]) -> &[Look] {
    &looks[..looks.iter().take_while(|l| l.uniform()).count()]
}

fn same_looks(a: &[Look], b: &[Look]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.interpolation == y.interpolation && x.lut.id() == y.lut.id() && x.mask.as_ref().map(|m| &m.1) == y.mask.as_ref().map(|m| &m.1)
        })
}

/// Filmic, with its per-channel curve as a 1D table and (optionally) the whole
/// colour transform baked into a 3D table over log-encoded RGB, creative LUTs included
/// if it was built with some ([`with_looks`](Self::with_looks)).
pub struct FilmicStage {
    filmic: Filmic,
    space: ColorSpace,
    curve: BitsLut<f32>,
    lut: Option<Lut3d>,
    lut_max: f32,
    /// The creative LUTs it was built with: baked into `lut` after filmic, if it has one.
    looks: Vec<Look>,
}

impl FilmicStage {
    /// For sRGB output.
    pub fn new(p: &crate::params::Filmic, lut_size: Option<usize>) -> Self {
        Self::for_space(p, lut_size, ColorSpace::Srgb)
    }

    /// Gamut-mapped to `space`, and its table (if any) encoded for it.
    pub fn for_space(p: &crate::params::Filmic, lut_size: Option<usize>, space: ColorSpace) -> Self {
        Self::build(p, lut_size, space, &[])
    }

    /// For sRGB output, with the creative LUTs `looks` baked into its table, if it has
    /// one: the point operations then skip them for the pixels the table covers. They
    /// must be uniform ([`bakeable`]).
    pub fn with_looks(p: &crate::params::Filmic, lut_size: Option<usize>, looks: &[Look]) -> Self {
        Self::build(p, lut_size, ColorSpace::Srgb, looks)
    }

    fn build(p: &crate::params::Filmic, lut_size: Option<usize>, space: ColorSpace, looks: &[Look]) -> Self {
        assert!(looks.is_empty() || space == ColorSpace::Srgb, "LUTs are baked on sRGB output only");
        assert!(bakeable(looks).len() == looks.len(), "only uniform LUTs can be baked");
        let compiled: Vec<CompiledLook> = looks.iter().map(CompiledLook::new).collect();
        let filmic = Filmic::for_space(p, space);
        let curve = BitsLut::new(FLOOR, CEILING, FINE, |v| filmic.spline.tone_map(v));
        // From 2 EV below the black point (displayed as black anyway) to 4 EV above
        // the white point; brighter pixels take the exact path.
        let grey = MIDDLE_GREY.log2();
        let lut = lut_size.map(|n| {
            // Stored encoded: interpolation error is then perceptually uniform.
            Lut3d::new(n, grey + p.black_exposure - 2.0, grey + p.white_exposure + 4.0, |c| {
                let e = filmic.apply_compressed(c, |v| curve.eval(v)).map(|v| space.oetf(v));
                compiled.iter().fold(e, |e, look| look.apply_uniform(e))
            })
        });
        let lut_max = lut.as_ref().map_or(0.0, Lut3d::max_input);
        Self { filmic, space, curve, lut, lut_max, looks: looks.to_vec() }
    }

    /// Whether it was built with exactly these creative LUTs.
    pub fn has_looks(&self, looks: &[Look]) -> bool {
        same_looks(&self.looks, looks)
    }

    /// Whether its table has creative LUTs baked in.
    fn bakes_looks(&self) -> bool {
        self.lut.is_some() && !self.looks.is_empty()
    }

    pub fn has_lut(&self) -> bool {
        self.lut.is_some()
    }

    /// Display-linear output.
    fn apply(&self, px: Rgb) -> Rgb {
        self.filmic.apply_compressed(self.filmic.prepare(px), |v| self.curve.eval(v))
    }

    /// Output encoded for its space, from the 3D table if it has one that covers `px`.
    #[inline]
    fn lut_encoded(&self, px: Rgb) -> Option<Rgb> {
        let c = self.filmic.prepare(px);
        match &self.lut {
            Some(lut) if c[0].max(c[1]).max(c[2]) <= self.lut_max => Some(lut.eval(c)),
            _ => None,
        }
    }

    /// 8-bit encoded output, through the 3D table when possible.
    #[inline]
    fn apply_u8(&self, px: Rgb, encode: &BitsLut<u8>) -> [u8; 3] {
        let c = self.filmic.prepare(px);
        match &self.lut {
            Some(lut) if c[0].max(c[1]).max(c[2]) <= self.lut_max => lut.eval(c).map(|v| (v * 255.0 + 0.5) as u8),
            _ => self.filmic.apply_compressed(c, |v| self.curve.eval(v)).map(|v| encode.eval(v)),
        }
    }
}

/// A creative LUT, ready to apply.
struct CompiledLook {
    lut: Rc<Clut>,
    interpolation: Interpolation,
    mask: Option<LookMask>,
}

/// A creative LUT's mask, measured on filmic's input, and its blend, display-referred.
struct LookMask {
    stage: MaskStage,
    blend: Blend,
    id: String,
}

impl CompiledLook {
    fn new(look: &Look) -> Self {
        let mask = look.mask.as_ref().map(|(id, m, drawn)| LookMask { stage: MaskStage::new(m, *drawn), blend: Blend::display(m), id: id.clone() });
        Self { lut: look.lut.clone(), interpolation: look.interpolation, mask }
    }

    /// The LUT on one encoded sRGB colour, if it's uniform (its mask the same everywhere).
    #[inline]
    fn apply_uniform(&self, e: Rgb) -> Rgb {
        let out = self.lut.eval(e, self.interpolation);
        match &self.mask {
            None => out,
            Some(m) => m.blend.mix(e, out, m.stage.eval(e, 1.0)),
        }
    }
}

/// The creative LUTs ([`params::Lut`]) after filmic. They map encoded sRGB to encoded
/// sRGB: filmic's output (display-linear, in the output primaries) is converted to
/// sRGB, clipped, encoded, run through the LUTs in order, then converted back to the
/// output space. Colours outside sRGB are clipped before the first LUT.
struct Looks {
    luts: Vec<CompiledLook>,
    /// Display-linear output primaries → linear sRGB, unless the output is sRGB.
    to_srgb: Option<Mat3>,
    /// Linear sRGB → linear output primaries, unless the output is sRGB.
    from_srgb: Option<Mat3>,
    /// Linear → encoded sRGB, approximately (within a quarter of an 8-bit level), for
    /// 8-bit renders.
    srgb_oetf: BitsLut<f32>,
}

impl Looks {
    fn new(luts: &[Look], space: ColorSpace) -> Option<Self> {
        if luts.is_empty() {
            return None;
        }
        let luts = luts.iter().map(CompiledLook::new).collect();
        let srgb_oetf = BitsLut::new(FLOOR, 1.0, FINE, crate::color::srgb_oetf);
        let mut looks = Self { luts, to_srgb: None, from_srgb: None, srgb_oetf };
        looks.set_space(space);
        Some(looks)
    }

    fn set_space(&mut self, space: ColorSpace) {
        let srgb = ColorSpace::Srgb;
        (self.to_srgb, self.from_srgb) = if space == srgb {
            (None, None)
        } else {
            (
                Some(crate::color::mul(&srgb.rgb_from_xyz(), &space.xyz_from_rgb())),
                Some(crate::color::mul(&space.rgb_from_xyz(), &srgb.xyz_from_rgb())),
            )
        };
    }

    /// Display-linear output primaries → linear sRGB, clipped.
    #[inline]
    fn linear_srgb(&self, c: Rgb) -> Rgb {
        match &self.to_srgb {
            Some(m) => mul_vec(m, c),
            None => c,
        }
        .map(|v| v.clamp(0.0, 1.0))
    }

    /// The LUTs from the `from`-th on encoded sRGB colours (at most [`MAX_CHUNK`]), in
    /// place. `scene`: the same pixels before filmic, which their masks measure;
    /// `planes`, the drawn plane of each LUT if it's masked with one (see
    /// [`PointOps::adjust_all`]). A LUT whose plane is missing is skipped.
    fn apply_from(&self, from: usize, encoded: &mut [Rgb], scene: &[Rgb], planes: &[Option<&[f32]>], start: usize) {
        let n = encoded.len();
        for (i, look) in self.luts.iter().enumerate().skip(from) {
            let Some(m) = &look.mask else {
                look.lut.apply_all(encoded, look.interpolation);
                continue;
            };
            let mut alpha = [0.0f32; MAX_CHUNK];
            match planes.get(i).copied().flatten() {
                Some(plane) => m.stage.eval_all(scene, &plane[start..start + n], &mut alpha[..n]),
                None if m.stage.drawn => continue,
                None => m.stage.eval_all(scene, &[], &mut alpha[..n]),
            }
            if alpha[..n].iter().all(|&a| a <= 0.0) {
                continue;
            }
            let mut out = [[0.0f32; 3]; MAX_CHUNK];
            let out = &mut out[..n];
            out.copy_from_slice(encoded);
            look.lut.apply_all(out, look.interpolation);
            m.blend.mix_all(encoded, out, &alpha[..n]);
        }
    }

    /// The first `n` LUTs, uniform, on one encoded sRGB colour.
    #[inline]
    fn apply_uniform(&self, n: usize, e: Rgb) -> Rgb {
        self.luts[..n].iter().fold(e, |e, look| look.apply_uniform(e))
    }

    /// Encoded sRGB → encoded `space`, exactly.
    #[inline]
    fn to_output(&self, e: Rgb, space: ColorSpace) -> Rgb {
        match &self.from_srgb {
            Some(m) => mul_vec(m, e.map(|v| ColorSpace::Srgb.eotf(v))).map(|v| space.oetf(v)),
            None => e,
        }
    }
}

/// One compiled point module.
enum Step {
    /// `(x - offset) × gain` per channel: exposure (black level, gain). Consecutive
    /// ones are folded into one.
    Affine { offset: Rgb, gain: Rgb },
    Calibration(Box<CalibrationStage>),
    ColorBalance(Box<ColorBalanceStage>),
    ColorPrimaries(Rc<ColorPrimariesStage>),
    ToneCurve(Box<ToneCurveStage>),
    /// A masked instance.
    Masked(Box<Masked>),
}

/// A step applied through a mask.
struct Masked {
    step: Step,
    mask: MaskStage,
    blend: Blend,
    /// The instance's id: its drawn plane's, if it has a drawn part.
    id: String,
}

impl Step {
    fn exposure(p: &params::Exposure) -> Self {
        Step::Affine { offset: [p.black; 3], gain: [p.ev.exp2(); 3] }
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
            Step::ColorBalance(stage) => stage.apply(c),
            Step::ColorPrimaries(stage) => stage.apply(c),
            Step::ToneCurve(stage) => stage.apply(c),
            Step::Masked(m) => {
                let a = m.mask.eval(c, drawn);
                if a > 0.0 { m.blend.mix(c, m.step.apply(c), a) } else { c }
            }
        }
    }

    /// The ids of the planes a tone curve preserving detail reads.
    fn tone_planes(&self) -> Option<&[String; 2]> {
        match self {
            Step::ToneCurve(stage) => stage.planes.as_ref(),
            Step::Masked(m) => m.step.tone_planes(),
            _ => None,
        }
    }

    /// Position in the fixed chain.
    fn rank(&self) -> u8 {
        match self {
            Step::Affine { .. } => 0,
            Step::Calibration(_) => 1,
            Step::ColorBalance(_) => 2,
            Step::ColorPrimaries(_) => 3,
            Step::ToneCurve(_) => 4,
            // Never in the fixed chain.
            Step::Masked(_) => u8::MAX,
        }
    }
}

#[inline(always)]
fn affine(c: Rgb, offset: &Rgb, gain: &Rgb) -> Rgb {
    [(c[0] - offset[0]) * gain[0], (c[1] - offset[1]) * gain[1], (c[2] - offset[2]) * gain[2]]
}

/// An unmasked step on many pixels: one loop per kind of step, so that the step's
/// type is matched once rather than per pixel. `tones`: a tone curve's mask at those
/// pixels, when it preserves detail.
#[inline]
fn apply_unmasked(step: &Step, pixels: &mut [Rgb], tones: Option<[&[f32]; 2]>) {
    match step {
        Step::Affine { offset, gain } => pixels.iter_mut().for_each(|c| *c = affine(*c, offset, gain)),
        Step::Calibration(stage) => stage.apply_all(pixels),
        Step::ColorBalance(stage) => stage.apply_all(pixels),
        Step::ColorPrimaries(stage) => pixels.iter_mut().for_each(|c| *c = stage.apply(*c)),
        Step::ToneCurve(stage) => stage.apply_all(pixels, tones),
        Step::Masked(_) => pixels.iter_mut().for_each(|c| *c = step.apply(*c)),
    }
}

#[inline(never)]
fn apply_steps(steps: &[Step], px: Rgb) -> Rgb {
    steps.iter().fold(px, |c, step| step.apply(c))
}

/// Most pixels [`PointOps::adjust_all`] takes at once.
const MAX_CHUNK: usize = 64;

/// The planes a step reads.
#[derive(Clone, Copy, Default)]
struct StepPlanes<'a> {
    /// Its mask's drawn part (or whole mask), if it's masked with one.
    mask: Option<&'a [f32]>,
    /// A tone curve's mask statistics, when it preserves detail.
    tones: Option<[&'a [f32]; 2]>,
}

/// The planes the point operations read, by position.
struct Planes<'a> {
    /// Of each step.
    steps: Vec<StepPlanes<'a>>,
    /// Of each LUT, if it's masked with one.
    looks: Vec<Option<&'a [f32]>>,
}

/// The compiled point modules. Looping over steps costs ~7 % of the whole pass, so
/// the usual shape (at most one step of each type, in order) gets a fixed chain.
enum Chain {
    Fixed {
        /// Identity (`(x - 0)·1`, exact) when there is none.
        affine: (Rgb, Rgb),
        calibration: Option<Box<CalibrationStage>>,
        color_balance: Option<Box<ColorBalanceStage>>,
        primaries: Option<Rc<ColorPrimariesStage>>,
        tone_curve: Option<Box<ToneCurveStage>>,
    },
    Steps(Vec<Step>),
}

impl Chain {
    fn new(steps: Vec<Step>) -> Self {
        // Steps that read planes, which the fixed chain doesn't.
        let masked = steps.iter().any(|s| matches!(s, Step::Masked(_)) || s.tone_planes().is_some());
        if masked || !steps.windows(2).all(|w| w[0].rank() < w[1].rank()) {
            return Chain::Steps(steps);
        }
        let (mut affine, mut calibration, mut color_balance, mut primaries, mut tone_curve) = (([0.0; 3], [1.0; 3]), None, None, None, None);
        for step in steps {
            match step {
                Step::Affine { offset, gain } => affine = (offset, gain),
                Step::Calibration(stage) => calibration = Some(stage),
                Step::ColorBalance(stage) => color_balance = Some(stage),
                Step::ColorPrimaries(stage) => primaries = Some(stage),
                Step::ToneCurve(stage) => tone_curve = Some(stage),
                Step::Masked(_) => unreachable!("masked steps use the generic chain"),
            }
        }
        Chain::Fixed { affine, calibration, color_balance, primaries, tone_curve }
    }
}

pub struct PointOps {
    /// The enabled point modules before filmic, in pipeline order.
    chain: Chain,
    filmic: Option<Rc<FilmicStage>>,
    /// The LUTs after filmic, if any.
    looks: Option<Looks>,
    /// How many of the LUTs filmic's 3D table has baked in (the first ones).
    baked: usize,
    space: ColorSpace,
    /// Used when filmic is off: clip in the output space.
    to_output: Mat3,
    /// Display-linear → 8-bit encoded.
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
    /// No LUTs are loaded: LUT instances are skipped.
    pub fn with_filmic(p: &EditParams, as_shot: Option<[f32; 2]>, filmic: Option<Rc<FilmicStage>>) -> Self {
        Self::with_stages(p, as_shot, filmic, &mut |cp| Rc::new(ColorPrimariesStage::build(cp)), &ClutStore::default())
    }

    /// Like [`with_filmic`](Self::with_filmic), with colour primaries tables from `primaries`
    /// (typically a cache), called for each instance that changes anything, and the
    /// tables of LUT instances from `luts` (an instance whose LUT isn't there is skipped).
    pub fn with_stages(
        p: &EditParams,
        as_shot: Option<[f32; 2]>,
        filmic: Option<Rc<FilmicStage>>,
        primaries: &mut dyn FnMut(&params::ColorPrimaries) -> Rc<ColorPrimariesStage>,
        luts: &ClutStore,
    ) -> Self {
        let mut steps: Vec<Step> = Vec::new();
        for instance in p.modules.iter().filter(|m| m.enabled) {
            let step = match &instance.module {
                Module::Exposure(e) => Step::exposure(e),
                Module::ColorCalibration(c) => match CalibrationStage::new(c, as_shot) {
                    Some(stage) => Step::Calibration(Box::new(stage)),
                    None => continue,
                },
                Module::ColorBalance(c) => match ColorBalanceStage::new(c) {
                    Some(stage) => Step::ColorBalance(Box::new(stage)),
                    None => continue,
                },
                Module::ColorPrimaries(cp) if !cp.is_identity() => Step::ColorPrimaries(primaries(cp)),
                Module::ToneCurve(t) => match ToneCurveStage::new(t, &instance.id) {
                    Some(stage) => Step::ToneCurve(Box::new(stage)),
                    None => continue,
                },
                _ => continue,
            };
            let step = match mask::active(instance) {
                Some(m) => {
                    let drawn = Drawn::of(p, m).is_some();
                    Step::Masked(Box::new(Masked { step, mask: MaskStage::new(m, drawn), blend: Blend::scene(m), id: instance.id.clone() }))
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

        let space = filmic.as_ref().map_or(ColorSpace::Srgb, |f| f.space);
        let looks = looks_of(p, luts);
        let baked = match &filmic {
            Some(f) if f.bakes_looks() => {
                assert!(f.has_looks(bakeable(&looks)), "filmic's table has other LUTs baked in");
                f.looks.len()
            }
            _ => 0,
        };
        Self {
            chain: Chain::new(steps),
            filmic,
            looks: Looks::new(&looks, space),
            baked,
            space,
            to_output: space.from_working(),
            encode: BitsLut::new(FLOOR, 1.0, FINE, |v| (space.oetf(v) * 255.0 + 0.5) as u8),
        }
    }

    /// Output to `space` rather than sRGB. A filmic stage given to the constructor
    /// must be for that space ([`FilmicStage::for_space`]).
    pub fn for_space(mut self, space: ColorSpace) -> Self {
        assert!(self.filmic.as_ref().is_none_or(|f| f.space == space), "filmic is for another output space");
        if space != self.space {
            self.space = space;
            self.to_output = space.from_working();
            self.encode = BitsLut::new(FLOOR, 1.0, FINE, |v| (space.oetf(v) * 255.0 + 0.5) as u8);
            if let Some(looks) = &mut self.looks {
                looks.set_space(space);
            }
        }
        self
    }

    pub fn space(&self) -> ColorSpace {
        self.space
    }

    /// Scene-referred adjustments, in the working space (linear Rec.2020). Masks take
    /// their drawn part as 1: use [`adjust_image`](Self::adjust_image) for an image with
    /// its mask planes.
    #[inline(always)]
    pub fn adjust(&self, px: Rgb) -> Rgb {
        match &self.chain {
            Chain::Fixed { affine, calibration, color_balance, primaries, tone_curve } => fixed_chain(px, affine, calibration, color_balance, primaries, tone_curve),
            Chain::Steps(steps) => apply_steps(steps, px),
        }
    }

    /// One pixel: scene-linear Rec.2020 → display-linear output primaries, before the
    /// creative LUTs.
    #[inline]
    pub fn display(&self, px: Rgb) -> Rgb {
        self.to_display(self.adjust(px))
    }

    /// An adjusted pixel to display-linear output primaries, exactly.
    #[inline]
    fn to_display(&self, c: Rgb) -> Rgb {
        match &self.filmic {
            Some(f) => f.apply(c),
            None => mul_vec(&self.to_output, c).map(|v| v.clamp(0.0, 1.0)),
        }
    }

    /// [`adjust`](Self::adjust) on many pixels, one module at a time: each module's
    /// loop has independent pixels for the CPU to overlap. One pixel through the whole
    /// chain is a long dependency chain (colour calibration alone has four matrix
    /// products and three divisions), which made the fused pass latency-bound.
    ///
    /// `planes[i]`: the planes step `i` reads; `start`, the index of `pixels[0]` in them.
    fn adjust_all(&self, pixels: &mut [Rgb], planes: &[StepPlanes], start: usize) {
        match &self.chain {
            Chain::Fixed { affine: (offset, gain), calibration, color_balance, primaries, tone_curve } => {
                pixels.iter_mut().for_each(|c| *c = affine(*c, offset, gain));
                if let Some(stage) = calibration {
                    stage.apply_all(pixels);
                }
                if let Some(stage) = color_balance {
                    stage.apply_all(pixels);
                }
                if let Some(stage) = primaries {
                    pixels.iter_mut().for_each(|c| *c = stage.apply(*c));
                }
                if let Some(stage) = tone_curve {
                    stage.apply_all(pixels, None);
                }
            }
            Chain::Steps(steps) => {
                let n = pixels.len();
                for (i, step) in steps.iter().enumerate() {
                    let at = planes.get(i).copied().unwrap_or_default();
                    let tones = at.tones.map(|p| p.map(|p| &p[start..start + n]));
                    match step {
                        Step::Calibration(stage) => stage.apply_all(pixels),
                        Step::Masked(m) => {
                            // The mask, the step on a copy, then the blend: each a loop of
                            // independent pixels, like the rest of the pass.
                            let mut alpha = [0.0f32; MAX_CHUNK];
                            match at.mask {
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
                            apply_unmasked(&m.step, out, tones);
                            m.blend.mix_all(pixels, out, &alpha[..n]);
                        }
                        _ => apply_unmasked(step, pixels, tones),
                    }
                }
            }
        }
    }

    /// The planes of each step and the drawn plane of each LUT, from `masks` (see
    /// [`adjust_all`](Self::adjust_all)).
    fn planes<'a>(&self, masks: &'a [MaskPlane]) -> Planes<'a> {
        let plane = |id: &str| masks.iter().find(|p| p.id == id).map(|p| p.alpha.as_slice());
        let find = |stage: &MaskStage, id: &str| if stage.drawn { plane(id) } else { None };
        let steps = match &self.chain {
            Chain::Fixed { .. } => Vec::new(),
            Chain::Steps(steps) => steps
                .iter()
                .map(|s| StepPlanes {
                    mask: match s {
                        Step::Masked(m) => find(&m.mask, &m.id),
                        _ => None,
                    },
                    tones: s.tone_planes().and_then(|[m, v]| Some([plane(m)?, plane(v)?])),
                })
                .collect(),
        };
        let looks = self.looks.as_ref().map_or_else(Vec::new, |l| l.luts.iter().map(|l| l.mask.as_ref().and_then(|m| find(&m.stage, &m.id))).collect());
        Planes { steps, looks }
    }

    /// [`adjust`](Self::adjust) on a whole image, with the drawn planes of its masks.
    pub fn adjust_image(&self, img: &Image, masks: &[MaskPlane]) -> Vec<Rgb> {
        let mut out = img.pixels.clone();
        let planes = self.planes(masks);
        for (i, chunk) in out.chunks_mut(MAX_CHUNK).enumerate() {
            self.adjust_all(chunk, &planes.steps, i * MAX_CHUNK);
        }
        out
    }

    /// An adjusted pixel to 8 bits, encoded (without the creative LUTs: see
    /// [`encode_chunk`](Self::encode_chunk)).
    #[inline]
    fn encode(&self, c: Rgb) -> [u8; 3] {
        match &self.filmic {
            Some(f) => f.apply_u8(c, &self.encode),
            None => mul_vec(&self.to_output, c).map(|v| self.encode.eval(v.clamp(0.0, 1.0))),
        }
    }

    /// An adjusted pixel to encoded sRGB, for the creative LUTs: through filmic's table
    /// when it covers the pixel (the output is then sRGB), approximately otherwise.
    /// Filmic's table mustn't have the LUTs baked in.
    #[inline]
    fn encode_srgb(&self, looks: &Looks, c: Rgb) -> Rgb {
        if self.space == ColorSpace::Srgb && self.baked == 0 {
            if let Some(e) = self.filmic.as_ref().and_then(|f| f.lut_encoded(c)) {
                return e;
            }
        }
        looks.linear_srgb(self.to_display(c)).map(|v| looks.srgb_oetf.eval(v))
    }

    /// Adjusted pixels (at most [`MAX_CHUNK`]) to 8 bits, encoded, into `out` (RGBA,
    /// alpha untouched). `planes` and `start`: the LUTs' drawn planes ([`Planes::looks`]).
    #[inline]
    fn encode_chunk(&self, pixels: &[Rgb], out: &mut [u8], planes: &[Option<&[f32]>], start: usize) {
        let Some(looks) = &self.looks else {
            for (c, out) in pixels.iter().zip(out.chunks_exact_mut(4)) {
                out[..3].copy_from_slice(&self.encode(*c));
            }
            return;
        };
        let quantize = |e: Rgb| e.map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
        let mut encoded = [[0.0f32; 3]; MAX_CHUNK];
        let encoded = &mut encoded[..pixels.len()];
        match &self.filmic {
            // Filmic's table has the first LUTs: only the pixels it doesn't cover need them.
            Some(filmic) if self.baked > 0 => encoded.iter_mut().zip(pixels).for_each(|(e, c)| {
                *e = filmic.lut_encoded(*c).unwrap_or_else(|| looks.apply_uniform(self.baked, self.encode_srgb(looks, *c)));
            }),
            _ => encoded.iter_mut().zip(pixels).for_each(|(e, c)| *e = self.encode_srgb(looks, *c)),
        }
        looks.apply_from(self.baked, encoded, pixels, planes, start);
        for (e, out) in encoded.iter().zip(out.chunks_exact_mut(4)) {
            out[..3].copy_from_slice(&quantize(looks.to_output(*e, self.space)));
        }
    }

    /// One pixel, all the way to 8 bits, encoded (masks take their drawn part as
    /// missing: see [`adjust`](Self::adjust)).
    #[inline]
    pub fn apply(&self, px: Rgb) -> [u8; 3] {
        let c = [self.adjust(px)];
        let mut out = [255u8; 4];
        self.encode_chunk(&c, &mut out, &[], 0);
        [out[0], out[1], out[2]]
    }

    /// Apply to a whole image and encode to 8 bits. Masked instances with a drawn
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
            self.adjust_all(buffer, &planes.steps, i * CHUNK);
            self.encode_chunk(buffer, out, &planes.looks, i * CHUNK);
        }
        Rgba8 { width: img.width, height: img.height, data }
    }

    /// Rows `rows` of `img` (with the drawn planes of its masks), exactly, as encoded
    /// output values in [0, 1]: what exports quantise to 8 or 16 bits, row-major.
    pub fn render_encoded_rows(&self, img: &Image, masks: &[MaskPlane], rows: std::ops::Range<usize>, out: &mut Vec<Rgb>) {
        const CHUNK: usize = MAX_CHUNK;
        let planes = self.planes(masks);
        let start = rows.start * img.width;
        let pixels = &img.pixels[start..rows.end * img.width];
        out.clear();
        out.reserve(pixels.len());
        let mut buffer = [[0.0f32; 3]; CHUNK];
        for (i, pixels) in pixels.chunks(CHUNK).enumerate() {
            let buffer = &mut buffer[..pixels.len()];
            buffer.copy_from_slice(pixels);
            self.adjust_all(buffer, &planes.steps, start + i * CHUNK);
            match &self.looks {
                None => out.extend(buffer.iter().map(|&c| self.to_display(c).map(|v| self.space.oetf(v)))),
                Some(looks) => {
                    let mut encoded = [[0.0f32; 3]; CHUNK];
                    let encoded = &mut encoded[..buffer.len()];
                    encoded.iter_mut().zip(buffer.iter()).for_each(|(e, c)| *e = looks.linear_srgb(self.to_display(*c)).map(crate::color::srgb_oetf));
                    looks.apply_from(0, encoded, buffer, &planes.looks, start + i * CHUNK);
                    out.extend(encoded.iter().map(|&e| looks.to_output(e, self.space)));
                }
            }
        }
    }
}

#[inline(always)]
fn fixed_chain(
    px: Rgb,
    (offset, gain): &(Rgb, Rgb),
    calibration: &Option<Box<CalibrationStage>>,
    color_balance: &Option<Box<ColorBalanceStage>>,
    primaries: &Option<Rc<ColorPrimariesStage>>,
    tone_curve: &Option<Box<ToneCurveStage>>,
) -> Rgb {
    let mut c = affine(px, offset, gain);
    if let Some(stage) = calibration {
        c = stage.apply(c);
    }
    if let Some(stage) = color_balance {
        c = stage.apply(c);
    }
    if let Some(stage) = primaries {
        c = stage.apply(c);
    }
    if let Some(stage) = tone_curve {
        c = stage.apply(c);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::{REC2020_FROM_REC709, luminance};
    use crate::shapes::Shape;

    fn ops(f: impl FnOnce(&mut EditParams)) -> PointOps {
        let mut p = EditParams::default();
        p.get_mut::<params::Exposure>().ev = 0.0;
        p.remove(params::ModuleKind::Filmic);
        p.remove(params::ModuleKind::ColorCalibration);
        p.remove(params::ModuleKind::ColorBalance);
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
        assert!(matches!(o.chain, Chain::Fixed { calibration: None, color_balance: None, primaries: None, tone_curve: None, .. }));
        // ((0.1 - 0.01) - 0.02) · 2
        assert!(approx(o.adjust([0.1; 3]), [0.14; 3], 1e-6));
    }

    #[test]
    fn repeated_steps_use_the_generic_chain() {
        let o = ops(|p| {
            p.get_mut::<params::ColorBalance>().chroma = [-0.5; 3];
            p.add(params::ColorBalance { chroma: [-1.0; 3], ..Default::default() });
        });
        assert!(matches!(&o.chain, Chain::Steps(steps) if steps.len() == 3));
        let [r, g, b] = o.adjust([0.5, 0.2, 0.1]);
        assert!((r - g).abs() < 1e-4 && (g - b).abs() < 1e-4, "{r} {g} {b}");
    }

    #[test]
    fn no_chroma_gives_grey() {
        let [r, g, b] = ops(|p| p.get_mut::<params::ColorBalance>().chroma = [-1.0; 3]).adjust([0.5, 0.2, 0.1]);
        assert!((r - g).abs() < 1e-4 && (g - b).abs() < 1e-4, "{r} {g} {b}");
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
    fn shadows_brilliance_lifts_darks_only() {
        let o = ops(|p| p.get_mut::<params::ColorBalance>().brilliance[0] = 1.0);
        let dark = o.adjust([0.01; 3])[0] / 0.01;
        let bright = o.adjust([4.0; 3])[0];
        assert!(dark > 1.5 && (bright / 4.0 - 1.0).abs() < 0.01, "{dark} {bright}");
    }

    #[test]
    fn tone_curve_runs_last_in_the_fixed_chain() {
        let o = ops(|p| {
            p.get_mut::<params::ColorBalance>().chroma = [-1.0; 3];
            p.get_mut::<params::ToneCurve>().rgb = [1.0; params::TONE_CURVE_NODES];
        });
        assert!(matches!(o.chain, Chain::Fixed { color_balance: Some(_), tone_curve: Some(_), .. }));
        let [r, g, b] = o.adjust([0.3, 0.1, 0.05]);
        let grey = ops(|p| p.get_mut::<params::ColorBalance>().chroma = [-1.0; 3]).adjust([0.3, 0.1, 0.05]);
        assert!((r - g).abs() < 1e-4 * r && (g - b).abs() < 1e-4 * r && (r / grey[1] - 2.0).abs() < 1e-2, "{r} {grey:?}");
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

    /// A LUT instance using `lut`, and point ops for `p` with `luts` loaded.
    fn add_lut(p: &mut EditParams, lut: &Clut, interpolation: Interpolation) {
        p.add(params::Lut { lut: Some(params::LutRef { id: lut.id().into(), name: "test".into(), path: None }), interpolation });
    }

    fn ops_with_luts(p: &EditParams, luts: &[&Clut], lut_size: Option<usize>, space: ColorSpace) -> PointOps {
        let mut store = ClutStore::default();
        luts.iter().for_each(|l| store.insert((*l).clone()));
        let filmic = p.get::<params::Filmic>().map(|f| Rc::new(FilmicStage::for_space(f, lut_size, space)));
        PointOps::with_stages(p, None, filmic, &mut |cp| Rc::new(ColorPrimariesStage::build(cp)), &store).for_space(space)
    }

    fn test_image() -> Image {
        let pixels = [0.0f32, 0.002, 0.03, 0.18, 0.6, 2.0, 30.0]
            .iter()
            .flat_map(|&v| [[v, v, v], [v * 1.6, v * 0.9, v * 0.2], [v * 0.1, v * 0.5, v * 1.3]])
            .collect();
        Image { width: 21, height: 1, pixels }
    }

    fn encoded_rows(ops: &PointOps, img: &Image) -> Vec<Rgb> {
        let mut out = Vec::new();
        ops.render_encoded_rows(img, &[], 0..img.height, &mut out);
        out
    }

    #[test]
    fn identity_lut_changes_nothing() {
        let img = test_image();
        let identity = Clut::identity(33);
        for filmic in [true, false] {
            let mut p = EditParams::default();
            if !filmic {
                p.remove(params::ModuleKind::Filmic);
            }
            for lut_size in [None, Some(FILMIC_LUT_SIZE)] {
                let plain = ops_with_luts(&p, &[], lut_size, ColorSpace::Srgb).render(&img);
                let mut with = p.clone();
                add_lut(&mut with, &identity, Interpolation::Tetrahedral);
                let looked = ops_with_luts(&with, &[&identity], lut_size, ColorSpace::Srgb).render(&img);
                let diff = plain.data.iter().zip(&looked.data).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
                assert!(diff <= 1, "filmic {filmic}, table {lut_size:?}: {diff}");
            }
            // Exact (exports), in a wider space too: colours inside sRGB come back.
            for space in [ColorSpace::Srgb, ColorSpace::DisplayP3] {
                let plain = encoded_rows(&ops_with_luts(&p, &[], None, space), &img);
                let mut with = p.clone();
                add_lut(&mut with, &identity, Interpolation::Trilinear);
                let looked = encoded_rows(&ops_with_luts(&with, &[&identity], None, space), &img);
                let inside = |c: &Rgb| {
                    let srgb = ColorSpace::Srgb.rgb_from_xyz();
                    let lin = mul_vec(&crate::color::mul(&srgb, &space.xyz_from_rgb()), c.map(|v| space.eotf(v)));
                    lin.iter().all(|v| (-1e-4..=1.0001).contains(v))
                };
                for (a, b) in plain.iter().zip(&looked) {
                    if inside(a) {
                        assert!(approx(*a, *b, 2e-3), "{space:?}: {a:?} vs {b:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn luts_apply_in_order_after_filmic() {
        let img = test_image();
        let swap = Clut::from_fn(9, |c| [c[2], c[1], c[0]]);
        let darken = Clut::from_fn(9, |c| c.map(|v| v * 0.5));
        let p = EditParams::default();
        let plain = encoded_rows(&ops_with_luts(&p, &[], None, ColorSpace::Srgb), &img);

        let mut with = p.clone();
        add_lut(&mut with, &swap, Interpolation::Tetrahedral);
        add_lut(&mut with, &darken, Interpolation::Tetrahedral);
        let out = encoded_rows(&ops_with_luts(&with, &[&swap, &darken], None, ColorSpace::Srgb), &img);
        for (a, b) in plain.iter().zip(&out) {
            assert!(approx([a[2] * 0.5, a[1] * 0.5, a[0] * 0.5], *b, 1e-4), "{a:?} → {b:?}");
        }

        // 8-bit renders agree, through filmic's table too, and with the LUTs baked into it.
        let mut store = ClutStore::default();
        store.insert(swap.clone());
        store.insert(darken.clone());
        let looks = looks_of(&with, &store);
        let baked = Rc::new(FilmicStage::with_looks(with.get::<params::Filmic>().unwrap(), Some(FILMIC_LUT_SIZE), &looks));
        let baked = PointOps::with_stages(&with, None, Some(baked), &mut |cp| Rc::new(ColorPrimariesStage::build(cp)), &store);
        assert_eq!(baked.baked, 2);
        let renders = [None, Some(FILMIC_LUT_SIZE)].map(|lut_size| ops_with_luts(&with, &[&swap, &darken], lut_size, ColorSpace::Srgb).render(&img));
        for rgba in renders.iter().chain([&baked.render(&img)]) {
            for (e, px) in out.iter().zip(rgba.data.chunks_exact(4)) {
                let diff = (0..3).map(|i| ((e[i] * 255.0).round() - px[i] as f32).abs()).fold(0.0, f32::max);
                assert!(diff <= 2.0, "{e:?} vs {px:?}");
            }
        }
    }

    #[test]
    fn missing_and_disabled_luts_are_skipped() {
        let img = test_image();
        let swap = Clut::from_fn(5, |c| [c[2], c[1], c[0]]);
        let p = EditParams::default();
        let plain = ops_with_luts(&p, &[], None, ColorSpace::Srgb).render(&img);

        let mut missing = p.clone();
        add_lut(&mut missing, &swap, Interpolation::Tetrahedral);
        assert_eq!(ops_with_luts(&missing, &[], None, ColorSpace::Srgb).render(&img).data, plain.data);

        let mut disabled = missing.clone();
        disabled.modules.last_mut().unwrap().enabled = false;
        assert_eq!(ops_with_luts(&disabled, &[&swap], None, ColorSpace::Srgb).render(&img).data, plain.data);

        assert_ne!(ops_with_luts(&missing, &[&swap], None, ColorSpace::Srgb).render(&img).data, plain.data);
    }

    #[test]
    fn masked_steps_blend_in_their_mode() {
        let blended = |blend, fulcrum| {
            ops(|p| {
                p.get_mut::<params::Exposure>().ev = 1.0;
                p.modules[0].mask = Some(params::Mask { blend, blend_fulcrum: fulcrum, opacity: 0.5, ..params::Mask::default() });
            })
        };
        // Multiply by the doubled pixel, around middle grey; half of it.
        let a = 0.05f32;
        let r = a * 2.0 * a / MIDDLE_GREY;
        assert!(approx(blended(params::BlendMode::Multiply, 0.0).adjust([a; 3]), [(a + r) / 2.0; 3], 1e-6));
        // At the fulcrum, multiply leaves the doubled pixel alone… (2a·a/f = 2a with f = a)
        let at = blended(params::BlendMode::Multiply, (a / MIDDLE_GREY).log2()).adjust([a; 3]);
        assert!(approx(at, [1.5 * a; 3], 1e-6), "{at:?}");
        // …and the normal blend at full opacity is no mask at all.
        let normal = ops(|p| {
            p.get_mut::<params::Exposure>().ev = 1.0;
            p.modules[0].mask = Some(params::Mask::default());
        });
        assert!(matches!(normal.chain, Chain::Fixed { .. }));
        let only_blend = blended(params::BlendMode::Lighten, 0.0);
        assert!(matches!(only_blend.chain, Chain::Steps(_)));
    }

    /// `p` with a LUT instance using `lut`, masked by `mask`.
    fn masked_lut(p: &EditParams, lut: &Clut, mask: params::Mask) -> EditParams {
        let mut with = p.clone();
        add_lut(&mut with, lut, Interpolation::Tetrahedral);
        with.modules.last_mut().unwrap().mask = Some(mask);
        with
    }

    #[test]
    fn luts_blend_display_referred() {
        let img = test_image();
        let swap = Clut::from_fn(9, |c| [c[2], c[1], c[0]]);
        let p = EditParams::default();
        let plain = encoded_rows(&ops_with_luts(&p, &[], None, ColorSpace::Srgb), &img);
        let full = encoded_rows(&ops_with_luts(&masked_lut(&p, &swap, params::Mask::default()), &[&swap], None, ColorSpace::Srgb), &img);
        let half = masked_lut(&p, &swap, params::Mask { opacity: 0.5, blend: params::BlendMode::SoftLight, ..params::Mask::default() });
        let out = encoded_rows(&ops_with_luts(&half, &[&swap], None, ColorSpace::Srgb), &img);
        let blend = Blend::display(&half.modules.last().unwrap().mask.clone().unwrap());
        for ((a, b), o) in plain.iter().zip(&full).zip(&out) {
            assert!(approx(blend.mix(*a, *b, 0.5), *o, 1e-4), "{a:?} {b:?} → {o:?}");
        }

        // Uniform: baked into filmic's table, which renders the same.
        let mut store = ClutStore::default();
        store.insert(swap.clone());
        let looks = looks_of(&half, &store);
        assert_eq!(bakeable(&looks).len(), 1);
        let filmic = Rc::new(FilmicStage::with_looks(half.get::<params::Filmic>().unwrap(), Some(FILMIC_LUT_SIZE), bakeable(&looks)));
        let baked = PointOps::with_stages(&half, None, Some(filmic), &mut |cp| Rc::new(ColorPrimariesStage::build(cp)), &store);
        assert_eq!(baked.baked, 1);
        for rgba in [baked.render(&img), ops_with_luts(&half, &[&swap], Some(FILMIC_LUT_SIZE), ColorSpace::Srgb).render(&img)] {
            for (e, px) in out.iter().zip(rgba.data.chunks_exact(4)) {
                let diff = (0..3).map(|i| ((e[i] * 255.0).round() - px[i] as f32).abs()).fold(0.0, f32::max);
                assert!(diff <= 2.0, "{e:?} vs {px:?}");
            }
        }
    }

    #[test]
    fn lut_masks_read_planes_and_filmic_input() {
        let img = test_image();
        let swap = Clut::from_fn(9, |c| [c[2], c[1], c[0]]);
        let darken = Clut::from_fn(9, |c| c.map(|v| v * 0.5));
        let mut p = EditParams::default();
        p.shapes.insert("s".into(), Shape::Ellipse { center: [0.5, 0.5], radii: [0.1, 0.1], rotation: 0.0, feather: 0.0, opacity: 1.0 });
        let drawn = params::Mask { drawn: vec![params::DrawnShape { shape: "s".into(), op: params::ShapeOp::Union }], ..params::Mask::default() };
        let with = masked_lut(&p, &swap, drawn);
        let mut with = with.clone();
        add_lut(&mut with, &darken, Interpolation::Tetrahedral);
        let mut store = ClutStore::default();
        store.insert(swap.clone());
        store.insert(darken.clone());
        // Not uniform: nothing is baked, not even the uniform LUT after it.
        assert_eq!(bakeable(&looks_of(&with, &store)).len(), 0);

        let ops = ops_with_luts(&with, &[&swap, &darken], None, ColorSpace::Srgb);
        let id = with.modules.iter().find(|m| m.mask.is_some()).unwrap().id.clone();
        // The plane: the left half in, the right half out.
        let alpha: Vec<f32> = (0..img.pixels.len()).map(|k| if k < 10 { 1.0 } else { 0.0 }).collect();
        let mut out = Vec::new();
        ops.render_encoded_rows(&img, &[MaskPlane { id, alpha }], 0..1, &mut out);
        let plain = encoded_rows(&ops_with_luts(&EditParams::default(), &[], None, ColorSpace::Srgb), &img);
        for (k, (a, o)) in plain.iter().zip(&out).enumerate() {
            let want = if k < 10 { [a[2] * 0.5, a[1] * 0.5, a[0] * 0.5] } else { a.map(|v| v * 0.5) };
            assert!(approx(want, *o, 1e-4), "{k}: {a:?} → {o:?}");
        }
        // Without its plane, the masked LUT is skipped.
        let skipped = encoded_rows(&ops, &img);
        assert!(plain.iter().zip(&skipped).all(|(a, o)| approx(a.map(|v| v * 0.5), *o, 1e-4)));

        // Ranges are measured on filmic's input: here, scene-referred pixels above middle grey.
        let bright = masked_lut(&EditParams::default(), &swap, params::Mask { luminance: Some([0.0, 0.0, 20.0, 20.0]), ..params::Mask::default() });
        let out = encoded_rows(&ops_with_luts(&bright, &[&swap], None, ColorSpace::Srgb), &img);
        let adjust = ops_with_luts(&bright, &[], None, ColorSpace::Srgb);
        for ((px, a), o) in img.pixels.iter().zip(&plain).zip(&out) {
            let lit = luminance(adjust.adjust(*px)) > MIDDLE_GREY * 1.01;
            let dark = luminance(adjust.adjust(*px)) < MIDDLE_GREY * 0.99;
            if lit {
                assert!(approx([a[2], a[1], a[0]], *o, 1e-4), "{px:?}: {a:?} → {o:?}");
            } else if dark {
                assert!(approx(*a, *o, 1e-6), "{px:?}: {a:?} → {o:?}");
            }
        }
    }

    #[test]
    fn render_encodes_srgb() {
        let img = Image { width: 2, height: 1, pixels: vec![[0.0; 3], [1.0; 3]] };
        let out = ops(|_| {}).render(&img);
        assert_eq!(out.data, [0, 0, 0, 255, 255, 255, 255, 255]);
    }
}
