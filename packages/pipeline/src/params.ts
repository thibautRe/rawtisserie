/**
 * Edit parameters — the "recipe" applied to a RAW file: a list of module instances.
 * Mirrors `EditParams` in `crates/pipeline/src/params.rs`; keep both in sync.
 *
 * The pipeline order is fixed by module kind (`MODULE_KINDS`); instances of the same
 * kind run in list order. A kind with no enabled instance is skipped.
 */

import type { PhotoMetadata } from './metadata.ts';
import { type Shape, freshShapeId, normalizeShape } from './shapes.ts';

export interface ModuleParams {
  /**
   * Raw denoise (AI), on the sensor's mosaic before demosaicing: a network trained by
   * Ansel's ansel-denoise, conditioned on the camera's noise profile. See `denoise.rs`.
   */
  rawDenoise: {
    /** Opacity of the correction, 0 (none) … 1. */
    strength: number;
    /** Which network; stays as it was for a recipe that names it (a newer version is offered). */
    model: DenoiseModel;
    /** Scales the noise the network expects, everywhere, 0 … 2 ("global correction"). */
    noiseLevel: number;
    /** Scales it per CFA colour (R, G, B), 0.5 … 8; the defaults carry the profiles' calibration. */
    corrections: [number, number, number];
  };
  /** Spot removal, on the sensor frame before lens correction: applied in list order. */
  retouch: {
    spots: Spot[];
  };
  /** Lens correction from the data embedded in the file. Strengths scale it: 0 = off, 1 = as specified, up to 2. */
  lens: {
    distortion: number;
    /** Transverse chromatic aberration. */
    tca: number;
    vignetting: number;
  };
  geometry: {
    /** Clockwise quarter turns on top of the camera orientation, 0…3. */
    rotation: number;
    flipHorizontal: boolean;
    /** Straighten angle in degrees, clockwise positive, -45 … 45: the camera's roll. */
    angle: number;
    /** Perspective, as a camera rotation: tilt in degrees, positive for a camera that pointed up, -40 … 40. */
    vertical: number;
    /** Pan in degrees, positive for a camera that pointed left, -40 … 40. */
    horizontal: number;
    /** Vertical shear after the rotation (`y += shear · x`), -0.5 … 0.5. */
    shear: number;
    /** Stretch after the correction: widths × 2^(aspect / 2), heights divided by it, -1 … 1. */
    aspect: number;
    /** How the corrected image is framed without empty borders. */
    autoCrop: AutoCrop;
    /** Normalised to the corrected (and auto-cropped) frame. */
    crop: CropRect;
  };
  /**
   * Diffuse or sharpen, after Ansel's `diffuse.c`: a multiscale anisotropic heat-transfer
   * model (deblur, local contrast, denoise, inpaint highlights, soften). Orders: 1st and
   * 3rd follow the low pass's gradient, 2nd and 4th the detail's; 1st and 2nd act on the
   * low pass, 3rd and 4th on the detail. See `ops/diffuse.rs`.
   */
  diffuse: {
    /** Diffusion steps, 1 … 500 (rounded): more is stronger and slower. */
    iterations: number;
    /** Band size the effect is centred on, in full-resolution pixels (0: the finest). */
    radiusCenter: number;
    /** Spread of the effect around `radiusCenter` over band sizes, in full-resolution pixels. */
    radius: number;
    /** Speed of each order, -1 (sharpen) … 1 (diffuse). */
    speed1: number;
    speed2: number;
    speed3: number;
    speed4: number;
    /** Direction of each order, -10 … 10: 0 every direction, positive along edges, negative across them. */
    anisotropy1: number;
    anisotropy2: number;
    anisotropy3: number;
    anisotropy4: number;
    /** Extra gain on the detail bands, -1 … 1. */
    sharpness: number;
    /** How much edges hold the diffusion back, 0 … 6 (log₁₀ scale). */
    edgeSensitivity: number;
    /** Where the edge penalty starts, -2 … 2 (log₁₀ scale). */
    edgeThreshold: number;
    /** Only diffuse where a channel is above this (at the default exposure's level): inpainting; 0 = everywhere. */
    luminanceThreshold: number;
  };
  /**
   * Contrast equalizer, after Ansel's: local contrast and denoising per detail size.
   * Each curve has `EQUALIZER_NODES` evenly spaced nodes, from coarse (first, about
   * a fifth of the image) to fine (last, a few pixels), each 0 … 1.
   */
  contrastEqualizer: {
    /** Luminance detail gain, (2y)²: 0.5 leaves the image alone, 1 is ×4. */
    luma: number[];
    /** Colour detail gain, like `luma`. */
    chroma: number[];
    /** Edge awareness: higher keeps strong edges out of coarse sizes (fewer halos). */
    edges: number[];
    /** Luminance noise threshold; 0 = off. */
    lumaDenoise: number[];
    /** Colour noise threshold; 0 = off. */
    chromaDenoise: number[];
    /** Strength of the curves relative to their defaults, -2 … 2. */
    mix: number;
  };
  /**
   * Glow: what is brighter than the threshold spreads around, tinted, and is added to
   * the image as light (bloom, halation, diffusion filters). See `ops/glow.rs`.
   */
  glow: {
    /** Where the glow starts, EV over middle grey before exposure, on the brightest channel; -4 … 8. */
    threshold: number;
    /** How gradually pixels start to glow around the threshold (soft knee, a fraction of it), 0 … 1. */
    softness: number;
    /** Spread (the widest Gaussian's sigma), in full-resolution pixels. */
    radius: number;
    /** Shape: a tight halo (-1), an even mix (0) or a long faint tail (1). */
    falloff: number;
    /** Light added, times the light above the threshold; 0 = off. */
    strength: number;
    /** Hue of the tint, degrees (0 red, 120 green, 240 blue). */
    hue: number;
    /** Saturation of the tint, 0 (the light's own colour) … 1. */
    saturation: number;
    /** Round, or along an axis: both ways (an anamorphic streak) or one (motion). */
    shape: GlowShape;
    /** Direction of a streak or motion glow, degrees counterclockwise from the right; motion trails towards it. */
    angle: number;
    /** Spread across a streak or motion glow, a fraction of its spread along; 0 … 1. */
    thickness: number;
  };
  exposure: {
    /** Exposure compensation, EV. */
    ev: number;
    /** Scene-linear black offset. */
    black: number;
  };
  /**
   * Colour calibration, after Ansel's: chromatic adaptation from the scene's light to
   * the working space's white (D65), gamut compression, then mixing in the adaptation's
   * space. Units are Ansel's.
   */
  colorCalibration: {
    /** The light to adapt from. */
    illuminant: Illuminant;
    /** Correlated colour temperature of the daylight and black body illuminants, K, 1667 … 25000. */
    temperature: number;
    fluorescent: Fluorescent;
    led: Led;
    /** Chromaticity of the custom illuminant (CIE 1931 xy). */
    x: number;
    y: number;
    /** Where the light is adapted and colours mixed. "As shot" always uses CAT16. */
    adaptation: Adaptation;
    /** Gamut compression, 0 … 12 (0 = off). */
    gamut: number;
    /** Clip negative values at each step. */
    clip: boolean;
    /** Output channels as a mix of the input ones, -2 … 2 each. */
    red: number[];
    green: number[];
    blue: number[];
    /** Scale each mix so that its coefficients add up to 1. */
    normalizeRed: boolean;
    normalizeGreen: boolean;
    normalizeBlue: boolean;
    /** Colourfulness along each channel, -1 … 1. */
    colorfulness: number[];
    normalizeColorfulness: boolean;
    /** Brightness along each channel, -1 … 1. */
    brightness: number[];
    normalizeBrightness: boolean;
    /** Monochrome mix of the channels, used when any is non-zero; -2 … 2. */
    grey: number[];
    normalizeGrey: boolean;
  };
  /**
   * Colour balance, after Ansel's colour balance rgb (master tab) and split-toning rgb (a
   * light correction and channel mix per range). The image is split into shadows,
   * mid-tones and highlights by luminance, with weights that add up to 1
   * (`toneRangeWeights`). Grading arrays hold `[shadows, mid-tones, highlights]`: the same
   * value in all three acts everywhere (v7's separate global value, folded in by `foldGrading`).
   * Mirrors `params::ColorBalance`.
   */
  colorBalance: {
    /** Rotation of every hue, degrees, -180 … 180. */
    hueShift: number;
    /** Chroma for the muted colours more than for the saturated ones, -1 … 1. */
    vibrance: number;
    /** Linear chroma, -2 … 2 (-1: grey, 1: double). */
    chroma: number[];
    /** Perceptual saturation (dt UCS), -2 … 2. */
    saturation: number[];
    /** Perceptual brilliance (dt UCS), -2 … 2. */
    brilliance: number[];
    shadows: ToneMixer;
    midtones: ToneMixer;
    highlights: ToneMixer;
    /** Centre of the mid-tones, EV relative to middle grey. */
    fulcrum: number;
    /** Width of the mid-tones, EV between the half-way points of their edges, ≥ 0. */
    midtonesRange: number;
    /** EV over which the shadows' weight goes from 90 % to 10 %, ≥ 0.01. */
    shadowsFalloff: number;
    /** The same, between the mid-tones and the highlights. */
    highlightsFalloff: number;
    /** Luminance taken as white by saturation and brilliance, EV relative to middle grey. */
    whiteFulcrum: number;
  };
  /** Colour primaries, after Ansel's: moves six control colours. Units are Ansel's. */
  colorPrimaries: {
    red: Primary;
    yellow: Primary;
    green: Primary;
    cyan: Primary;
    blue: Primary;
    magenta: Primary;
    /** Scene exposure of the brightest colour the edits reach, EV, -2 … 16. */
    whiteLevel: number;
    /** Saturation of the control colours, 0 … 100 % of Rec.2020. */
    gamutCoverage: number;
    /** Reach of each edit along brightness, 1 … 100 %. */
    brightnessSmoothing: number;
    /** Reach of each edit along saturation, 0.01 … 2. */
    saturationSmoothing: number;
    /** Reach of each edit around the hue circle, radians, 0.01 … 2π. */
    hueSmoothing: number;
    /** Saturation below which edits fade out (greys stay grey), 0 … 2; 0 = off. */
    neutralProtection: number;
  };
  /**
   * Tone curve, after Ansel's `rgbcurve.c`, drawn like its tone equalizer: each curve is
   * an exposure offset in EV (0 = no change, ±`TONE_CURVE_MAX_OFFSET`) at
   * `TONE_CURVE_NODES` input exposures evenly spread over `range`, drawn smoothly
   * through them (`curveAt` on 0 … 1). Past the end nodes the offset stays the end node's.
   * Shown as "Tones": preserving detail makes it Ansel's tone equalizer.
   */
  toneCurve: {
    /** One curve for all channels (`rgb`), or one per channel. */
    channels: CurveChannels;
    /** With linked channels: what the curve reads, scaling the channels alike; 'none' applies it to each channel. */
    preserveColors: RgbNorm;
    /** Input exposure of the first and last nodes, EV relative to middle grey; usually fitted to the image. See `toneCurveRange`. */
    range: number[];
    rgb: number[];
    red: number[];
    green: number[];
    blue: number[];
    /**
     * Read each pixel's exposure from an edge-aware smoothed mask of its surroundings
     * (Ansel's tone equalizer): areas move as a whole and keep their texture. The curve
     * is then linked and scales the pixel as a whole ('none' reads the 'norm').
     */
    preserveDetail: boolean;
    /** With `preserveDetail`: the mask's smoothing diameter, a fraction of the frame's long side, `TONE_SMOOTHING_RANGE`. */
    smoothing: number;
    /** With `preserveDetail`: how closely the mask follows edges, `TONE_EDGE_RANGE`; higher keeps more of them. */
    edgeRefinement: number;
    /** How much of the curves applies: their offsets (EV) are scaled by it, 0 (off) to `TONE_STRENGTH_MAX`, 1 as drawn. */
    strength: number;
  };
  /** Filmic RGB tone mapping, after Ansel (spline v3, colour science v8 "AgX"). */
  filmic: {
    /** Scene exposure mapped to display white, EV relative to middle grey. */
    whiteExposure: number;
    /** Scene exposure mapped to display black, EV relative to middle grey (negative). */
    blackExposure: number;
    /** Slope of the linear part, 0 … 5. */
    contrast: number;
    /** Linear share of the range between black and middle grey, 0 … 100 % (the rest is the toe). */
    toe: number;
    /** Linear share of the range between middle grey and white, 0 … 100 % (the rest is the shoulder). */
    shoulder: number;
    /** AgX hue recovery: -100 keeps the film-like drift, +100 restores original hues. */
    huePreservation: number;
    bleach: Bleach;
    /**
     * How much the white/black range is widened (+) or narrowed (-) from the unscaled one,
     * %, -50 … +200. Auto-tune applies it to the measured range; the editor keeps it in
     * step with the white and black exposures (`apps/web/src/develop/filmicRange.ts`).
     */
    dynamicRangeScaling: number;
    /** Derive the display power from the dynamic range (`filmicAutoHardness`) instead of `hardness`. */
    autoHardness: boolean;
    /** Display power ("hardness") applied after the curve, 1 … 10, without `autoHardness`. */
    hardness: number;
    /** Display luminance that black maps to, %, 0 … 20. */
    blackTarget: number;
    /** Display luminance that white maps to, %, 20 … 100. */
    whiteTarget: number;
  };
  /**
   * A creative 3D LUT, display-referred: after filmic, on encoded sRGB, converted to the
   * output space afterwards. Mirrors `params::Lut`.
   */
  lut: {
    /** The LUT; none does nothing. */
    lut: LutRef | null;
    interpolation: LutInterpolation;
  };
}

/**
 * A LUT by its id: the SHA-256 of its canonical form (`Clut::id` in Rust). Renderers are
 * given the tables separately; one they don't have is skipped.
 */
export interface LutRef {
  id: string;
  /** Its name when it was chosen, to tell the user which LUT is missing. */
  name: string;
}

/** How a LUT is interpolated between its nodes. Mirrors `clut::Interpolation`. */
export const LUT_INTERPOLATIONS = ['tetrahedral', 'trilinear', 'pyramid'] as const;
export type LutInterpolation = (typeof LUT_INTERPOLATIONS)[number];

export type ModuleKind = keyof ModuleParams;

/**
 * One range's mixer in colour balance: a CAT16 adaptation from a light of `temperature` to
 * the working space's white, then a 3×3 mix in linear Rec.2020. Mirrors `params::ToneMixer`.
 */
export interface ToneMixer {
  /** Colour temperature of the light to correct, K, 1667 … 25000; `NEUTRAL_TEMPERATURE` changes nothing. */
  temperature: number;
  /** Output channels as a mix of the input ones, -2 … 2 each. */
  red: number[];
  green: number[];
  blue: number[];
  /** Scale each mix so that its coefficients add up to 1. */
  normalizeRed: boolean;
  normalizeGreen: boolean;
  normalizeBlue: boolean;
}

/** The temperature colour balance's mixers leave alone: D65, the working space's white. Mirrors `NEUTRAL_TEMPERATURE`. */
export const NEUTRAL_TEMPERATURE = 6504;

/** Colour balance's ranges, in the order of its weights and grading arrays (after the global entry). */
export const TONE_RANGES = ['shadows', 'midtones', 'highlights'] as const;
export type ToneRange = (typeof TONE_RANGES)[number];

export const SPOT_MODES = ['heal', 'clone', 'fill', 'blur'] as const;
export type SpotMode = (typeof SPOT_MODES)[number];

/** A retouch spot: shape `shape` of the recipe (`EditParams.shapes`), filled according to `mode`. */
export interface Spot {
  shape: string;
  mode: SpotMode;
  /** Heal and clone: where the pixels come from, as an offset from the shape (normalised sensor coordinates). */
  source: [number, number];
  /** 0 … 1, on top of the shape's own opacity. */
  opacity: number;
  /** Fill: the colour, linear Rec.2020 (the base image's, balanced for D65 light). */
  color: [number, number, number];
  /** Blur: Gaussian sigma in full-resolution pixels. */
  radius: number;
}

export const defaultSpot: Readonly<Spot> = Object.freeze<Spot>({
  shape: '',
  mode: 'heal',
  source: [0, 0],
  opacity: 1,
  color: [0.18, 0.18, 0.18],
  radius: 4,
});

/** The edit of one colour primary. */
export interface Primary {
  /** Hue rotation, degrees, -180 … 180. */
  hue: number;
  /** Saturation shift, %, -100 … 100. */
  saturation: number;
  /** Brightness shift, -0.25 … 0.25. */
  brightness: number;
}

export const PRIMARIES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;
export type PrimaryName = (typeof PRIMARIES)[number];

/** Number of nodes of each contrast equalizer curve. */
export const EQUALIZER_NODES = 6;
export const EQUALIZER_CURVES = ['luma', 'chroma', 'edges', 'lumaDenoise', 'chromaDenoise'] as const;
export type EqualizerCurve = (typeof EQUALIZER_CURVES)[number];

/** Number of nodes of each tone curve. Mirrors `TONE_CURVE_NODES`. */
export const TONE_CURVE_NODES = 9;
/** Default exposure of the first and last tone curve nodes, EV relative to middle grey. Mirrors `TONE_CURVE_RANGE`. */
export const TONE_CURVE_RANGE = [-9, 3] as const;
/** Narrowest range of a tone curve's nodes, EV. Mirrors `TONE_CURVE_MIN_RANGE`. */
export const TONE_CURVE_MIN_RANGE = 1;
/** Exposures the tone curve's input histogram covers (`toneCurveInput`), EV. Mirrors `tone_curve::HISTOGRAM_RANGE`. */
export const TONE_HISTOGRAM_RANGE = [-16, 8] as const;
/** Smoothing diameters a tone curve's mask takes (fractions of the long side). Mirrors `TONE_SMOOTHING_RANGE`. */
export const TONE_SMOOTHING_RANGE = [0.001, 1] as const;
/** Edge refinements a tone curve's mask takes. Mirrors `TONE_EDGE_RANGE`. */
export const TONE_EDGE_RANGE = [0.01, 10000] as const;
/** Largest tone curve strength. Mirrors `TONE_STRENGTH_MAX`. */
export const TONE_STRENGTH_MAX = 2;
/** Largest tone curve offset, EV either way. Mirrors `TONE_CURVE_MAX_OFFSET`. */
export const TONE_CURVE_MAX_OFFSET = 2;
export const TONE_CURVE_CURVES = ['rgb', 'red', 'green', 'blue'] as const;
export type ToneCurveCurve = (typeof TONE_CURVE_CURVES)[number];
/** How a glow spreads. Mirrors `GlowShape`. */
export const GLOW_SHAPES = ['round', 'streak', 'motion'] as const;
export type GlowShape = (typeof GLOW_SHAPES)[number];
export const CURVE_CHANNELS = ['linked', 'independent'] as const;
export type CurveChannels = (typeof CURVE_CHANNELS)[number];
/** What a linked tone curve reads, scaled so that a grey's is its value. Mirrors `RgbNorm`. */
export const RGB_NORMS = ['none', 'luminance', 'max', 'average', 'norm', 'power'] as const;
export type RgbNorm = (typeof RGB_NORMS)[number];

export const ILLUMINANTS = [
  'asShot',
  'pipeline',
  'daylight',
  'blackBody',
  'a',
  'e',
  'fluorescent',
  'led',
  'custom',
] as const;
export type Illuminant = (typeof ILLUMINANTS)[number];
export const FLUORESCENTS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;
export type Fluorescent = (typeof FLUORESCENTS)[number];
export const LEDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'bh1', 'rgb1', 'v1', 'v2'] as const;
export type Led = (typeof LEDS)[number];
/** Chromatic adaptation transforms (Ansel's, without non-linear Bradford). */
export const ADAPTATIONS = ['cat16', 'linearBradford', 'xyz', 'none'] as const;
export type Adaptation = (typeof ADAPTATIONS)[number];

/** A raw denoise network: ansel-denoise's `denoise-<size>-<variant>-v<version>.anselnn`. */
export interface DenoiseModel {
  /** The weights' version (ours, pinned by hash), 1 for now. */
  version: number;
  /** Width of the network: each is fitted on its own, so they don't give the same image. */
  size: DenoiseSize;
  /** The fine network alone, or guided by a coarse one on the binned image (less colour blotching). */
  variant: DenoiseVariant;
}
export const DENOISE_SIZES = ['quarter', 'half', 'large'] as const;
export type DenoiseSize = (typeof DENOISE_SIZES)[number];
export const DENOISE_VARIANTS = ['single', 'multi'] as const;
export type DenoiseVariant = (typeof DENOISE_VARIANTS)[number];

/** A denoise model's id, its file's name: mirrors `DenoiseModel::id`. */
export function denoiseModelId(m: DenoiseModel): string {
  return `denoise-${m.size}-${m.variant}-v${m.version}`;
}

/** Module kinds, in pipeline order. */
export const MODULE_KINDS = [
  'rawDenoise',
  'retouch',
  'lens',
  'geometry',
  'diffuse',
  'contrastEqualizer',
  'glow',
  'exposure',
  'colorCalibration',
  'colorBalance',
  'colorPrimaries',
  'toneCurve',
  'filmic',
  'lut',
] as const satisfies readonly ModuleKind[];

/**
 * Kinds an image that isn't a RAW file (a JPEG…, `PhotoMetadata.imageFormat`) doesn't
 * have: it's display-referred already, and its lens was corrected (or not) when it was
 * made. Recipes for one leave them out (`forPhoto`), and the developer doesn't show them.
 */
export const RAW_ONLY_KINDS: readonly ModuleKind[] = ['rawDenoise', 'lens', 'filmic'];

/** Whether a photo with this metadata has `kind` (see `RAW_ONLY_KINDS`). */
export function hasKind(metadata: Pick<PhotoMetadata, 'imageFormat'> | null | undefined, kind: ModuleKind): boolean {
  return !metadata?.imageFormat || !RAW_ONLY_KINDS.includes(kind);
}

/** Kinds whose extra instances are dropped on load. */
export const SINGLE_INSTANCE_KINDS: readonly ModuleKind[] = ['rawDenoise', 'lens', 'geometry', 'filmic'];

/**
 * Kinds whose instances can have a mask: the spatial and point modules before filmic, and
 * the creative LUTs after it. Mirrors `ModuleKind::maskable`.
 */
/**
 * Kinds with an auto-tune that a preset or style can ask for: filmic's white and black
 * exposure, the tone curve's node range. Must match `ModuleKind::auto_tunable` in Rust.
 */
export const AUTO_TUNE_KINDS: readonly ModuleKind[] = ['filmic', 'toneCurve'];

export const MASKABLE_KINDS: readonly ModuleKind[] = [
  'diffuse',
  'contrastEqualizer',
  'glow',
  'exposure',
  'colorCalibration',
  'colorBalance',
  'colorPrimaries',
  'toneCurve',
  'lut',
];

/**
 * Whether a kind blends display-referred (after filmic, on encoded sRGB: no fulcrum)
 * rather than scene-referred. Mirrors `ModuleKind::display_referred`.
 */
export function isDisplayReferred(kind: ModuleKind): boolean {
  return MODULE_KINDS.indexOf(kind) > MODULE_KINDS.indexOf('filmic');
}

/**
 * How a module's output `b` combines with its input `a` (roadmap 4.11), before the mask
 * mixes the result with `a`. Mirrors `params::BlendMode`; see `ops/blend.rs`.
 */
export const BLEND_MODES = [
  'normal',
  'lighten',
  'darken',
  'multiply',
  'divide',
  'addition',
  'subtraction',
  'difference',
  'average',
  'geometricMean',
  'harmonicMean',
  'screen',
  'overlay',
  'softLight',
  'hardLight',
  'chroma',
  'luminance',
  'red',
  'green',
  'blue',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

/** Blend modes that read the fulcrum (scene-referred only). Mirrors `BlendMode::uses_fulcrum`. */
export const FULCRUM_BLEND_MODES: readonly BlendMode[] = [
  'multiply',
  'divide',
  'screen',
  'overlay',
  'softLight',
  'hardLight',
];

export const SHAPE_OPS = ['union', 'intersection', 'difference', 'exclusion'] as const;
/**
 * How a drawn shape combines with what the shapes before it give (`a`, with the shape's
 * alpha `b`): union `max(a, b)`, intersection `a·b`, difference `a·(1 − b)`, exclusion
 * `a + b − 2ab`.
 */
export type ShapeOp = (typeof SHAPE_OPS)[number];

/** A shape of a mask's drawn part. */
export interface DrawnShape {
  /** Id of the shape in `EditParams.shapes`. */
  shape: string;
  /** Ignored for the first shape. */
  op: ShapeOp;
}

/** A feathered range `[a, b, c, d]`: 0 below `a`, rising to 1 at `b`, 1 up to `c`, falling to 0 at `d`. */
export type MaskRange = [number, number, number, number];

/**
 * Where a module instance applies (roadmap 4.5), 0 … 1 per pixel: the drawn part
 * (shapes) times the parametric part (ranges measured on the module's input), feathered,
 * inverted if asked, times `opacity`. Mirrors `params::Mask`; see `ops/mask.rs`.
 */
export interface Mask {
  /** Off, the instance applies everywhere. */
  enabled: boolean;
  /** Shapes of the recipe, combined in order (none: the drawn part is 1 everywhere). */
  drawn: DrawnShape[];
  /** Luminance, EV relative to middle grey; null selects everything. */
  luminance: MaskRange | null;
  /** Saturation: distance from white in CIE u′v′ ×13 (skin ≈ 0.5–0.7, a blue sky ≈ 1, greys 0). */
  saturation: MaskRange | null;
  /** Hue, degrees around white in u′v′ (red ≈ 12, yellow ≈ 86, green ≈ 128, blue ≈ 266); wraps around. */
  hue: MaskRange | null;
  /** Each channel of the working space (linear Rec.2020), EV relative to middle grey. */
  red: MaskRange | null;
  green: MaskRange | null;
  blue: MaskRange | null;
  /**
   * Softens the mask's edges, full-resolution pixels. With ranges, the whole mask is
   * computed with the spatial stages, so its ranges and the point modules before it
   * re-render like spatial edits.
   */
  feather: number;
  /** Feathering follows the image's edges (guided filter) rather than a blur. */
  edgeAware: boolean;
  invert: boolean;
  /** 0 … 1. */
  opacity: number;
  /** How the instance's output combines with its input where the mask applies. */
  blend: BlendMode;
  /**
   * The value multiply, divide, screen, overlay, soft and hard light leave unchanged, in
   * EV relative to middle grey (scene-referred kinds only).
   */
  blendFulcrum: number;
}

export const defaultMask: Readonly<Mask> = Object.freeze<Mask>({
  enabled: true,
  drawn: [],
  luminance: null,
  saturation: null,
  hue: null,
  red: null,
  green: null,
  blue: null,
  feather: 0,
  edgeAware: true,
  invert: false,
  opacity: 1,
  blend: 'normal',
  blendFulcrum: 0,
});

export type ModuleInstance<K extends ModuleKind = ModuleKind> = {
  [P in K]: {
    /** Unique within the recipe; stable across edits. */
    id: string;
    /** Shown next to the module name, to tell instances apart. */
    label: string | null;
    enabled: boolean;
    kind: P;
    params: ModuleParams[P];
    /** Where it applies (maskable kinds only); absent: everywhere. */
    mask?: Mask;
    /**
     * Its auto-tune is to run, and hasn't yet (roadmap 8.7: a preset or style asked for
     * it; see `autoTune.ts`). Rendering ignores it. `AUTO_TUNE_KINDS` only; absent when not.
     */
    autoTune?: true;
  };
}[K];

export interface EditParams {
  version: number;
  /** In pipeline order. */
  modules: ModuleInstance[];
  /**
   * Drawn shapes by id (`shapes.ts`), referenced by retouch spots and masks. Only
   * referenced ones are kept, sorted by id; absent when there are none (as in Rust's JSON).
   */
  shapes?: Record<string, Shape>;
}

/**
 * How geometry frames the straightened, perspective-corrected image: the largest
 * rectangle of the uncorrected frame's aspect, of any aspect, or all of it with empty
 * (black) borders (shown while perspective guides are edited).
 */
export type AutoCrop = 'aspect' | 'area' | 'off';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BLEACH_LEVELS = ['none', 'low', 'medium', 'high', 'extra'] as const;
export type Bleach = (typeof BLEACH_LEVELS)[number];

/**
 * v2: the sigmoid tone mapper was replaced by filmic. v3: a list of module instances.
 * v4: filmic's latitude/balance became independent toe/shoulder sizes.
 * v5: filmic's toe/shoulder measure the linear share instead of the curved one.
 * v6: colour calibration replaces warmth/tint, and does the white balance.
 * v7: colour balance replaces colour (saturation/vibrance) and shadows/highlights.
 * v8: colour balance's global chroma, saturation and brilliance are added to each
 *     range's (the ranges' weights add up to 1, so it looks the same).
 */
export const EDIT_PARAMS_VERSION = 8;

/** Parameters of a new instance of each kind. */
export const defaultModuleParams: { readonly [K in ModuleKind]: ModuleParams[K] } = Object.freeze({
  rawDenoise: {
    strength: 0.85,
    // Upstream's default without a GPU (there's no GPU path yet).
    model: { version: 1, size: 'quarter', variant: 'multi' },
    noiseLevel: 1,
    corrections: [2.82, 3.94, 2.96],
  },
  retouch: { spots: [] },
  lens: { distortion: 1, tca: 1, vignetting: 1 },
  geometry: {
    rotation: 0,
    flipHorizontal: false,
    angle: 0,
    vertical: 0,
    horizontal: 0,
    shear: 0,
    aspect: 0,
    autoCrop: 'aspect',
    crop: { x: 0, y: 0, width: 1, height: 1 },
  },
  // Ansel's "sharpen demosaicing (AA filter)" preset.
  diffuse: {
    iterations: 1,
    radiusCenter: 0,
    radius: 8,
    speed1: -0.25,
    speed2: -0.25,
    speed3: -0.25,
    speed4: -0.25,
    anisotropy1: 1,
    anisotropy2: 1,
    anisotropy3: 1,
    anisotropy4: 1,
    sharpness: 0,
    edgeSensitivity: 1,
    edgeThreshold: 0,
    luminanceThreshold: 0,
  },
  contrastEqualizer: {
    luma: Array<number>(EQUALIZER_NODES).fill(0.5),
    chroma: Array<number>(EQUALIZER_NODES).fill(0.5),
    edges: Array<number>(EQUALIZER_NODES).fill(0.5),
    lumaDenoise: Array<number>(EQUALIZER_NODES).fill(0),
    chromaDenoise: Array<number>(EQUALIZER_NODES).fill(0),
    mix: 1,
  },
  glow: {
    threshold: 1.5,
    softness: 0.5,
    radius: 60,
    falloff: 0,
    strength: 1.5,
    hue: 20,
    saturation: 0,
    shape: 'round',
    angle: 0,
    thickness: 0.05,
  },
  // Ansel's default push for RAW files.
  exposure: { ev: 0.7, black: 0 },
  colorCalibration: {
    illuminant: 'asShot',
    // The working space's white, D65 (Ansel's 5003 K is its D50).
    temperature: 6504,
    fluorescent: 'f3',
    led: 'b5',
    x: 0.3127,
    y: 0.329,
    adaptation: 'cat16',
    gamut: 1,
    clip: true,
    red: [1, 0, 0],
    green: [0, 1, 0],
    blue: [0, 0, 1],
    normalizeRed: true,
    normalizeGreen: true,
    normalizeBlue: true,
    colorfulness: [0, 0, 0],
    normalizeColorfulness: false,
    brightness: [0, 0, 0],
    normalizeBrightness: false,
    grey: [0, 0, 0],
    normalizeGrey: false,
  },
  colorBalance: {
    hueShift: 0,
    vibrance: 0,
    chroma: [0, 0, 0],
    saturation: [0, 0, 0],
    brilliance: [0, 0, 0],
    shadows: defaultToneMixer(),
    midtones: defaultToneMixer(),
    highlights: defaultToneMixer(),
    // Wide shadows and highlights, centred a little under middle grey: narrower ones
    // left most of a typical photo to the mid-tones.
    fulcrum: -1,
    midtonesRange: 3,
    shadowsFalloff: 4,
    highlightsFalloff: 4,
    // Ansel's default, 1 EV (a luminance of 2): log₂(2 / 0.1845).
    whiteFulcrum: 3.44,
  },
  colorPrimaries: {
    ...(Object.fromEntries(PRIMARIES.map((p) => [p, { hue: 0, saturation: 0, brightness: 0 }])) as Record<
      PrimaryName,
      Primary
    >),
    whiteLevel: 1,
    gamutCoverage: 67,
    brightnessSmoothing: 100,
    // Ansel's 1/√2.
    saturationSmoothing: 0.7071,
    hueSmoothing: 0.7071,
    neutralProtection: 0,
  },
  toneCurve: {
    channels: 'linked',
    preserveColors: 'luminance',
    range: [...TONE_CURVE_RANGE],
    rgb: Array<number>(TONE_CURVE_NODES).fill(0),
    red: Array<number>(TONE_CURVE_NODES).fill(0),
    green: Array<number>(TONE_CURVE_NODES).fill(0),
    blue: Array<number>(TONE_CURVE_NODES).fill(0),
    preserveDetail: false,
    // Ansel's: 5 % of the long side, edges refinement 1.
    smoothing: 0.05,
    edgeRefinement: 1,
    strength: 1,
  },
  // Ansel's defaults for RAW files, paired with the +0.7 EV exposure default.
  filmic: {
    whiteExposure: 3.15,
    blackExposure: -8.85,
    contrast: 1.18,
    // Ansel's latitude 10 %, balance 0.
    toe: 10,
    shoulder: 10,
    huePreservation: 0,
    bleach: 'medium',
    dynamicRangeScaling: 0,
    autoHardness: true,
    // Ansel's.
    hardness: 4,
    blackTarget: 0.01517634,
    whiteTarget: 100,
  },
  lut: {
    lut: null,
    interpolation: 'tetrahedral',
  },
});

function defaultToneMixer(): ToneMixer {
  return {
    temperature: NEUTRAL_TEMPERATURE,
    red: [1, 0, 0],
    green: [0, 1, 0],
    blue: [0, 0, 1],
    normalizeRed: true,
    normalizeGreen: true,
    normalizeBlue: true,
  };
}

/** Middle grey, linear. Mirrors `color::MIDDLE_GREY`. */
const MIDDLE_GREY = 0.1845;

/**
 * The weights of colour balance's shadows, mid-tones and highlights at a luminance `ev`
 * (EV relative to middle grey, measured on the module's input). They add up to 1.
 * Mirrors `color_balance::range_weights`.
 */
export function toneRangeWeights(
  p: Pick<ModuleParams['colorBalance'], 'fulcrum' | 'midtonesRange' | 'shadowsFalloff' | 'highlightsFalloff'>,
  ev: number,
): [number, number, number] {
  const x = ev - p.fulcrum;
  const half = Math.max(0, p.midtonesRange) / 2;
  // A logistic goes from 10 % to 90 % over 2 k ln 9.
  const step = (at: number, falloff: number) =>
    1 / (1 + Math.exp(-(x - at) / (Math.max(0.01, falloff) / (2 * Math.log(9)))));
  const s = step(-half, p.shadowsFalloff);
  const h = step(half, p.highlightsFalloff);
  return [1 - s, s * (1 - h), s * h];
}

/**
 * The defaults with the tonal ranges v7 recipes started with, which migrated recipes keep.
 * Mirrors `ColorBalance::with_v7_ranges`.
 */
const legacyRanges = (): ModuleParams['colorBalance'] => ({
  ...structuredClone(defaultModuleParams.colorBalance),
  fulcrum: 0,
  midtonesRange: 4,
  shadowsFalloff: 2,
  highlightsFalloff: 2,
});

/** What a v1–v6 colour instance becomes, approximately. Mirrors `ColorBalance::from_color`. */
function fromColor(saturation: number, vibrance: number): ModuleParams['colorBalance'] {
  const p = legacyRanges();
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  p.chroma = [clamp(saturation), clamp(saturation), clamp(saturation)];
  p.vibrance = clamp(vibrance);
  return p;
}

/** What a v1–v6 shadows/highlights instance becomes, approximately. Mirrors `ColorBalance::from_shadows_highlights`. */
function fromShadowsHighlights(shadows: number, highlights: number): ModuleParams['colorBalance'] {
  const p = legacyRanges();
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  p.brilliance[0] = clamp(shadows);
  p.brilliance[2] = clamp(highlights);
  return p;
}

/** Numbers of a legacy colour or shadows/highlights section (0 where missing or junk). */
const legacyNumber = (params: unknown, key: string) =>
  isObject(params) && typeof params[key] === 'number' && Number.isFinite(params[key]) ? params[key] : 0;

/** A legacy colour or shadows/highlights section as colour balance, if it is one of them. */
function legacyColorBalance(kind: unknown, params: unknown): ModuleParams['colorBalance'] | null {
  if (kind === 'color') return fromColor(legacyNumber(params, 'saturation'), legacyNumber(params, 'vibrance'));
  if (kind === 'shadowsHighlights')
    return fromShadowsHighlights(legacyNumber(params, 'shadows'), legacyNumber(params, 'highlights'));
  return null;
}

/**
 * v3–v6 colour and shadows/highlights instances become colour balance instances,
 * keeping their id, label, switch and mask. Mirrors `migrate_color_balance`.
 */
function migrateColorBalance(raw: Record<string, unknown>) {
  if (!Array.isArray(raw.modules)) return;
  raw.modules = raw.modules.map((m: unknown) => {
    const params = isObject(m) ? legacyColorBalance(m.kind, m.params) : null;
    return params ? { ...(m as object), kind: 'colorBalance', params } : m;
  });
}

const instance = <K extends ModuleKind>(kind: K, id = ''): ModuleInstance<K> =>
  ({ id, label: null, enabled: true, kind, params: structuredClone(defaultModuleParams[kind]) }) as ModuleInstance<K>;

/**
 * The recipe a new image starts with: exposure, white balance as shot (colour
 * calibration), colour balance's "Colorfulness: standard" preset and filmic, marked for
 * its auto-tune (`autoTune.ts`: whoever has the image runs it). Mirrors
 * `EditParams::default`.
 */
export const defaultEditParams: EditParams = Object.freeze({
  version: EDIT_PARAMS_VERSION,
  modules: [
    instance('exposure', 'exposure'),
    instance('colorCalibration', 'colorCalibration'),
    {
      ...instance('colorBalance', 'colorBalance'),
      params: { ...defaultModuleParams.colorBalance, saturation: [0.45, 0.2, 0.2] },
    },
    { ...instance('filmic', 'filmic'), autoTune: true as const },
  ],
});

/**
 * A version's original (history at 0): the default recipe without its auto-tunes, as
 * renderers show it. Nothing resolves them there, so it looks the same everywhere.
 * Modules compare with it and reset to it.
 */
export const originalEditParams: EditParams = Object.freeze({
  ...defaultEditParams,
  modules: defaultEditParams.modules.map(({ autoTune: _, ...m }) => m as ModuleInstance),
});

/**
 * The label of the history entry a new image starts with: `defaultRecipe`, its
 * auto-tunes run. It doesn't make the version "edited".
 */
export const AUTO_RECIPE_LABEL = 'Defaults (auto)';
/** `AUTO_RECIPE_LABEL`, and what it used to be (when only lens correction made one). */
export const AUTO_RECIPE_LABELS: readonly string[] = [AUTO_RECIPE_LABEL, 'Lens correction (auto)'];

/** What an image that isn't a RAW file starts with, and its original: nothing. */
export const emptyEditParams: EditParams = Object.freeze({ version: EDIT_PARAMS_VERSION, modules: [] });

type RecipeMetadata = Pick<PhotoMetadata, 'lensCorrection' | 'imageFormat'>;

/**
 * The recipe a new image starts with, given what its file contains: the default
 * recipe, plus lens correction when the file embeds correction data; nothing for an
 * image that isn't a RAW file (developed already). Mirrors `EditParams::default_for`.
 */
export function defaultRecipe(metadata: Partial<RecipeMetadata>): EditParams {
  if (metadata.imageFormat) return emptyEditParams;
  if (!metadata.lensCorrection) return defaultEditParams;
  return { ...defaultEditParams, modules: [instance('lens', 'lens'), ...structuredClone(defaultEditParams.modules)] };
}

/**
 * A version's original (history at 0) for a file with this metadata (`null` when it's
 * not known yet): `originalEditParams`, or nothing for an image that isn't a RAW file.
 */
export function originalRecipe(metadata: Partial<RecipeMetadata> | null | undefined): EditParams {
  return metadata?.imageFormat ? emptyEditParams : originalEditParams;
}

/**
 * `recipe` for a photo with this metadata: without the kinds it doesn't have (a style
 * or a pasted edit from a RAW file applied to a JPEG). The same recipe if nothing goes.
 */
export function forPhoto(
  recipe: EditParams,
  metadata: Pick<PhotoMetadata, 'imageFormat'> | null | undefined,
): EditParams {
  if (recipe.modules.every((m) => hasKind(metadata, m.kind))) return recipe;
  return normalize(
    recipe.modules.filter((m) => hasKind(metadata, m.kind)),
    recipe.shapes,
  );
}

const rank = (kind: ModuleKind) => MODULE_KINDS.indexOf(kind);
const isKind = (kind: unknown): kind is ModuleKind => MODULE_KINDS.includes(kind as ModuleKind);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a recipe of any version: v1/v2 recipes are migrated, missing fields get their
 * defaults, and the result is normalised like `EditParams::normalize` in Rust. Junk
 * (wrong types, unknown module kinds) is dropped, where Rust would refuse it.
 */
export function normalizeEditParams(input: unknown): EditParams {
  const raw = isObject(input) ? structuredClone(input) : {};
  migrateFilmic(raw);
  const version = typeof raw.version === 'number' ? raw.version : 0;
  const whiteBalance = version < 6 ? takeWhiteBalance(raw) : [];
  if (version < 7) migrateColorBalance(raw);
  const modules = version < 3 && !('modules' in raw) ? migrateV2(raw) : v3Modules(raw);
  // The base image used to be balanced as shot; now colour calibration does it.
  if (version < 6) modules.push({ ...instance('colorCalibration'), params: fromWhiteBalance(whiteBalance) });
  return normalize(modules, readShapes(raw.shapes));
}

/** Valid shapes of untrusted input (Rust refuses invalid ones; they are dropped here). */
function readShapes(input: unknown): Record<string, Shape> {
  if (!isObject(input)) return {};
  const out: Record<string, Shape> = {};
  for (const [id, value] of Object.entries(input)) {
    const shape = normalizeShape(value);
    if (shape) out[id] = shape;
  }
  return out;
}

function v3Modules(raw: Record<string, unknown>): ModuleInstance[] {
  const modules: ModuleInstance[] = [];
  for (const m of Array.isArray(raw.modules) ? raw.modules : []) {
    if (!isObject(m) || !isKind(m.kind)) continue;
    const instance = {
      id: typeof m.id === 'string' ? m.id : '',
      label: typeof m.label === 'string' ? m.label : null,
      enabled: typeof m.enabled === 'boolean' ? m.enabled : true,
      kind: m.kind,
      params: moduleParams(m.kind, m.params),
    } as ModuleInstance;
    if (isObject(m.mask)) instance.mask = maskParams(m.mask);
    if (m.autoTune === true) instance.autoTune = true;
    modules.push(instance);
  }
  return modules;
}

/** A mask from untrusted input: missing or invalid fields get their defaults (Rust refuses those). */
export function maskParams(input: unknown): Mask {
  const p = isObject(input) ? input : {};
  const range = (v: unknown): MaskRange | null =>
    Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
      ? ([...v] as MaskRange)
      : null;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const drawn = (Array.isArray(p.drawn) ? p.drawn : []).filter(isObject).map((d): DrawnShape => ({
    shape: typeof d.shape === 'string' ? d.shape : '',
    op: SHAPE_OPS.includes(d.op as ShapeOp) ? (d.op as ShapeOp) : 'union',
  }));
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : defaultMask.enabled,
    drawn,
    luminance: range(p.luminance),
    saturation: range(p.saturation),
    hue: range(p.hue),
    red: range(p.red),
    green: range(p.green),
    blue: range(p.blue),
    feather: num(p.feather, defaultMask.feather),
    edgeAware: typeof p.edgeAware === 'boolean' ? p.edgeAware : defaultMask.edgeAware,
    invert: typeof p.invert === 'boolean' ? p.invert : defaultMask.invert,
    opacity: num(p.opacity, defaultMask.opacity),
    blend: BLEND_MODES.includes(p.blend as BlendMode) ? (p.blend as BlendMode) : defaultMask.blend,
    blendFulcrum: num(p.blendFulcrum, defaultMask.blendFulcrum),
  };
}

/**
 * Remove the warmth/tint white balance of a v1–v5 recipe; returns the enabled ones'
 * `[warmth, tint]`, in pipeline order. Mirrors `take_white_balance`.
 */
function takeWhiteBalance(raw: Record<string, unknown>): [number, number][] {
  const read = (p: unknown): [number, number] => {
    const get = (key: string) => (isObject(p) && typeof p[key] === 'number' ? p[key] : 0);
    return [get('warmth'), get('tint')];
  };
  if (Array.isArray(raw.modules)) {
    const isWb = (m: unknown): m is Record<string, unknown> => isObject(m) && m.kind === 'whiteBalance';
    const found = raw.modules
      .filter(isWb)
      .filter((m) => m.enabled !== false)
      .map((m) => read(m.params));
    raw.modules = raw.modules.filter((m) => !isWb(m));
    return found;
  }
  if (!('whiteBalance' in raw)) return [];
  const wb = raw.whiteBalance;
  delete raw.whiteBalance;
  return [read(wb)];
}

/**
 * The default colour calibration, with the gains of v1–v5 warmth/tint instances
 * (applied after the white balance) folded into its channel mix. Mirrors
 * `ColorCalibration::from_white_balance`; computed the same way, in f64 from the same
 * f32 constants, and rounded, so that both give the same numbers.
 */
export function fromWhiteBalance(instances: [number, number][]): ModuleParams['colorCalibration'] {
  const p = structuredClone(defaultModuleParams.colorCalibration);
  const f = Math.fround;
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  let gains = [1, 1, 1];
  for (const [warmth, tint] of instances) {
    const w = clamp(f(warmth)) * 0.5;
    const t = clamp(f(tint)) * 0.35;
    const wb = [2 ** w, 2 ** -t, 2 ** -w];
    const luma = LUMA_REC2020.map(f);
    const y = wb[0]! * luma[0]! + wb[1]! * luma[1]! + wb[2]! * luma[2]!;
    gains = gains.map((g, c) => g * (wb[c]! / y));
  }
  if (gains.some((g) => g !== 1)) {
    const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    const [red, green, blue] = mixForRgbGains(gains).map((row) => row.map(round));
    Object.assign(p, { red, green, blue, normalizeRed: false, normalizeGreen: false, normalizeBlue: false });
  }
  return p;
}

type Mat3 = number[][];
const LUMA_REC2020 = [0.2627, 0.678, 0.0593];
export const XYZ_FROM_REC709 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const REC709_FROM_XYZ = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];
export const REC2020_FROM_REC709 = [
  [0.6274039, 0.329283, 0.0433131],
  [0.0690973, 0.9195404, 0.0113623],
  [0.0163914, 0.0880133, 0.8955953],
];
export const REC709_FROM_REC2020 = [
  [1.660491, -0.5876411, -0.0728499],
  [-0.1245505, 1.1328999, -0.0083494],
  [-0.0181508, -0.1005789, 1.1187297],
];
export const XYZ_TO_CAT16 = [
  [0.401288, 0.650173, -0.051461],
  [-0.250268, 1.204414, 0.045854],
  [-0.002079, 0.048952, 0.953127],
];
const CAT16_TO_XYZ = [
  [1.862068, -1.011255, 0.149187],
  [0.38752, 0.621447, -0.008974],
  [-0.015841, -0.034123, 1.049964],
];

function mul(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i]![k]! * b[k]![j]!;
      return s;
    }),
  );
}

/**
 * Filmic's display power with `autoHardness`: the one that brings the log-encoded grey to
 * display grey. Mirrors `Spline::new` (`ops/filmic.rs`).
 */
export function filmicAutoHardness(p: Pick<ModuleParams['filmic'], 'whiteExposure' | 'blackExposure'>): number {
  const white = Math.min(16, Math.max(0.1, p.whiteExposure));
  const black = Math.min(-0.1, Math.max(-16, p.blackExposure));
  const greyLog = Math.abs(black) / (white - black);
  return Math.log(0.1845) / Math.log(greyLog);
}

/** The CAT16 mix equal to per-channel gains in linear Rec.2020. Mirrors `mix_for_rgb_gains`. */
function mixForRgbGains(gains: number[]): Mat3 {
  const f = (m: Mat3) => m.map((row) => row.map(Math.fround));
  const lmsFromRgb = mul(f(XYZ_TO_CAT16), mul(f(XYZ_FROM_REC709), f(REC709_FROM_REC2020)));
  const rgbFromLms = mul(f(REC2020_FROM_REC709), mul(f(REC709_FROM_XYZ), f(CAT16_TO_XYZ)));
  const diag = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? gains[i]! : 0)));
  return mul(lmsFromRgb, mul(diag, rgbFromLms));
}

/** A tone curve's node range as used: at least `TONE_CURVE_MIN_RANGE` wide. Mirrors `ToneCurve::range`. */
export function toneCurveRange(p: Pick<ModuleParams['toneCurve'], 'range'>): [number, number] {
  const [lo, hi] = p.range as [number, number];
  return [lo, Math.max(hi, lo + TONE_CURVE_MIN_RANGE)];
}

/** Colour balance's grading arrays, one value per range. */
export const GRADING_KEYS = ['chroma', 'saturation', 'brilliance'] as const;

/**
 * Colour balance parameters with v7's `[global, shadows, mid-tones, highlights]` grading
 * arrays as `[shadows, mid-tones, highlights]`, the global value added to each (each
 * clamped to ±1 first, as v7 rendered them), rounded to 1e-4 like Rust's (in f32).
 * Recipes, presets and styles of any version
 * go through it. Mirrors `params::grading`.
 */
function foldGrading(input: unknown): unknown {
  if (!isObject(input)) return input;
  const out = { ...input };
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  for (const key of GRADING_KEYS) {
    const v = out[key];
    if (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      const [g, ...ranges] = (v as number[]).map(clamp);
      out[key] = ranges.map((r) => Math.round((g! + r) * 1e4) / 1e4);
    }
  }
  return out;
}

/** The parameters of a `kind` instance from untrusted input: missing or invalid fields get their defaults. */
export function moduleParams<K extends ModuleKind>(kind: K, input: unknown): ModuleParams[K] {
  if (kind === 'retouch') {
    const spots = isObject(input) && Array.isArray(input.spots) ? input.spots : [];
    return { spots: spots.map(spotParams) } as ModuleParams[K];
  }
  if (kind === 'colorBalance') input = foldGrading(input);
  const params = merge(defaultModuleParams[kind], input as DeepPartial<ModuleParams[K]>);
  if (kind === 'rawDenoise') {
    const m = (params as ModuleParams['rawDenoise']).model;
    const d = defaultModuleParams.rawDenoise.model;
    if (!DENOISE_SIZES.includes(m.size)) m.size = d.size;
    if (!DENOISE_VARIANTS.includes(m.variant)) m.variant = d.variant;
    if (!Number.isInteger(m.version) || m.version < 1) m.version = d.version;
  }
  if (kind === 'filmic') {
    const f = params as ModuleParams['filmic'];
    if (!BLEACH_LEVELS.includes(f.bleach)) f.bleach = defaultModuleParams.filmic.bleach;
  }
  if (kind === 'colorCalibration') {
    const c = params as ModuleParams['colorCalibration'];
    const d = defaultModuleParams.colorCalibration;
    if (!ILLUMINANTS.includes(c.illuminant)) c.illuminant = d.illuminant;
    if (!FLUORESCENTS.includes(c.fluorescent)) c.fluorescent = d.fluorescent;
    if (!LEDS.includes(c.led)) c.led = d.led;
    if (!ADAPTATIONS.includes(c.adaptation)) c.adaptation = d.adaptation;
  }
  if (kind === 'lut') {
    const l = params as ModuleParams['lut'];
    const ref: unknown = isObject(input) ? input.lut : null;
    l.lut = isObject(ref)
      ? { id: typeof ref.id === 'string' ? ref.id : '', name: typeof ref.name === 'string' ? ref.name : '' }
      : null;
    if (!LUT_INTERPOLATIONS.includes(l.interpolation)) l.interpolation = defaultModuleParams.lut.interpolation;
  }
  if (kind === 'glow') {
    const g = params as ModuleParams['glow'];
    if (!GLOW_SHAPES.includes(g.shape)) g.shape = defaultModuleParams.glow.shape;
  }
  if (kind === 'toneCurve') {
    const t = params as ModuleParams['toneCurve'];
    const d = defaultModuleParams.toneCurve;
    if (!CURVE_CHANNELS.includes(t.channels)) t.channels = d.channels;
    if (!RGB_NORMS.includes(t.preserveColors)) t.preserveColors = d.preserveColors;
  }
  return params;
}

/** The LUTs the enabled instances use, without repeats, in pipeline order. Mirrors `EditParams::lut_ids`. */
export function lutIds(params: EditParams): string[] {
  const ids = params.modules.flatMap((m) =>
    m.enabled && m.kind === 'lut' ? [(m as ModuleInstance<'lut'>).params.lut?.id] : [],
  );
  return [...new Set(ids.filter((id): id is string => id !== undefined))];
}

/** A spot from untrusted input: missing or invalid fields get their defaults. */
export function spotParams(input: unknown): Spot {
  const p = merge(defaultSpot as Spot, input as DeepPartial<Spot>);
  if (!SPOT_MODES.includes(p.mode)) p.mode = defaultSpot.mode;
  return p;
}

/**
 * Unique non-empty ids, one instance of single-instance kinds, pipeline order, masks only
 * on maskable kinds, no spots or drawn mask parts without their shape, and no shapes that
 * nothing uses. Mirrors `EditParams::normalize`.
 */
function normalize(input: ModuleInstance[], shapes: Record<string, Shape> = {}): EditParams {
  const seen = new Set<ModuleKind>();
  const modules = input
    .filter((m) => !SINGLE_INSTANCE_KINDS.includes(m.kind) || (!seen.has(m.kind) && seen.add(m.kind)))
    .sort((a, b) => rank(a.kind) - rank(b.kind)); // stable

  const ids = new Set<string>();
  for (const [i, m] of modules.entries()) {
    if (m.id === '' || ids.has(m.id)) {
      const others = new Set(modules.filter((_, j) => j !== i).map((o) => o.id));
      modules[i] = { ...m, id: freshId(m.kind, (id) => ids.has(id) || others.has(id)) };
    }
    ids.add(modules[i]!.id);
  }

  const exists = (id: string) => (id in shapes ? id : null);
  for (const [i, m] of modules.entries()) {
    const params = mapShapeRefs(m.kind, m.params, exists);
    if (params !== m.params) modules[i] = { ...m, params } as ModuleInstance;
    if (m.autoTune && !AUTO_TUNE_KINDS.includes(m.kind)) {
      const { autoTune: _, ...rest } = modules[i]!;
      modules[i] = rest as ModuleInstance;
    }
    if (m.mask && !MASKABLE_KINDS.includes(m.kind)) {
      const { mask: _, ...rest } = modules[i]!;
      modules[i] = rest as ModuleInstance;
    } else if (m.mask) {
      const mask = mapMaskShapeRefs(m.mask, exists);
      if (mask !== m.mask) modules[i] = { ...modules[i]!, mask };
    }
  }
  const used = new Set(shapeRefs(modules));
  const kept = Object.keys(shapes)
    .filter((id) => used.has(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // by code unit, as Rust's BTreeMap
  const params: EditParams = { version: EDIT_PARAMS_VERSION, modules };
  if (kept.length) params.shapes = Object.fromEntries(kept.map((id) => [id, shapes[id]!]));
  return params;
}

/** The ids of the shapes that instances refer to (enabled or not), with repeats: their parameters', then their mask's. */
export function shapeRefs(modules: readonly ModuleInstance[]): string[] {
  return modules.flatMap((m) => [...paramShapeRefs(m.kind, m.params), ...maskShapeRefs(m.mask)]);
}

/** The ids of the shapes a mask's drawn part uses, with repeats. */
export function maskShapeRefs(mask: Mask | null | undefined): string[] {
  return mask ? mask.drawn.map((d) => d.shape) : [];
}

/** `mask` with each drawn shape `id` replaced by `f(id)`, or dropped if that is null. The same object if nothing changes. */
export function mapMaskShapeRefs(mask: Mask, f: (id: string) => string | null): Mask {
  if (mask.drawn.every((d) => f(d.shape) === d.shape)) return mask;
  return {
    ...mask,
    drawn: mask.drawn.flatMap((d) => {
      const to = f(d.shape);
      return to === null ? [] : [{ ...d, shape: to }];
    }),
  };
}

/**
 * The ids of the shapes a module's parameters (or some of them, as in a preset) refer
 * to, with repeats. This and `mapShapeRefs` (and `maskShapeRefs`/`mapMaskShapeRefs` for
 * an instance's mask) are the only places that know where shape references are:
 * anything new that refers to shapes goes in both.
 */
export function paramShapeRefs<K extends ModuleKind>(kind: K, params: Partial<ModuleParams[K]>): string[] {
  if (kind === 'retouch') return ((params as Partial<ModuleParams['retouch']>).spots ?? []).map((s) => s.shape);
  return [];
}

/**
 * `params` with each shape reference `id` replaced by `f(id)`, or what refers to it
 * dropped if that is null. The same object if nothing changes.
 */
export function mapShapeRefs<K extends ModuleKind, P extends Partial<ModuleParams[K]>>(
  kind: K,
  params: P,
  f: (id: string) => string | null,
): P {
  if (paramShapeRefs(kind, params).every((id) => f(id) === id)) return params;
  if (kind === 'retouch') {
    const spots = ((params as Partial<ModuleParams['retouch']>).spots ?? []).flatMap((s) => {
      const to = f(s.shape);
      return to === null ? [] : [{ ...s, shape: to }];
    });
    return { ...params, spots };
  }
  return params;
}

/** `kind`, or `kind-2`, `kind-3`… : the first id that isn't taken. */
function freshId(kind: ModuleKind, taken: (id: string) => boolean): string {
  if (!taken(kind)) return kind;
  for (let n = 2; ; n++) if (!taken(`${kind}-${n}`)) return `${kind}-${n}`;
}

/**
 * v1/v2 (one section per module) → v3. Exposure and filmic always become instances;
 * the other sections only when they differ from their defaults. Mirrors `params/v2.rs`.
 * (White balance is taken out beforehand: `takeWhiteBalance`.)
 */
function migrateV2(input: Record<string, unknown>): ModuleInstance[] {
  const modules: ModuleInstance[] = [];
  for (const kind of MODULE_KINDS) {
    if (kind === 'colorCalibration') continue;
    if (kind === 'colorBalance') {
      // The colour and shadows/highlights sections, as in v3–v6 recipes.
      for (const legacy of ['color', 'shadowsHighlights']) {
        const fields = legacy === 'color' ? ['saturation', 'vibrance'] : ['shadows', 'highlights'];
        if (!fields.some((f) => legacyNumber(input[legacy], f) !== 0)) continue;
        modules.push({ ...instance(kind), params: legacyColorBalance(legacy, input[legacy])! });
      }
      continue;
    }
    const section = isObject(input[kind]) ? input[kind] : undefined;
    const params = moduleParams(kind, section);
    const always = kind === 'exposure' || kind === 'filmic';
    if (!always && JSON.stringify(params) === JSON.stringify(defaultModuleParams[kind])) continue;
    // Filmic could be switched off in v2; v3 disables the instance instead.
    const enabled = kind === 'filmic' && typeof section?.enabled === 'boolean' ? section.enabled : true;
    modules.push({ ...instance(kind), enabled, params } as ModuleInstance);
  }
  return modules;
}

/**
 * Filmic's toe and shoulder (v5: linear share of each side of middle grey, %) from
 * v1–v3 `latitude`/`balance` (exact when balance is 0; otherwise assumes equal room
 * on both sides of grey) or from v4 `toe`/`shoulder` (the curved share, 100 % minus
 * the v5 value). Mirrors `migrate_filmic`.
 */
function migrateFilmic(raw: Record<string, unknown>) {
  const version = typeof raw.version === 'number' ? raw.version : 0;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const round = (v: number) => Math.round(clamp(v, 0, 1) * 10_000) / 100;
  const fix = (p: unknown) => {
    if (!isObject(p)) return;
    if ('latitude' in p || 'balance' in p) {
      const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
      const latitude = clamp(num(p.latitude, 10), 0, 100) / 100;
      const balance = clamp(num(p.balance, 0), -50, 50) / 100;
      delete p.latitude;
      delete p.balance;
      p.toe ??= round(latitude * (1 + 2 * balance));
      p.shoulder ??= round(latitude * (1 - 2 * balance));
    } else if (version === 4) {
      for (const key of ['toe', 'shoulder']) if (typeof p[key] === 'number') p[key] = round(1 - p[key] / 100);
    }
  };
  if (Array.isArray(raw.modules)) {
    for (const m of raw.modules) if (isObject(m) && m.kind === 'filmic') fix(m.params);
  } else {
    fix(raw.filmic);
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** `base` with the fields of `patch` that have the right type (arrays: whole, same length). */
function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (Array.isArray(base)) {
    const ok =
      Array.isArray(patch) && patch.length === base.length && patch.every((v, i) => typeof v === typeof base[i]);
    return (ok ? [...patch] : [...base]) as T;
  }
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

/** The first instance of a kind, enabled or not. */
export function findModule<K extends ModuleKind>(params: EditParams, kind: K): ModuleInstance<K> | undefined {
  return params.modules.find((m) => m.kind === kind) as ModuleInstance<K> | undefined;
}

/**
 * Update the first instance of a kind immutably, adding one (enabled, with default
 * parameters) if there is none: `updateModule(p, 'exposure', { params: { ev: 1.2 } })`.
 */
export function updateModule<K extends ModuleKind>(
  params: EditParams,
  kind: K,
  patch: { enabled?: boolean; params?: Partial<ModuleParams[K]> },
): EditParams {
  const id = findModule(params, kind)?.id ?? freshId(kind, (id) => params.modules.some((m) => m.id === id));
  return updateInstance(params, kind, id, patch);
}

/**
 * Update one instance immutably, adding it (enabled, with default parameters) after its
 * kind if it isn't there. `mask: null` removes its mask (its shapes stay: `withUsedShapes`).
 */
export function updateInstance<K extends ModuleKind>(
  params: EditParams,
  kind: K,
  id: string,
  patch: { enabled?: boolean; label?: string | null; params?: Partial<ModuleParams[K]>; mask?: Mask | null },
): EditParams {
  const existing = params.modules.find((m) => m.id === id) as ModuleInstance<K> | undefined;
  const base = existing ?? instance(kind, id);
  const updated = {
    ...base,
    enabled: patch.enabled ?? base.enabled,
    label: patch.label === undefined ? base.label : patch.label,
    params: { ...base.params, ...patch.params },
  } as ModuleInstance;
  if (patch.mask === null) delete updated.mask;
  else if (patch.mask && MASKABLE_KINDS.includes(kind)) updated.mask = patch.mask;
  if (existing) return { ...params, modules: params.modules.map((m) => (m === existing ? updated : m)) };
  const at = params.modules.findLastIndex((m) => rank(m.kind) <= rank(kind)) + 1;
  return { ...params, modules: params.modules.toSpliced(at, 0, updated) };
}

/**
 * Default parameters of the instance at `position` among its kind. Only the first
 * exposure carries the +0.7 EV push and only the first colour calibration does the
 * white balance, and only where the photo's original (`originalRecipe`) has them: other
 * ones start neutral, so that adding them doesn't change the image. An image that
 * isn't a RAW file has neither, so its instances all start neutral.
 */
export function instanceDefaults<K extends ModuleKind>(
  kind: K,
  position: number,
  original = originalEditParams,
): ModuleParams[K] {
  const defaults = structuredClone(defaultModuleParams[kind]);
  if (position === 0 && original.modules.some((m) => m.kind === kind)) return defaults;
  if (kind === 'exposure') return { ...defaults, ev: 0 };
  if (kind === 'colorCalibration') return { ...defaults, adaptation: 'none', gamut: 0, clip: false };
  return defaults;
}

const positionOf = (params: EditParams, kind: ModuleKind, id: string) =>
  params.modules.filter((m) => m.kind === kind).findIndex((m) => m.id === id);

/** Add a new instance with default parameters right after this one. Not for single-instance kinds. */
export function addInstance(params: EditParams, id: string): EditParams {
  const at = params.modules.findIndex((m) => m.id === id);
  const source = params.modules[at];
  if (!source || SINGLE_INSTANCE_KINDS.includes(source.kind)) return params;
  const added = {
    ...instance(
      source.kind,
      freshId(source.kind, (id) => params.modules.some((m) => m.id === id)),
    ),
    params: instanceDefaults(source.kind, 1),
  } as ModuleInstance;
  return { ...params, modules: params.modules.toSpliced(at + 1, 0, added) };
}

/** Remove an instance (and the shapes only it used). */
export function removeInstance(params: EditParams, id: string): EditParams {
  return withUsedShapes({ ...params, modules: params.modules.filter((m) => m.id !== id) });
}

/** Swap an instance with the previous (-1) or next (+1) one of its kind, if there is one. */
export function moveInstance(params: EditParams, id: string, delta: -1 | 1): EditParams {
  const at = params.modules.findIndex((m) => m.id === id);
  const source = params.modules[at];
  const other = params.modules[at + delta];
  if (!source || other?.kind !== source.kind) return params;
  const modules = [...params.modules];
  modules[at] = other;
  modules[at + delta] = source;
  return { ...params, modules };
}

/**
 * Put the instances of a kind back as in the original (removing them if it has none):
 * `originalEditParams`, or the photo's (`originalRecipe`).
 */
export function resetModule(params: EditParams, kind: ModuleKind, original = originalEditParams): EditParams {
  const defaults = structuredClone(original.modules.filter((m) => m.kind === kind));
  return normalize([...params.modules.filter((m) => m.kind !== kind), ...defaults], params.shapes);
}

/** Whether the instances of a kind differ from the original's (ids aside). */
export function isModuleModified(params: EditParams, kind: ModuleKind, original = originalEditParams): boolean {
  const strip = (p: EditParams) => JSON.stringify(p.modules.filter((m) => m.kind === kind).map(({ id: _, ...m }) => m));
  return strip(params) !== strip(original);
}

/**
 * Reset one instance. The only instance of its kind goes back to the default recipe
 * (`resetModule`); with several, it keeps its place and label and gets default parameters
 * and no mask.
 */
export function resetInstance(
  params: EditParams,
  kind: ModuleKind,
  id: string,
  original = originalEditParams,
): EditParams {
  if (params.modules.filter((m) => m.kind === kind).length <= 1) return resetModule(params, kind, original);
  return withUsedShapes(
    updateInstance(params, kind, id, {
      enabled: true,
      params: instanceDefaults(kind, positionOf(params, kind, id), original),
      mask: null,
    }),
  );
}

/** Whether `resetInstance` would change anything. */
export function isInstanceModified(
  params: EditParams,
  kind: ModuleKind,
  id: string,
  original = originalEditParams,
): boolean {
  if (params.modules.filter((m) => m.kind === kind).length <= 1) return isModuleModified(params, kind, original);
  const m = params.modules.find((m) => m.id === id);
  return (
    !!m &&
    (!m.enabled ||
      !!m.mask ||
      JSON.stringify(m.params) !== JSON.stringify(instanceDefaults(kind, positionOf(params, kind, id), original)))
  );
}

export function isDefaultEdit(params: EditParams, original = originalEditParams): boolean {
  return MODULE_KINDS.every((kind) => !isModuleModified(params, kind, original));
}

// ── Retouch spots ──
// Spots belong to a retouch instance, by id. Editing them switches it on (adding it if
// it isn't there yet, as editing any module does).

/** The spots of retouch instance `id`. */
export function spotsOf(params: EditParams, id: string): Spot[] {
  const m = params.modules.find((x) => x.id === id);
  return m?.kind === 'retouch' ? m.params.spots : [];
}

/** Add a spot with its shape to instance `id`; returns the recipe and the spot's index. */
export function addSpot(
  params: EditParams,
  id: string,
  shape: Shape,
  spot: Partial<Omit<Spot, 'shape'>>,
): [EditParams, number] {
  const shapeId = freshShapeId(Object.keys(params.shapes ?? {}));
  const spots = [...spotsOf(params, id), { ...structuredClone(defaultSpot as Spot), ...spot, shape: shapeId }];
  const next = updateInstance(params, 'retouch', id, { enabled: true, params: { spots } });
  return [{ ...next, shapes: sortedShapes({ ...params.shapes, [shapeId]: shape }) }, spots.length - 1];
}

/** Change spot `index` of instance `id`. */
export function updateSpot(
  params: EditParams,
  id: string,
  index: number,
  patch: Partial<Omit<Spot, 'shape'>>,
): EditParams {
  const spots = spotsOf(params, id).map((s, i) => (i === index ? { ...s, ...patch } : s));
  return updateInstance(params, 'retouch', id, { enabled: true, params: { spots } });
}

/** Remove spot `index` of instance `id`, and its shape unless something else uses it. */
export function removeSpot(params: EditParams, id: string, index: number): EditParams {
  const spots = spotsOf(params, id).filter((_, i) => i !== index);
  return withUsedShapes(updateInstance(params, 'retouch', id, { params: { spots } }));
}

/** Replace shape `shapeId`, switching on the instances that use it (retouch spots, masks). */
export function updateShape(params: EditParams, shapeId: string, shape: Shape): EditParams {
  if (!params.shapes?.[shapeId]) return params;
  const modules = params.modules.map((m) =>
    !m.enabled && shapeRefs([m]).includes(shapeId) ? ({ ...m, enabled: true } as ModuleInstance) : m,
  );
  return { ...params, modules, shapes: { ...params.shapes, [shapeId]: shape } };
}

/** The recipe without the shapes nothing uses (and without `shapes` if none are left). */
export function withUsedShapes(params: EditParams): EditParams {
  const used = new Set(shapeRefs(params.modules));
  const all = Object.entries(params.shapes ?? {});
  const kept = all.filter(([id]) => used.has(id));
  if (kept.length === all.length) return params;
  const { shapes: _, ...rest } = params;
  return kept.length ? { ...rest, shapes: Object.fromEntries(kept) } : rest;
}

/** Shapes sorted by id (as Rust's `BTreeMap` serialises them). */
export function sortedShapes(shapes: Record<string, Shape>): Record<string, Shape> {
  return Object.fromEntries(Object.entries(shapes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ── Masks ──
// A mask belongs to an instance, by id. Editing it switches the instance on (adding it if
// it isn't there yet, as editing any module does).

/** The mask of instance `id`, if it has one. */
export function maskOf(params: EditParams, id: string): Mask | undefined {
  return params.modules.find((m) => m.id === id)?.mask;
}

/**
 * Change the mask of instance `id` (of kind `kind`), giving it one if it has none, and
 * switch the instance on. Shapes no longer used go.
 */
export function updateMask(params: EditParams, kind: ModuleKind, id: string, patch: Partial<Mask>): EditParams {
  const mask = { ...structuredClone(defaultMask as Mask), ...maskOf(params, id), ...patch };
  return withUsedShapes(updateInstance(params, kind, id, { enabled: true, mask }));
}

/** Remove the mask of instance `id`, and its shapes unless something else uses them. */
export function removeMask(params: EditParams, id: string): EditParams {
  const m = params.modules.find((x) => x.id === id);
  if (!m?.mask) return params;
  return withUsedShapes(updateInstance(params, m.kind, id, { mask: null }));
}

/** Add a shape to the drawn part of instance `id`'s mask; returns the recipe and the shape's id. */
export function addMaskShape(
  params: EditParams,
  kind: ModuleKind,
  id: string,
  shape: Shape,
  op: ShapeOp = 'union',
): [EditParams, string] {
  const shapeId = freshShapeId(Object.keys(params.shapes ?? {}));
  const drawn = [...(maskOf(params, id)?.drawn ?? []), { shape: shapeId, op }];
  const withShape = { ...params, shapes: sortedShapes({ ...params.shapes, [shapeId]: shape }) };
  return [updateMask(withShape, kind, id, { drawn }), shapeId];
}

/** Remove drawn part `index` of instance `id`'s mask (and its shape, unless something else uses it). */
export function removeMaskShape(params: EditParams, kind: ModuleKind, id: string, index: number): EditParams {
  const drawn = (maskOf(params, id)?.drawn ?? []).filter((_, i) => i !== index);
  return updateMask(params, kind, id, { drawn });
}
