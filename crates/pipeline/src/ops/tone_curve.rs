//! Tone curve, after Ansel's `rgbcurve.c` (GPL-3.0-or-later; upstream
//! github.com/aurelienpierreeng/ansel, `src/iop/rgbcurve.c` and `src/pixel/rgb_norms.h`
//! at `2b8664f4d3`), drawn like its tone equalizer (`toneequal.c`).
//!
//! Like `rgbcurve.c`: linked or independent RGB curves; linked ones either apply to each
//! channel or scale the pixel by `curve(norm) / norm`, which keeps its hue and saturation.
//!
//! Deviations:
//! * A curve is an exposure offset (EV) as a function of the input exposure (EV relative
//!   to middle grey), through fixed, evenly spaced nodes, as the tone equalizer's is;
//!   not output against input through free nodes on linear 0 … 1. The image is
//!   scene-referred here, with no 1 to stop at, and a flat curve reads as "no change".
//!   It's the contrast equalizer's Catmull-Rom ([`equalizer::curve`]), so the editor
//!   draws what renders; past the end nodes the offset stays the end node's. Unlike
//!   the tone equalizer, it's global: no guided filter. The nodes' range is a
//!   parameter, fitted to the module's input on demand ([`measure`]), as the tone
//!   equalizer's mask exposure and contrast compensations are.
//! * Norms are scaled so that a grey's is its value, so that the curve's axis means
//!   the same with each: "sum" is then "average" and is left out, and "norm" is ÷ √3.
//! * Each curve is baked into a gain table indexed by the input's float bits, as
//!   shadows/highlights is, rather than a 64k table on 0 … 1.

use crate::color::{LUMA_REC2020, MIDDLE_GREY};
use crate::image::Rgb;
use crate::ops::equalizer;
use crate::ops::lut::{BitsLut, CEILING, FINE, FLOOR, log2_fast};
use crate::params::{CurveChannels, RgbNorm, TONE_CURVE_MAX_OFFSET, TONE_CURVE_MIN_RANGE, TONE_CURVE_NODES, ToneCurve};

/// The offset (EV) a curve gives at input exposure `ev` (EV relative to middle grey),
/// with its first and last nodes at `[lo, hi]`.
pub fn offset(nodes: &[f32; TONE_CURVE_NODES], [lo, hi]: [f32; 2], ev: f32) -> f32 {
    // On 0 … 1 both ways, as the editor draws it.
    let m = TONE_CURVE_MAX_OFFSET;
    let unit = nodes.map(|v| 0.5 + v.clamp(-m, m) / (2.0 * m));
    (equalizer::curve(&unit, (ev - lo) / (hi - lo)) - 0.5) * 2.0 * m
}

/// The curve's gain on linear values: what to multiply `v` by.
fn gain_table(nodes: &[f32; TONE_CURVE_NODES], range: [f32; 2]) -> BitsLut<f32> {
    BitsLut::new(FLOOR, CEILING, FINE, |v| offset(nodes, range, (v / MIDDLE_GREY).log2()).exp2())
}

/// Exposures the input histogram covers, EV relative to middle grey.
pub const HISTOGRAM_RANGE: [f32; 2] = [-16.0, 8.0];
/// Bins of the input histogram (0.1 EV each).
pub const HISTOGRAM_BINS: usize = 240;
/// Share of the values left out at each end when fitting the range.
const FIT_TAIL: f64 = 0.005;

/// What a tone curve reads on its input.
pub struct InputHistogram {
    /// One histogram per curve in use (`ToneCurve::curves`: one, or red, green and
    /// blue): the share of the values per bin over [`HISTOGRAM_RANGE`], on a common
    /// scale with the fullest bin of all at 1.
    pub bins: Vec<Vec<f32>>,
    /// The range that holds all but the darkest and brightest 0.5 % of the values
    /// (of all channels), to 0.1 EV, at least [`TONE_CURVE_MIN_RANGE`] wide.
    pub fit: [f32; 2],
}

/// The histogram bin of linear value `v` (`None` unless positive).
#[inline]
fn bin_of(v: f32) -> Option<usize> {
    let [lo, hi] = HISTOGRAM_RANGE;
    let scale = HISTOGRAM_BINS as f32 / (hi - lo);
    (v > 0.0).then(|| ((log2_fast(v) - MIDDLE_GREY.log2() - lo) * scale).clamp(0.0, (HISTOGRAM_BINS - 1) as f32) as usize)
}

/// The histograms of what `p` reads on `pixels` (its input): the norm with linked
/// channels that preserve colours; every channel together with a linked curve per
/// channel; each channel apart with independent ones. `None` without anything positive
/// to measure.
pub fn measure(p: &ToneCurve, pixels: &[Rgb]) -> Option<InputHistogram> {
    let mut counts = match p.channels {
        CurveChannels::Linked => vec![vec![0u32; HISTOGRAM_BINS]],
        CurveChannels::Independent => vec![vec![0u32; HISTOGRAM_BINS]; 3],
    };
    match (p.channels, p.preserve_colors) {
        (CurveChannels::Independent, _) => {
            for c in pixels {
                for (k, &v) in c.iter().enumerate() {
                    if let Some(b) = bin_of(v) {
                        counts[k][b] += 1;
                    }
                }
            }
        }
        (CurveChannels::Linked, RgbNorm::None) => {
            for &v in pixels.iter().flatten() {
                if let Some(b) = bin_of(v) {
                    counts[0][b] += 1;
                }
            }
        }
        (CurveChannels::Linked, norm) => {
            for &c in pixels {
                if let Some(b) = bin_of(rgb_norm(c, norm)) {
                    counts[0][b] += 1;
                }
            }
        }
    }
    let all: Vec<u64> = (0..HISTOGRAM_BINS).map(|b| counts.iter().map(|h| u64::from(h[b])).sum()).collect();
    let total: u64 = all.iter().sum();
    if total == 0 {
        return None;
    }
    // The bins where the cumulative share passes each tail.
    let edge = |share: f64| {
        let mut seen = 0u64;
        all.iter().position(|&n| {
            seen += n;
            seen as f64 >= share * total as f64
        })
    };
    let (first, last) = (edge(FIT_TAIL)?, edge(1.0 - FIT_TAIL)?);
    let [lo, hi] = HISTOGRAM_RANGE;
    let at = |bin: usize| ((lo + bin as f32 * (hi - lo) / HISTOGRAM_BINS as f32) * 10.0).round() / 10.0;
    let (mut a, mut b) = (at(first), at(last + 1));
    if b - a < TONE_CURVE_MIN_RANGE {
        let mid = (a + b) / 2.0;
        (a, b) = (mid - TONE_CURVE_MIN_RANGE / 2.0, mid + TONE_CURVE_MIN_RANGE / 2.0);
    }
    let max = counts.iter().flatten().copied().max().unwrap_or(1).max(1) as f32;
    Some(InputHistogram { bins: counts.iter().map(|h| h.iter().map(|&n| n as f32 / max).collect()).collect(), fit: [a, b] })
}

/// What `p` reads on `input` (its input), as the overlay paints it (8-bit sRGB): black
/// at the first node and white at the last (as a level, sRGB-encoded), the pixels near
/// `node` tinted like a mask, by how much that node moves them. A curve per channel shows
/// each channel in its own; independent curves show `channel`.
pub fn view_colors(p: &ToneCurve, input: &[Rgb], channel: usize, node: Option<usize>) -> Vec<[u8; 3]> {
    let [lo, hi] = p.range();
    let grey = MIDDLE_GREY.log2();
    let last = (TONE_CURVE_NODES - 1) as f32;
    // Position along the nodes, 0 … TONE_CURVE_NODES - 1.
    let position = |v: f32| ((log2_fast(v.max(1e-12)) - grey - lo) / (hi - lo) * last).clamp(0.0, last);
    let level = |t: f32| (t / last * 255.0 + 0.5) as u8;
    // A node's weight is its Catmull-Rom basis, roughly a hat one node wide either way.
    let weight = |t: f32| node.map_or(0.0, |n| (1.0 - (t - n as f32).abs()).max(0.0));
    let (tint, opacity) = crate::ops::clipping::MASK_TINT;
    let tinted = |rgb: [u8; 3], w: f32| -> [u8; 3] {
        let a = w * opacity;
        std::array::from_fn(|k| (rgb[k] as f32 + (tint[k] - rgb[k] as f32) * a + 0.5) as u8)
    };
    input
        .iter()
        .map(|&c| match (p.channels, p.preserve_colors) {
            (CurveChannels::Independent, _) => {
                let t = position(c[channel.min(2)]);
                tinted([level(t); 3], weight(t))
            }
            (CurveChannels::Linked, RgbNorm::None) => {
                let t = c.map(position);
                tinted(t.map(level), t.map(weight).into_iter().fold(0.0, f32::max))
            }
            (CurveChannels::Linked, norm) => {
                let t = position(rgb_norm(c, norm));
                tinted([level(t); 3], weight(t))
            }
        })
        .collect()
}

enum Mode {
    /// The same curve on each channel.
    Linked(BitsLut<f32>),
    /// One curve per channel.
    Channels(Box<[BitsLut<f32>; 3]>),
    /// The pixel scaled by the curve's gain at its norm.
    Norm(RgbNorm, BitsLut<f32>),
}

pub struct ToneCurveStage {
    mode: Mode,
}

impl ToneCurveStage {
    /// `None` when the curves leave the image alone.
    pub fn new(p: &ToneCurve) -> Option<Self> {
        if p.is_identity() {
            return None;
        }
        let r = p.range();
        let mode = match (p.channels, p.preserve_colors) {
            (CurveChannels::Independent, _) => Mode::Channels(Box::new([gain_table(&p.red, r), gain_table(&p.green, r), gain_table(&p.blue, r)])),
            (CurveChannels::Linked, RgbNorm::None) => Mode::Linked(gain_table(&p.rgb, r)),
            (CurveChannels::Linked, norm) => Mode::Norm(norm, gain_table(&p.rgb, r)),
        };
        Some(Self { mode })
    }

    #[inline(always)]
    pub fn apply(&self, c: Rgb) -> Rgb {
        match &self.mode {
            Mode::Linked(lut) => c.map(|v| v * lut.eval(v)),
            Mode::Channels(luts) => [c[0] * luts[0].eval(c[0]), c[1] * luts[1].eval(c[1]), c[2] * luts[2].eval(c[2])],
            Mode::Norm(norm, lut) => {
                let n = rgb_norm(c, *norm);
                // Upstream leaves pixels without a positive norm alone.
                let gain = if n > 0.0 { lut.eval(n) } else { 1.0 };
                c.map(|v| v * gain)
            }
        }
    }

    /// [`apply`](Self::apply) on many pixels, matching the mode once.
    pub fn apply_all(&self, pixels: &mut [Rgb]) {
        match &self.mode {
            Mode::Norm(norm, lut) => {
                let norm = *norm;
                for c in pixels {
                    let n = rgb_norm(*c, norm);
                    let gain = if n > 0.0 { lut.eval(n) } else { 1.0 };
                    *c = c.map(|v| v * gain);
                }
            }
            _ => pixels.iter_mut().for_each(|c| *c = self.apply(*c)),
        }
    }
}

/// See [`RgbNorm`]; `None` gives the average (unused: that mode reads each channel).
#[inline(always)]
fn rgb_norm([r, g, b]: Rgb, norm: RgbNorm) -> f32 {
    match norm {
        RgbNorm::Luminance => r * LUMA_REC2020[0] + g * LUMA_REC2020[1] + b * LUMA_REC2020[2],
        RgbNorm::Max => r.max(g).max(b),
        RgbNorm::Norm => (r * r + g * g + b * b).sqrt() * 0.577_350_27,
        RgbNorm::Power => {
            let sq = r * r + g * g + b * b;
            if sq > 0.0 { (r * r * r + g * g * g + b * b * b) / sq } else { 0.0 }
        }
        RgbNorm::Average | RgbNorm::None => (r + g + b) * (1.0 / 3.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::params::TONE_CURVE_RANGE;

    const NODE_EV: [f32; TONE_CURVE_NODES] = [-9.0, -7.5, -6.0, -4.5, -3.0, -1.5, 0.0, 1.5, 3.0];
    const R: [f32; 2] = TONE_CURVE_RANGE;

    #[test]
    fn passes_through_nodes_and_keeps_end_offsets() {
        let nodes = [0.3, 0.0, -0.5, 0.0, 1.0, 0.0, 0.25, 0.0, -0.75];
        for (ev, want) in NODE_EV.iter().zip(nodes) {
            assert!((offset(&nodes, R, *ev) - want).abs() < 1e-5, "{ev}");
        }
        assert!((offset(&nodes, R, -14.0) - 0.3).abs() < 1e-5);
        assert!((offset(&nodes, R, 8.0) + 0.75).abs() < 1e-5);
        assert_eq!(offset(&[0.0; TONE_CURVE_NODES], R, 1.3), 0.0);
        // Clamped to the editor's range.
        assert!((offset(&[5.0; TONE_CURVE_NODES], R, 0.0) - TONE_CURVE_MAX_OFFSET).abs() < 1e-6);
    }

    #[test]
    fn nodes_follow_the_range() {
        let mut nodes = [0.0; TONE_CURVE_NODES];
        nodes[8] = 1.0;
        assert!((offset(&nodes, [-4.0, 4.0], 4.0) - 1.0).abs() < 1e-5);
        assert!(offset(&nodes, [-4.0, 4.0], 2.0).abs() < 0.2);
        // Too narrow ranges are widened.
        let p = ToneCurve { range: [1.0, 0.5], ..Default::default() };
        assert_eq!(p.range(), [1.0, 1.0 + TONE_CURVE_MIN_RANGE]);
    }

    #[test]
    fn fits_the_range_to_the_input() {
        // Greys from -5 to +2 EV around middle grey, evenly.
        let pixels: Vec<Rgb> = (0..=700).map(|i| [MIDDLE_GREY * (-5.0 + i as f32 / 100.0).exp2(); 3]).collect();
        let h = measure(&ToneCurve::default(), &pixels).unwrap();
        assert_eq!((h.bins.len(), h.bins[0].len()), (1, HISTOGRAM_BINS));
        assert!((h.fit[0] - -5.0).abs() <= 0.11 && (h.fit[1] - 2.0).abs() <= 0.11, "{:?}", h.fit);
        assert_eq!(h.bins[0].iter().cloned().fold(0.0, f32::max), 1.0);
        // Independent channels: one histogram each, on a common scale.
        let reds: Vec<Rgb> = pixels.iter().map(|c| [c[0] * 4.0, c[1], c[2] * 0.25]).collect();
        let p = ToneCurve { channels: CurveChannels::Independent, ..Default::default() };
        let h = measure(&p, &reds).unwrap();
        assert_eq!(h.bins.len(), 3);
        let mean = |b: &Vec<f32>| b.iter().enumerate().map(|(i, &v)| i as f32 * v).sum::<f32>() / b.iter().sum::<f32>();
        let (r, g, b) = (mean(&h.bins[0]), mean(&h.bins[1]), mean(&h.bins[2]));
        assert!((r - g - 20.0).abs() < 1.0 && (g - b - 20.0).abs() < 1.0, "{r} {g} {b}");
        assert!((h.fit[0] - -7.0).abs() <= 0.11 && (h.fit[1] - 4.0).abs() <= 0.11, "{:?}", h.fit);
        // A flat image still gets a usable range.
        let h = measure(&ToneCurve::default(), &[[MIDDLE_GREY; 3]; 10]).unwrap();
        assert!((h.fit[1] - h.fit[0] - TONE_CURVE_MIN_RANGE).abs() < 1e-5 && h.fit[0] < 0.0 && h.fit[1] > 0.0, "{:?}", h.fit);
        assert!(measure(&ToneCurve::default(), &[[0.0; 3]; 4]).is_none());
    }

    #[test]
    fn view_spans_the_range_and_tints_a_node() {
        let p = ToneCurve { range: [-4.0, 4.0], ..Default::default() };
        let px = |ev: f32| [MIDDLE_GREY * ev.exp2(); 3];
        let out = view_colors(&p, &[px(-6.0), px(-4.0), px(0.0), px(4.0), px(9.0)], 0, None);
        let levels: Vec<i32> = out.iter().map(|c| c[0] as i32).collect();
        assert!(levels.iter().zip([0, 0, 128, 255, 255]).all(|(a, b)| (a - b).abs() <= 1), "{levels:?}");
        assert!(out.iter().all(|c| c[0] == c[1] && c[1] == c[2]));
        // Node 4 is at 0 EV: grey there turns yellowish, 2 EV away (two nodes) it doesn't.
        let out = view_colors(&p, &[px(0.0), px(2.0)], 0, Some(4));
        assert!(out[0][2] < out[0][0], "{:?}", out[0]);
        assert_eq!(out[1], view_colors(&p, &[px(2.0)], 0, None)[0]);
    }

    #[test]
    fn flat_curves_do_nothing() {
        assert!(ToneCurveStage::new(&ToneCurve::default()).is_none());
        let p = ToneCurve { channels: CurveChannels::Independent, rgb: [1.0; TONE_CURVE_NODES], ..Default::default() };
        assert!(ToneCurveStage::new(&p).is_none(), "rgb is unused with independent channels");
    }

    #[test]
    fn luminance_mode_keeps_ratios() {
        // +1 EV everywhere.
        let p = ToneCurve { rgb: [1.0; TONE_CURVE_NODES], ..Default::default() };
        let s = ToneCurveStage::new(&p).unwrap();
        let out = s.apply([0.4, 0.2, 0.1]);
        for (o, i) in out.iter().zip([0.4f32, 0.2, 0.1]) {
            assert!((o / i - 2.0).abs() < 1e-3, "{out:?}");
        }
    }

    #[test]
    fn per_channel_mode_moves_each_channel() {
        // Brightens around grey only: channels 3 EV above it don't move.
        let mut rgb = [0.0; TONE_CURVE_NODES];
        rgb[6] = 1.0;
        let p = ToneCurve { rgb, preserve_colors: RgbNorm::None, ..Default::default() };
        let s = ToneCurveStage::new(&p).unwrap();
        let [r, g, _] = s.apply([MIDDLE_GREY, MIDDLE_GREY * 8.0, 0.0]);
        assert!((r / MIDDLE_GREY - 2.0).abs() < 1e-2, "{r}");
        assert!((g / (MIDDLE_GREY * 8.0) - 1.0).abs() < 1e-2, "{g}");
    }

    #[test]
    fn norms_of_grey_are_its_value() {
        for norm in [RgbNorm::Luminance, RgbNorm::Max, RgbNorm::Average, RgbNorm::Norm, RgbNorm::Power] {
            assert!((rgb_norm([0.3; 3], norm) - 0.3).abs() < 1e-6, "{norm:?}");
        }
    }
}
