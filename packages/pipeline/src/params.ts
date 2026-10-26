/**
 * Edit parameters — the "recipe" applied to a RAW file.
 * Mirrors `EditParams` in `crates/pipeline/src/params.rs`; keep both in sync.
 */
export interface EditParams {
  version: number;
  exposure: {
    /** Exposure compensation, EV. */
    ev: number;
    /** Scene-linear black offset. */
    black: number;
  };
  whiteBalance: {
    /** -1 (cooler) … +1 (warmer), relative to as-shot. */
    warmth: number;
    /** -1 (green) … +1 (magenta), relative to as-shot. */
    tint: number;
  };
  color: {
    /** -1 (monochrome) … +1. */
    saturation: number;
    /** -1 … +1, favours muted colours. */
    vibrance: number;
  };
  toneMap: {
    enabled: boolean;
    /** Sigmoid contrast, 0.5 … 4. */
    contrast: number;
    /** -1 … +1. */
    shadows: number;
    /** -1 … +1. */
    highlights: number;
  };
  sharpen: {
    /** 0 = off. */
    amount: number;
    /** Gaussian sigma in full-resolution pixels. */
    radius: number;
  };
  blur: {
    /** Gaussian sigma in full-resolution pixels; 0 = off. */
    radius: number;
  };
  geometry: {
    /** Clockwise quarter turns on top of the camera orientation, 0…3. */
    rotation: number;
    flipHorizontal: boolean;
    /** Straighten angle in degrees, clockwise positive, -45 … 45. */
    angle: number;
    /** Normalised to the oriented, straightened frame. */
    crop: CropRect;
  };
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EDIT_PARAMS_VERSION = 1;

export const defaultEditParams: EditParams = Object.freeze({
  version: EDIT_PARAMS_VERSION,
  exposure: { ev: 0.7, black: 0 },
  whiteBalance: { warmth: 0, tint: 0 },
  color: { saturation: 0, vibrance: 0 },
  toneMap: { enabled: true, contrast: 1.5, shadows: 0, highlights: 0 },
  sharpen: { amount: 0, radius: 1 },
  blur: { radius: 0 },
  geometry: { rotation: 0, flipHorizontal: false, angle: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
}) as EditParams;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Fill in missing fields of a (possibly older or partial) recipe with defaults. */
export function normalizeEditParams(input: unknown): EditParams {
  return merge(defaultEditParams, (input ?? {}) as DeepPartial<EditParams>);
}

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined || patch === null || typeof base !== 'object' || base === null) {
    return (patch ?? base) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    const p = (patch as Record<string, unknown>)[key];
    out[key] =
      typeof value === 'object' && value !== null
        ? merge(value, p as DeepPartial<typeof value>)
        : typeof p === typeof value
          ? p
          : value;
  }
  return out as T;
}

/** Update one nested value immutably: `setParam(p, 'exposure', 'ev', 1.2)`. */
export function setParam<S extends keyof EditParams, K extends keyof EditParams[S]>(
  params: EditParams,
  section: S,
  key: K,
  value: EditParams[S][K],
): EditParams {
  return { ...params, [section]: { ...(params[section] as object), [key]: value } };
}

export function isDefaultEdit(params: EditParams): boolean {
  return JSON.stringify(normalizeEditParams(params)) === JSON.stringify(defaultEditParams);
}
