//! The colour picker (roadmap 2.7): what one pixel of a render is, as the pointer moves
//! over it. It reads the spatial stages' cached output and runs that pixel through the
//! point modules alone, so it's cheap; without that cache it gives nothing rather than
//! render (a spatial edit is going on: the next render brings the values back).

use serde::Serialize;

use super::{Developer, RenderSize};
use crate::color::{MIDDLE_GREY, luminance};
use crate::image::{Image, Rgb};
use crate::ops::mask::MaskPlane;
use crate::ops::tone_curve::{self, Local};
use crate::params::{self, EditParams, ModuleParams};
use crate::Quality;

/// One pixel of a render.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelSample {
    /// As the render shows it (8-bit, encoded), without the clipping indicators.
    pub display: [u8; 3],
    /// Filmic's input (scene-referred, linear Rec.2020): the image before tone mapping.
    pub scene: Rgb,
    /// Its luminance, EV relative to middle grey.
    pub scene_ev: f32,
    /// What the modules that show data about the image read there.
    pub reads: Vec<ModuleRead>,
}

/// What an instance reads on the pixel, in EV relative to middle grey, as its graph
/// shows it: a tone curve's input (one value, or one per channel), colour balance's input
/// luminance (its ranges' graph).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModuleRead {
    pub id: String,
    pub ev: Vec<f32>,
}

impl Developer {
    /// Pixel `(x, y)` of the render of `params` within `size` (in the whole frame of that
    /// size, not the region's), or `None` outside the region rendered or when the spatial
    /// stages would have to run.
    pub fn sample(&mut self, params: &EditParams, size: RenderSize, x: usize, y: usize) -> Option<PixelSample> {
        if !self.is_spatial_cached(params, size) {
            return None;
        }
        let region = self.output_region(params, size);
        if x < region.x || y < region.y || x >= region.right() || y >= region.bottom() {
            return None;
        }
        let as_shot = self.photo.as_shot_illuminant;
        // As interactive renders do (their filmic table is cached).
        let ops = self.point_ops.render_ops(params, as_shot, Quality::Interactive);
        let (_, img, masks) = self.spatial(params, size);
        let i = (y - region.y) * img.width + (x - region.x);
        let pixel = Image { width: 1, height: 1, pixels: vec![img.pixels[i]] };
        let planes: Vec<MaskPlane> = masks.iter().map(|m| MaskPlane { id: m.id.clone(), alpha: vec![m.alpha[i]] }).collect();

        let rendered = ops.render_masked(&pixel, &planes);
        let display = [rendered.data[0], rendered.data[1], rendered.data[2]];
        let scene = ops.adjust_image(&pixel, &planes)[0];
        let ev = |v: f32| v.max(1e-12).log2() - MIDDLE_GREY.log2();

        let mut reads = Vec::new();
        for (at, instance) in params.modules.iter().enumerate().filter(|(_, m)| m.enabled) {
            let tone = <params::ToneCurve as ModuleParams>::get(&instance.module);
            let balance = <params::ColorBalance as ModuleParams>::get(&instance.module);
            if tone.is_none() && balance.is_none() {
                continue;
            }
            let before = EditParams { version: params.version, modules: params.modules[..at].to_vec(), shapes: params.shapes.clone() };
            let input = self.point_ops.input_ops(&before, as_shot).adjust_image(&pixel, &planes)[0];
            let read = match (tone, balance) {
                (Some(p), _) => {
                    // Preserving detail, the curve reads its smoothed mask.
                    let mask = Local::of(p).map(|local| {
                        let [mean, var] = tone_curve::plane_ids(&instance.id);
                        let plane = |id: &str| planes.iter().find(|q| q.id == id).map(|q| q.alpha.as_slice());
                        let stats = plane(&mean).zip(plane(&var)).map(|(m, v)| [m, v]);
                        local.mask(&[input], stats)[0]
                    });
                    tone_curve::read_ev(p, input, mask)
                }
                _ => vec![ev(luminance(input))],
            };
            reads.push(ModuleRead { id: instance.id.clone(), ev: read });
        }
        Some(PixelSample { display, scene, scene_ev: ev(luminance(scene)), reads })
    }
}

