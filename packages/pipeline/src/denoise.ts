/**
 * Raw denoise (roadmap 3.5): what the page needs to know about its models and the
 * denoised photos it keeps. See `denoise.rs` and `pipeline/denoising.rs`.
 */
import { type EditParams, type ModuleInstance, type DenoiseModel, denoiseModelId } from './params.ts';

/** The newest model version: a recipe on an older one is offered an upgrade. */
export const LATEST_DENOISE_VERSION = 1;

/** Each model's download, in bytes (`scripts/fetch-denoise-models.sh`). */
export const DENOISE_MODEL_BYTES: Readonly<Record<string, number>> = {
  'denoise-quarter-single-v1': 1905413,
  'denoise-quarter-multi-v1': 9448544,
  'denoise-half-single-v1': 7597397,
  'denoise-half-multi-v1': 15141401,
  'denoise-large-single-v1': 30353832,
  'denoise-large-multi-v1': 37899537,
};

/** The recipe's raw denoise instance that does something (enabled, strength > 0), if any. */
export function activeDenoise(params: EditParams): ModuleInstance<'rawDenoise'> | null {
  const m = params.modules.find((m) => m.enabled && m.kind === 'rawDenoise') as ModuleInstance<'rawDenoise'> | undefined;
  return m && m.params.strength > 0 ? m : null;
}

const f32Bits = (v: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, v);
  return view.getUint32(0);
};

/**
 * What a denoised photo for this recipe is named by: the model, the σ map's
 * corrections and the strength, as `f32` bits. Null without raw denoise. Mirrors
 * `DenoiseKey::name`.
 */
export function denoiseKeyName(params: EditParams): string | null {
  const m = activeDenoise(params);
  if (!m) return null;
  const p = m.params;
  const [r, g, b] = p.corrections.map(f32Bits);
  return `${denoiseModelId(p.model)}/n${f32Bits(p.noiseLevel)}/r${r}g${g}b${b}/s${f32Bits(Math.min(1, p.strength))}`;
}

/** Whether a newer model version than `model`'s exists. */
export const denoiseUpgradable = (model: DenoiseModel) => model.version < LATEST_DENOISE_VERSION;
