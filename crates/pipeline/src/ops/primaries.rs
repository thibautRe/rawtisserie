//! Colour primaries: a port of Ansel's `colorprimaries.c` and the parts of
//! `pixel/colorequal_shared.c` it relies on (both GPL-3.0-or-later, © Aurélien Pierre).
//!
//! The user moves six control colours (the primaries and secondaries of a recessed
//! Rec.2020 gamut) in dt UCS hue/saturation/brightness. Each edit becomes a sparse
//! "anchor": a rotation, chroma scale and lightness shift in a cylinder around the
//! grey axis of HLG-encoded RGB. Extra anchors are derived halfway to the neighbours,
//! to grey, to black and to white, and a ladder of no-op anchors pins the grey axis.
//! A compactly supported (Wendland) weighting of the anchors then gives the shift of
//! every colour, which is baked into a 3D lookup table.
//!
//! Per pixel, as in Ansel: divide by the white level, HLG-encode, look up (values
//! outside the unit cube keep the edge's shift plus their excess), decode, multiply.
//! The working space and the table's space share the Rec.2020 primaries, so there
//! is no matrix to apply.
//!
//! One deviation, for speed: the table stores the *linear* change each colour gets,
//! `decode(edited) − decode(original)`, so pixels inside the cube skip the decode and
//! colours out of the edits' reach are left exactly as they are. Interpolating
//! that change rather than the encoded result differs from Ansel by much less
//! than a 16-bit level.

use std::f32::consts::{PI, TAU};

use crate::image::Rgb;
use crate::ops::lut::{exp2_fast, log2_fast};
use crate::params::{self, Primary};

/// Grid size of the table, as in Ansel. Smaller tables are visibly off (a 33³ one by
/// up to 27 levels in 8 bits): the field has sharp features where it meets the cube.
pub const LEVEL: usize = 64;

/// Ansel's `DT_IOP_COLORPRIMARIES_AXIS_ANCHORS`.
const AXIS_ANCHORS: usize = 64;
const SQRT3: f32 = 1.732_050_8;

/// Linear Rec.2020 → CIE XYZ (D65).
const XYZ_FROM_REC2020: [[f32; 3]; 3] = [
    [0.636_958, 0.144_617, 0.168_881],
    [0.262_700, 0.677_998, 0.059_302],
    [0.0, 0.028_073, 1.060_985],
];

// BT.2100 hybrid log-gamma.
const HLG_A: f32 = 0.178_832_77;
const HLG_B: f32 = 0.284_668_92;
const HLG_C: f32 = 0.559_910_73;

/// Linear → HLG, extended to negatives by odd symmetry (like Ansel's profile).
#[inline]
fn hlg_encode(v: f32) -> f32 {
    let a = v.abs();
    let e = if a <= 1.0 / 12.0 { (3.0 * a).sqrt() } else { HLG_A * std::f32::consts::LN_2 * log2_fast(12.0 * a - HLG_B) + HLG_C };
    e.copysign(v)
}

/// HLG → linear.
#[inline]
fn hlg_decode(e: f32) -> f32 {
    let a = e.abs();
    let v = if a <= 0.5 { a * a / 3.0 } else { (exp2_fast((a - HLG_C) / HLG_A * std::f32::consts::LOG2_E) + HLG_B) / 12.0 };
    v.copysign(e)
}

// --- dt UCS 2022 (`common/colorspaces_inline_conversions.h`) ---

fn y_to_l_star(y: f32) -> f32 {
    let y_hat = y.powf(0.631_651_35);
    2.098_883_8 * y_hat / (y_hat + 1.124_267_7)
}

fn l_star_to_y(l_star: f32) -> f32 {
    (1.124_267_7 * l_star / (2.098_883_8 - l_star)).powf(1.583_151_9)
}

/// dt UCS lightness of white (`dt_colorrings_graph_white`).
fn white_l_star() -> f32 {
    y_to_l_star(1.0)
}

/// HLG Rec.2020 → dt UCS hue, saturation, brightness (`dt_colorrings_profile_rgb_to_dt_ucs_hsb`).
fn rgb_to_hsb(rgb: Rgb) -> Rgb {
    let lin = rgb.map(hlg_decode);
    let xyz = crate::color::mul_vec(&XYZ_FROM_REC2020, lin).map(|v| v.max(0.0));
    let sum = xyz[0] + xyz[1] + xyz[2];
    if sum <= 1e-6 {
        return [0.0; 3];
    }
    let (x, y, big_y) = (xyz[0] / sum, xyz[1] / sum, xyz[1]);

    // xyY → dt UCS U*V*'
    let uvd = [
        -0.783_941 * x + 0.277_513 * y + 0.153_836_58,
        0.745_273_54 * x - 0.205_375_87 * y - 0.165_478_38,
        0.318_707_28 * x + 2.167_437 * y + 0.291_320_55,
    ];
    let uv = [uvd[0] / uvd[2], uvd[1] / uvd[2]];
    let uv_star = [1.396_562_3 * uv[0] / (uv[0].abs() + 1.492_173_5), 1.451_395_4 * uv[1] / (uv[1].abs() + 1.524_886_4)];
    let u = -1.124_983_9 * uv_star[0] - 0.980_483_7 * uv_star[1];
    let v = 1.863_233_2 * uv_star[0] + 1.971_853_1 * uv_star[1];

    // → JCH
    let l_white = white_l_star();
    let l_star = y_to_l_star(big_y);
    let m2 = u * u + v * v;
    let j = l_star / l_white;
    let c = 15.932_994 * l_star.powf(0.652_399_75) * m2.powf(0.600_755_7) / l_white;
    let h = v.atan2(u);

    // → HSB
    let b = j * (c.powf(1.336_542_2) + 1.0);
    let s = if b > 0.0 { c / b } else { 0.0 };
    [h, s, b]
}

/// The HLG grey with a given dt UCS brightness (`dt_colorrings_brightness_to_axis_rgb`):
/// with no saturation, brightness is J, and the colour is D65 white.
fn brightness_to_axis(brightness: f32) -> f32 {
    let l_star = brightness.clamp(0.0, 1.0) * white_l_star();
    hlg_encode(l_star_to_y(l_star)).clamp(0.0, 1.0)
}

// --- Cylindrical coordinates around the grey axis (`dt_colorrings_rgb_to_gray_cyl`) ---

const E_L: f32 = 0.577_350_26;
const E_U: [f32; 3] = [0.707_106_77, -0.707_106_77, 0.0];
const E_V: [f32; 3] = [0.408_248_3, 0.408_248_3, -0.816_496_6];

/// `(L, ρ, θ)`: position along the grey axis, distance from it, angle around it.
#[inline]
fn to_cyl(rgb: Rgb) -> (f32, f32, f32) {
    let l = (rgb[0] + rgb[1] + rgb[2]) * E_L;
    let u = rgb[0] * E_U[0] + rgb[1] * E_U[1];
    let v = rgb[0] * E_V[0] + rgb[1] * E_V[1] + rgb[2] * E_V[2];
    (l, (u * u + v * v).sqrt(), v.atan2(u))
}

#[inline]
fn from_basis(l: f32, u: f32, v: f32) -> Rgb {
    std::array::from_fn(|c| l * E_L + u * E_U[c] + v * E_V[c])
}

#[inline]
fn grey(l: f32) -> Rgb {
    [l * E_L; 3]
}

/// Pull `rgb` toward `axis` until it is inside the unit cube (`dt_colorrings_project_to_cube_shell`).
fn project_to_cube(axis: Rgb, rgb: Rgb) -> Rgb {
    let d = [rgb[0] - axis[0], rgb[1] - axis[1], rgb[2] - axis[2]];
    if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() < 1e-6 {
        return rgb;
    }
    let mut distance = f32::INFINITY;
    for c in 0..3 {
        if d[c].abs() < 1e-6 {
            continue;
        }
        let bound = if d[c] > 0.0 { 1.0 } else { 0.0 };
        let t = (bound - axis[c]) / d[c];
        if t > 0.0 && t < distance {
            distance = t;
        }
    }
    let scale = if distance.is_finite() { distance } else { 0.0 };
    let out = if scale < 1.0 { std::array::from_fn(|c| axis[c] + scale * d[c]) } else { rgb };
    out.map(|v| v.clamp(0.0, 1.0))
}

/// Angle in (-π, π].
fn wrap_pi(mut x: f32) -> f32 {
    while x <= -PI {
        x += TAU;
    }
    while x > PI {
        x -= TAU;
    }
    x
}

fn hsb_distance(a: Rgb, b: Rgb) -> f32 {
    let dh = wrap_pi(a[0] - b[0]);
    let (ds, db) = (a[1] - b[1], a[2] - b[2]);
    (dh * dh + ds * ds + db * db).sqrt()
}

fn wendland_c2(d: f32) -> f32 {
    if d >= 1.0 {
        return 0.0;
    }
    let t = 1.0 - d;
    t * t * t * t * (4.0 * d + 1.0)
}

// --- Anchors (`colorprimaries.c`) ---

#[derive(Clone, Copy, Debug)]
struct Anchor {
    l: f32,
    rho: f32,
    theta: f32,
    delta_l: f32,
    chroma_scale: f32,
    delta_theta: f32,
    weight: f32,
}

/// An edit in the module's units, converted: hue in radians, saturation as a fraction.
#[derive(Clone, Copy)]
struct Edit {
    hue: f32,
    saturation: f32,
    brightness: f32,
}

impl Edit {
    fn of(p: &Primary) -> Self {
        Edit { hue: p.hue.to_radians(), saturation: p.saturation * 0.01, brightness: p.brightness }
    }

    fn scaled(self, k: f32) -> Self {
        Edit { hue: k * self.hue, saturation: k * self.saturation, brightness: k * self.brightness }
    }
}

const CORNERS: [Rgb; 6] = [
    [1.0, 0.0, 0.0],
    [1.0, 1.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 1.0, 1.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 1.0],
];

/// A cube corner pulled toward the grey of the same average (`_node_base_rgb`).
fn node_rgb(node: usize, coverage: f32) -> Rgb {
    let corner = CORNERS[node];
    let mu = (corner[0] + corner[1] + corner[2]) / 3.0;
    corner.map(|c| mu + coverage * (c - mu))
}

/// `_build_anchor_from_source_rgb`: the edit as a cylindrical transform at `rgb`.
fn anchor_at(rgb: Rgb, edit: Edit) -> Option<Anchor> {
    let hsb = rgb_to_hsb(rgb);
    let (l, rho, theta) = to_cyl(rgb);
    if rho <= 1e-6 {
        return None;
    }
    // Build the transform from the deltas, so that a zero edit is exactly neutral even
    // where the source saturation leaves [0, 1].
    let source_brightness = hsb[2].clamp(0.0, 1.0);
    let target_brightness = (source_brightness + edit.brightness).clamp(0.0, 1.0);
    let source_axis_l = to_cyl([brightness_to_axis(source_brightness); 3]).0;
    let target_axis_l = to_cyl([brightness_to_axis(target_brightness); 3]).0;
    let chroma_scale = if hsb[1] > 1e-6 { (hsb[1] + edit.saturation).max(0.0) / hsb[1] } else { 1.0 };
    Some(Anchor { l, rho, theta, delta_l: target_axis_l - source_axis_l, chroma_scale, delta_theta: wrap_pi(edit.hue), weight: 1.0 })
}

/// The share of an edit that applies at `mid`, between `source` (full edit) and
/// `other` (none), measured in dt UCS (`_build_halfway_*_anchor_from_source_rgb`).
fn share(source: Rgb, other: Rgb, mid: Rgb) -> f32 {
    let source_hsb = rgb_to_hsb(source);
    let mut other_hsb = rgb_to_hsb(other);
    let mid_hsb = rgb_to_hsb(mid);
    // An achromatic end has no hue of its own: borrow the source's.
    other_hsb[0] = source_hsb[0];
    let (to_source, to_other) = (hsb_distance(mid_hsb, source_hsb), hsb_distance(mid_hsb, other_hsb));
    if to_source + to_other > 1e-6 { to_other / (to_source + to_other) } else { 0.5 }
}

/// Anchor halfway between `rgb` and the grey axis.
fn radial_midpoint_anchor(rgb: Rgb, edit: Edit) -> Option<Anchor> {
    let (l, rho, theta) = to_cyl(rgb);
    if rho <= 1e-6 {
        return None;
    }
    let halfway = from_basis(l, 0.5 * rho * theta.cos(), 0.5 * rho * theta.sin());
    let k = share(rgb, grey(l), halfway);
    anchor_at(halfway, edit.scaled(k))
}

/// Anchor halfway between `rgb` and black or white.
fn extreme_midpoint_anchor(rgb: Rgb, extreme: f32, edit: Edit) -> Option<Anchor> {
    let halfway = rgb.map(|c| 0.5 * (c + extreme));
    let k = share(rgb, [extreme; 3], halfway);
    anchor_at(halfway, edit.scaled(k))
}

/// The midpoint of the gamut edge from node `a` to `a + 1`, with the edit blended
/// from both ends by their dt UCS distances (`_build_edge_edit`).
fn edge_edit(nodes: &[Rgb; 6], edits: &[Edit; 6], a: usize) -> (Rgb, Edit) {
    let b = (a + 1) % 6;
    let mid = std::array::from_fn(|c| 0.5 * (nodes[a][c] + nodes[b][c]));
    let (hsb_a, hsb_b, hsb_mid) = (rgb_to_hsb(nodes[a]), rgb_to_hsb(nodes[b]), rgb_to_hsb(mid));
    let (da, db) = (hsb_distance(hsb_mid, hsb_a), hsb_distance(hsb_mid, hsb_b));
    let (wa, wb) = if da + db > 1e-6 { (db / (da + db), da / (da + db)) } else { (0.5, 0.5) };
    let (ea, eb) = (edits[a], edits[b]);
    let hue = (wa * ea.hue.sin() + wb * eb.hue.sin()).atan2(wa * ea.hue.cos() + wb * eb.hue.cos());
    (mid, Edit { hue, saturation: wa * ea.saturation + wb * eb.saturation, brightness: wa * ea.brightness + wb * eb.brightness })
}

/// The anchors that carry edits, in Ansel's order (`_build_clut`). Where they sit
/// depends on the gamut coverage only.
fn edited_anchors(p: &params::ColorPrimaries) -> Vec<Anchor> {
    let coverage = (p.gamut_coverage * 0.01).clamp(0.0, 1.0);
    let nodes: [Rgb; 6] = std::array::from_fn(|n| node_rgb(n, coverage));
    let edits: [Edit; 6] = p.nodes().map(Edit::of);
    let edges: [(Rgb, Edit); 6] = std::array::from_fn(|a| edge_edit(&nodes, &edits, a));

    let mut out = Vec::with_capacity(36);
    out.extend((0..6).filter_map(|n| anchor_at(nodes[n], edits[n])));
    out.extend(edges.iter().filter_map(|&(rgb, edit)| anchor_at(rgb, edit)));
    out.extend((0..6).filter_map(|n| radial_midpoint_anchor(nodes[n], edits[n])));
    out.extend(edges.iter().filter_map(|&(rgb, edit)| radial_midpoint_anchor(rgb, edit)));
    for extreme in [0.0, 1.0] {
        out.extend((0..6).filter_map(|n| extreme_midpoint_anchor(nodes[n], extreme, edits[n])));
    }
    out
}

/// No-op anchors along the grey axis, which keep it fixed.
fn axis_anchors() -> impl Iterator<Item = Anchor> {
    (0..AXIS_ANCHORS).map(|i| Anchor {
        l: i as f32 / (AXIS_ANCHORS - 1) as f32 * SQRT3,
        rho: 0.0,
        theta: 0.0,
        delta_l: 0.0,
        chroma_scale: 1.0,
        delta_theta: 0.0,
        weight: 1.0 / AXIS_ANCHORS as f32,
    })
}

/// The weight of an anchor on the colour at `(l, rho, theta)`, or 0 out of its reach.
#[inline]
fn anchor_weight(a: &Anchor, (l, rho, theta): (f32, f32, f32), inv_sigma: [f32; 3]) -> f32 {
    let dl = (l - a.l) * inv_sigma[0];
    let dr = (rho - a.rho) * inv_sigma[1];
    let dh = wrap_pi(theta - a.theta) * inv_sigma[2];
    let d2 = dl * dl + dr * dr + dh * dh;
    if d2 >= 1.0 { 0.0 } else { a.weight * wendland_c2(d2.sqrt()) }
}

fn inv_sigma(p: &params::ColorPrimaries) -> [f32; 3] {
    [1.0 / (p.brightness_smoothing * 0.01).max(1e-6), 1.0 / p.saturation_smoothing.max(1e-6), 1.0 / p.hue_smoothing.max(1e-6)]
}

/// The end of `dt_colorrings_eval_sparse_local_field`: the averaged transform, faded
/// out near grey, applied to `x`, then the clamp of `dt_colorrings_fill_lut_sparse_local_field`.
#[inline]
fn finish(x: Rgb, (lx, rhox, thetax): (f32, f32, f32), sums: [f32; 4], rho0: f32) -> Rgb {
    let [sum_w, sum_dl, sum_scale, sum_dtheta] = sums;
    if sum_w <= f32::MIN_POSITIVE {
        return x;
    }
    let (delta_l, scale, delta_theta) = (sum_dl / sum_w, sum_scale / sum_w, sum_dtheta / sum_w);
    if delta_l.abs() <= 1e-6 && (scale - 1.0).abs() <= 1e-6 && delta_theta.abs() <= 1e-6 {
        return x;
    }
    let t = (rhox / rho0).clamp(0.0, 1.0);
    let alpha = t * t * (3.0 - 2.0 * t);
    let l = lx + alpha * delta_l;
    let rho = rhox * (1.0 + alpha * (scale - 1.0)).max(0.0);
    let theta = thetax + alpha * delta_theta;
    project_to_cube(grey(l), from_basis(l, rho * theta.cos(), rho * theta.sin())).map(|v| v.clamp(0.0, 1.0))
}

/// The field evaluated directly, anchor by anchor, as Ansel does (the reference for tests).
#[cfg(test)]
struct Field {
    anchors: Vec<Anchor>,
    inv_sigma_l: f32,
    inv_sigma_rho: f32,
    inv_sigma_theta: f32,
    /// Saturation (ρ) below which the edits fade out.
    rho0: f32,
}

#[cfg(test)]
impl Field {
    fn new(p: &params::ColorPrimaries) -> Self {
        let i = inv_sigma(p);
        let anchors = edited_anchors(p).into_iter().chain(axis_anchors()).collect();
        Self { anchors, inv_sigma_l: i[0], inv_sigma_rho: i[1], inv_sigma_theta: i[2], rho0: p.neutral_protection.max(1e-6) }
    }

    fn eval(&self, x: Rgb) -> Rgb {
        let cyl = to_cyl(x);
        if cyl.1 <= 1e-6 {
            return x;
        }
        let mut sums = [0.0f32; 4];
        for a in &self.anchors {
            let w = anchor_weight(a, cyl, [self.inv_sigma_l, self.inv_sigma_rho, self.inv_sigma_theta]);
            if w <= f32::MIN_POSITIVE {
                continue;
            }
            sums[0] += w;
            sums[1] += w * a.delta_l;
            sums[2] += w * a.chroma_scale;
            sums[3] += w * a.delta_theta;
        }
        finish(x, cyl, sums, self.rho0)
    }
}

/// What the table needs besides the edits themselves: each table node's position
/// around the grey axis and the weight of each anchor on it. Anchors sit at fixed
/// colours, so moving a primary only changes what they carry, and the table can be
/// rebuilt from these weights in a fraction of the time (no distances, no `atan2`).
/// Depends on gamut coverage and smoothing only ([`WeightsKey`]).
pub struct FieldWeights {
    key: WeightsKey,
    nodes: Vec<NodeWeights>,
    /// `(edited anchor index, weight)`, grouped by node.
    entries: Vec<(u16, f32)>,
}

/// The parameters [`FieldWeights`] depend on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WeightsKey {
    gamut_coverage: f32,
    brightness_smoothing: f32,
    saturation_smoothing: f32,
    hue_smoothing: f32,
}

impl WeightsKey {
    pub fn of(p: &params::ColorPrimaries) -> Self {
        Self {
            gamut_coverage: p.gamut_coverage,
            brightness_smoothing: p.brightness_smoothing,
            saturation_smoothing: p.saturation_smoothing,
            hue_smoothing: p.hue_smoothing,
        }
    }
}

struct NodeWeights {
    cyl: (f32, f32, f32),
    /// Total weight of the grey-axis anchors (which carry no edit).
    axis: f32,
    /// End of this node's entries.
    end: u32,
}

impl FieldWeights {
    pub fn new(p: &params::ColorPrimaries) -> Self {
        let anchors = edited_anchors(p);
        let axis: Vec<Anchor> = axis_anchors().collect();
        let inv_sigma = inv_sigma(p);
        let last = (LEVEL - 1) as f32;
        let mut nodes = Vec::with_capacity(LEVEL * LEVEL * LEVEL);
        let mut entries = Vec::new();
        for r in 0..LEVEL {
            for g in 0..LEVEL {
                for b in 0..LEVEL {
                    let cyl = to_cyl([r as f32 / last, g as f32 / last, b as f32 / last]);
                    let mut axis_weight = 0.0;
                    // Greys are left alone.
                    if cyl.1 > 1e-6 {
                        for (i, a) in anchors.iter().enumerate() {
                            let w = anchor_weight(a, cyl, inv_sigma);
                            if w > f32::MIN_POSITIVE {
                                entries.push((i as u16, w));
                            }
                        }
                        axis_weight = axis.iter().map(|a| anchor_weight(a, cyl, inv_sigma)).filter(|&w| w > f32::MIN_POSITIVE).sum();
                    }
                    nodes.push(NodeWeights { cyl, axis: axis_weight, end: entries.len() as u32 });
                }
            }
        }
        Self { key: WeightsKey::of(p), nodes, entries }
    }

    pub fn key(&self) -> WeightsKey {
        self.key
    }
}

/// The module compiled for one set of parameters.
pub struct ColorPrimariesStage {
    white: f32,
    level: usize,
    /// Edited colours, HLG-encoded, indexed `[r][g][b]` over the unit cube of HLG RGB.
    clut: Vec<Rgb>,
    /// The same as linear changes: `decode(clut) − decode(node)`.
    delta: Vec<Rgb>,
}

impl ColorPrimariesStage {
    /// `weights` must be built for the same [`WeightsKey`] as `p`.
    pub fn new(p: &params::ColorPrimaries, weights: &FieldWeights) -> Self {
        assert_eq!(weights.key, WeightsKey::of(p), "colour primaries weights built for other settings");
        let anchors = edited_anchors(p);
        let rho0 = p.neutral_protection.max(1e-6);
        let level = LEVEL;
        let last = (level - 1) as f32;
        let mut clut = Vec::with_capacity(level * level * level);
        let mut start = 0;
        for (i, node) in weights.nodes.iter().enumerate() {
            let x = [i / (level * level), i / level % level, i % level].map(|k| k as f32 / last);
            let end = node.end as usize;
            // The axis anchors carry no edit: weight, and a chroma scale of 1.
            let mut sums = [node.axis, 0.0, node.axis, 0.0];
            for &(a, w) in &weights.entries[start..end] {
                let a = &anchors[a as usize];
                sums[0] += w;
                sums[1] += w * a.delta_l;
                sums[2] += w * a.chroma_scale;
                sums[3] += w * a.delta_theta;
            }
            start = end;
            clut.push(if node.cyl.1 <= 1e-6 { x } else { finish(x, node.cyl, sums, rho0) });
        }
        let delta = clut
            .iter()
            .enumerate()
            .map(|(i, out)| {
                let node = [i / (level * level), i / level % level, i % level].map(|k| k as f32 / last);
                std::array::from_fn(|c| hlg_decode(out[c]) - hlg_decode(node[c]))
            })
            .collect();
        Self { white: p.white_level.exp2().max(1e-6), level, clut, delta }
    }

    /// Build from scratch (for one-off renders).
    pub fn build(p: &params::ColorPrimaries) -> Self {
        Self::new(p, &FieldWeights::new(p))
    }

    /// One pixel, linear Rec.2020 in and out.
    #[inline]
    pub fn apply(&self, px: Rgb) -> Rgb {
        let inv_white = 1.0 / self.white;
        let e = px.map(|v| hlg_encode(v * inv_white));
        if e.iter().all(|v| (0.0..=1.0).contains(v)) {
            let d = Self::lookup(&self.delta, self.level, e);
            return std::array::from_fn(|c| px[c] + d[c] * self.white);
        }
        self.apply_exact(e)
    }

    /// Ansel's path, from HLG-encoded input: outside the cube, the boundary's shift
    /// plus the excess.
    fn apply_exact(&self, e: Rgb) -> Rgb {
        let unit = e.map(|v| v.clamp(0.0, 1.0));
        let out = Self::lookup(&self.clut, self.level, unit);
        std::array::from_fn(|c| hlg_decode(out[c] + e[c] - unit[c]) * self.white)
    }

    /// Tetrahedral interpolation (`dt_lut3d_tetrahedral_interp`), inside the unit cube.
    #[inline]
    fn lookup(table: &[Rgb], n: usize, rgb: Rgb) -> Rgb {
        let last = (n - 1) as f32;
        let coord = rgb.map(|v| v * last);
        let base = coord.map(|c| (c as usize).min(n - 2));
        let [fr, fg, fb] = std::array::from_fn(|i| coord[i] - base[i] as f32);
        let at = |dr: usize, dg: usize, db: usize| table[((base[0] + dr) * n + base[1] + dg) * n + base[2] + db];
        let c000 = at(0, 0, 0);
        let c111 = at(1, 1, 1);
        let (p1, p2, t1, t2, t3) = if fr >= fg {
            if fg >= fb {
                (at(1, 0, 0), at(1, 1, 0), fr, fg, fb)
            } else if fr >= fb {
                (at(1, 0, 0), at(1, 0, 1), fr, fb, fg)
            } else {
                (at(0, 0, 1), at(1, 0, 1), fb, fr, fg)
            }
        } else if fb >= fg {
            (at(0, 0, 1), at(0, 1, 1), fb, fg, fr)
        } else if fb >= fr {
            (at(0, 1, 0), at(0, 1, 1), fg, fb, fr)
        } else {
            (at(0, 1, 0), at(1, 1, 0), fg, fr, fb)
        };
        std::array::from_fn(|c| c000[c] + (p1[c] - c000[c]) * t1 + (p2[c] - p1[c]) * t2 + (c111[c] - p2[c]) * t3)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: Rgb, b: Rgb, tol: f32) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol * y.abs().max(1.0))
    }

    #[test]
    fn hlg_round_trips() {
        for v in [-0.3f32, 0.0, 0.001, 1.0 / 12.0, 0.2, 0.5, 1.0, 3.0] {
            assert!((hlg_decode(hlg_encode(v)) - v).abs() < 2e-5 * v.abs().max(1.0), "{v}");
        }
        assert!((hlg_encode(1.0) - 1.0).abs() < 1e-4);
        assert!((hlg_encode(1.0 / 12.0) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn white_is_brightness_one() {
        let hsb = rgb_to_hsb([1.0; 3]);
        assert!(hsb[1].abs() < 1e-3 && (hsb[2] - 1.0).abs() < 1e-3, "{hsb:?}");
        assert!((brightness_to_axis(1.0) - 1.0).abs() < 1e-3);
        assert!((brightness_to_axis(hsb[2]) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn cylinder_round_trips() {
        let rgb = [0.7, 0.2, 0.4];
        let (l, rho, theta) = to_cyl(rgb);
        assert!(approx(from_basis(l, rho * theta.cos(), rho * theta.sin()), rgb, 1e-6));
    }

    #[test]
    fn defaults_are_identity() {
        let stage = ColorPrimariesStage::build(&params::ColorPrimaries::default());
        for px in [[0.18f32, 0.18, 0.18], [0.5, 0.1, 0.05], [0.02, 0.3, 0.9], [4.0, 1.0, 0.2], [-0.01, 0.1, 0.05]] {
            assert!(approx(stage.apply(px), px, 1e-4), "{px:?} → {:?}", stage.apply(px));
        }
    }

    #[test]
    fn saturating_red_leaves_greys_and_blues() {
        let mut p = params::ColorPrimaries::default();
        p.red.saturation = 40.0;
        let stage = ColorPrimariesStage::build(&p);
        let chroma = |c: Rgb| c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2]);
        let red = [0.4, 0.08, 0.06];
        assert!(chroma(stage.apply(red)) > chroma(red) * 1.1, "{:?}", stage.apply(red));
        for grey in [0.01f32, 0.18, 0.9] {
            assert!(approx(stage.apply([grey; 3]), [grey; 3], 1e-4));
        }
        let blue = [0.02, 0.05, 0.4];
        assert!(approx(stage.apply(blue), blue, 2e-3), "{:?}", stage.apply(blue));
    }

    #[test]
    fn linear_deltas_are_as_accurate_as_ansels_interpolation() {
        let mut p = params::ColorPrimaries::default();
        p.red.hue = 30.0;
        p.green.saturation = -50.0;
        p.blue.brightness = 0.1;
        let stage = ColorPrimariesStage::build(&p);
        let field = Field::new(&p);
        // Errors against the field evaluated exactly, relative to white.
        let (mut fast_err, mut ansel_err) = (0.0f32, 0.0f32);
        for i in 0..4096 {
            let e = [(i % 16) as f32, (i / 16 % 16) as f32, (i / 256) as f32].map(|v| v / 15.0 * 0.999 + 0.0005);
            let px = e.map(|v| hlg_decode(v) * stage.white);
            let exact = field.eval(e).map(|v| hlg_decode(v) * stage.white);
            let err = |out: Rgb| (0..3).map(|c| (out[c] - exact[c]).abs() / stage.white).fold(0.0, f32::max);
            fast_err = fast_err.max(err(stage.apply(px)));
            ansel_err = ansel_err.max(err(stage.apply_exact(e)));
        }
        assert!(fast_err <= ansel_err * 1.05 + 1e-4, "{fast_err} vs Ansel's {ansel_err}");
    }

    #[test]
    fn table_from_weights_is_the_field() {
        let mut p = params::ColorPrimaries::default();
        p.cyan.saturation = 41.0;
        p.cyan.brightness = 0.16;
        p.red.hue = -20.0;
        p.neutral_protection = 0.2;
        let weights = FieldWeights::new(&params::ColorPrimaries { cyan: Primary::default(), ..p.clone() });
        let (stage, field) = (ColorPrimariesStage::new(&p, &weights), Field::new(&p));
        let last = (LEVEL - 1) as f32;
        for (i, out) in stage.clut.iter().enumerate().step_by(97) {
            let x = [i / (LEVEL * LEVEL), i / LEVEL % LEVEL, i % LEVEL].map(|k| k as f32 / last);
            assert!(approx(*out, field.eval(x), 1e-5), "{x:?}: {out:?} vs {:?}", field.eval(x));
        }
    }

    #[test]
    fn hue_shift_moves_red_toward_yellow() {
        let mut p = params::ColorPrimaries::default();
        p.red.hue = 20.0;
        let stage = ColorPrimariesStage::build(&p);
        let red = [0.4, 0.08, 0.06];
        let out = stage.apply(red);
        assert!(out[1] / out[0] > red[1] / red[0] * 1.2, "{out:?}");
    }
}
