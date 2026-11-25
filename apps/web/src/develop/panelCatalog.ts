/**
 * What the module panel shows, as data: the labels its tabs and slider groups share with
 * `ModulePanel`, and every slider by module kind with the tabs and folds it's on, so that
 * the spotlight (roadmap 2.6) knows them without the panel rendering them.
 *
 * `SPOTLIGHT_SLIDERS` repeats the panel's slider labels: `npm run test:spotlight`
 * focuses each one through the spotlight, so a slider renamed, moved or added in
 * `ModulePanel` without this list fails it.
 */
import {
  type EqualizerCurve,
  EQUALIZER_CURVES,
  type ModuleKind,
  PRESET_GROUPS,
  PRIMARIES,
  TONE_RANGES,
  type ToneRange,
} from '@rawtisserie/pipeline';
import type { SpotlightSlider, SpotlightView } from './spotlight.ts';

export const EQUALIZER_LABELS: Record<EqualizerCurve, string> = {
  luma: 'Luminance contrast',
  chroma: 'Color contrast',
  edges: 'Edge awareness',
  lumaDenoise: 'Luminance denoise',
  chromaDenoise: 'Color denoise',
};

export const CALIBRATION_PAGES = ['illuminant', 'mixer', 'output'] as const;

export type CalibrationPage = (typeof CALIBRATION_PAGES)[number];

export const CALIBRATION_PAGE_LABELS = Object.fromEntries(
  CALIBRATION_PAGES.map((page) => [page, PRESET_GROUPS.colorCalibration![page]!.label]),
) as Record<CalibrationPage, string>;

/** The groups of the output tab, in the order they apply. */
export const OUTPUT_GROUPS = [
  {
    key: 'colorfulness',
    title: 'Colorfulness',
    min: -1,
    max: 1,
    hardMin: -1,
    hardMax: 1,
    hint: 'Offset the coefficients so that they add up to 0',
  },
  {
    key: 'brightness',
    title: 'Brightness',
    min: -1,
    max: 1,
    hardMin: -1,
    hardMax: 1,
    hint: 'Offset the coefficients so that they add up to 0',
  },
  {
    key: 'grey',
    title: 'Gray (monochrome when not 0)',
    min: 0,
    max: 1,
    hardMin: -2,
    hardMax: 2,
    hint: 'Scale the coefficients so that they add up to 1 (keeps the brightness)',
  },
] as const;

/** Ways to see and edit the mixer's matrix (Ansel's mixer modes). */
export const MIXER_VIEWS = ['primaries', 'whitePreserving', 'channels'] as const;

export type MixerView = (typeof MIXER_VIEWS)[number];

export const MIXER_VIEW_LABELS: Record<MixerView, string> = {
  primaries: 'Primaries',
  whitePreserving: 'White-preserving',
  channels: 'Channels',
};

export const CHANNELS = ['Red', 'Green', 'Blue'] as const;

/** Diffuse or sharpen's four orders: what each acts on and which gradient it follows. */
export const DIFFUSE_ORDERS = ['1st order', '2nd order', '3rd order', '4th order'] as const;

/** Colour balance's tabs: Ansel's colour balance rgb master tab, the mixers, and the ranges. */
export const BALANCE_PAGES = ['master', 'mixer', 'settings'] as const;

export type BalancePage = (typeof BALANCE_PAGES)[number];

export const BALANCE_PAGE_LABELS: Record<BalancePage, string> = {
  master: 'Master',
  mixer: 'Mixer',
  settings: 'Settings',
};

export const RANGE_LABELS: Record<ToneRange, string> = {
  shadows: 'Shadows',
  midtones: 'Mid-tones',
  highlights: 'Highlights',
};

/** Colour balance's grading groups, each `[global, shadows, mid-tones, highlights]`. */
export const BALANCE_GRADING = [
  {
    key: 'chroma',
    title: 'Chroma',
    hint: 'Linear chroma (Filmlight Yrg): every color moves away from gray in proportion',
  },
  {
    key: 'saturation',
    title: 'Saturation',
    hint: 'Perceptual saturation (darktable UCS): more color, darker; less color, brighter',
  },
  {
    key: 'brilliance',
    title: 'Brilliance',
    hint: 'Perceptual brightness (darktable UCS), keeping the saturation',
  },
] as const;

/**
 * Colour balance's grading sliders: Global (the ranges' average, which moves all three)
 * and one per range (the values stored).
 */
export const GRADING_LABELS = ['Global', 'Shadows', 'Mid-tones', 'Highlights'] as const;

/**
 * The views (tabs, folds) the spotlight can name, by kind: what they set in an
 * instance's view (`InstanceView` in `ModulePanel`; a fold is `'true'`).
 */
export const SPOTLIGHT_VIEWS: Partial<Record<ModuleKind, SpotlightView[]>> = (() => {
  const mixerViews = (field: string) =>
    MIXER_VIEWS.map((v, i) => ({
      field: 'mixer',
      value: v,
      labels: [MIXER_VIEW_LABELS[v]],
      isDefault: i === 0,
      under: { field, value: 'mixer' },
    }));
  return {
    colorCalibration: [
      ...CALIBRATION_PAGES.map((p, i) => ({
        field: 'calibration',
        value: p,
        labels:
          p === 'illuminant'
            ? [CALIBRATION_PAGE_LABELS[p], 'White balance', 'Illuminant']
            : [CALIBRATION_PAGE_LABELS[p]],
        isDefault: i === 0,
      })),
      ...mixerViews('calibration'),
      {
        field: 'calibrationAdvanced',
        value: 'true',
        labels: ['Adaptation and gamut'],
        under: { field: 'calibration', value: 'illuminant' },
      },
    ],
    colorBalance: [
      ...BALANCE_PAGES.map((p, i) => ({
        field: 'balance',
        value: p,
        labels: [BALANCE_PAGE_LABELS[p]],
        isDefault: i === 0,
      })),
      ...TONE_RANGES.map((r, i) => ({
        field: 'balanceRange',
        value: r,
        labels: [RANGE_LABELS[r]],
        isDefault: i === 0,
        under: { field: 'balance', value: 'mixer' },
      })),
      ...mixerViews('balance'),
    ],
    colorPrimaries: [
      ...PRIMARIES.map((p, i) => ({ field: 'primary', value: p, labels: [p], isDefault: i === 0 })),
      { field: 'primariesAdvanced', value: 'true', labels: ['Gamut and smoothing'] },
    ],
    contrastEqualizer: EQUALIZER_CURVES.map((c, i) => ({
      field: 'curve',
      value: c,
      labels: [EQUALIZER_LABELS[c]],
      isDefault: i === 0,
    })),
    diffuse: [{ field: 'diffuseAdvanced', value: 'true', labels: ['Direction, edges and inpainting'] }],
    rawDenoise: [{ field: 'denoiseAdvanced', value: 'true', labels: ['Noise corrections'] }],
  };
})();

const sliders = (labels: readonly string[], views?: Record<string, string>): SpotlightSlider[] =>
  labels.map((label) => ({ label, views }));

/** The sliders of `labels` under each group title, the same labels in each (`nth`: the group's). */
const grouped = (
  groups: readonly string[],
  labels: readonly string[],
  views?: Record<string, string>,
): SpotlightSlider[] => groups.flatMap((group, nth) => labels.map((label) => ({ label, group, nth, views })));

/** The mixer's sliders (colour calibration's, colour balance's ranges'), by its view. */
const mixerSliders = (views: Record<string, string>): SpotlightSlider[] => [
  ...sliders(['White hue', 'White purity', ...CHANNELS.flatMap((c) => [`${c} hue`, `${c} purity`]), 'Gain'], {
    ...views,
    mixer: 'primaries',
  }),
  ...sliders(
    CHANNELS.flatMap((c) => [`${c} rotation`, `${c} saturation`]),
    { ...views, mixer: 'whitePreserving' },
  ),
  ...grouped(
    CHANNELS.map((c) => `${c} output`),
    CHANNELS.map((c) => `Input ${c.toLowerCase()}`),
    { ...views, mixer: 'channels' },
  ),
];

const ADVANCED = 'true';

/**
 * Every slider of each kind, with the views it's shown on. `conditional`: it also
 * depends on the module's settings, so it may not be there (the spotlight then focuses
 * the module's first slider).
 */
export const SPOTLIGHT_SLIDERS: Partial<Record<ModuleKind, SpotlightSlider[]>> = {
  exposure: sliders(['Exposure', 'Black level']),
  colorCalibration: [
    { label: 'Temperature', views: { calibration: 'illuminant' }, conditional: 'a daylight or black body light' },
    { label: 'Hue', views: { calibration: 'illuminant' }, conditional: 'a custom light' },
    { label: 'Chroma', views: { calibration: 'illuminant' }, conditional: 'a custom light' },
    ...sliders(['Gamut compression'], { calibration: 'illuminant', calibrationAdvanced: ADVANCED }),
    ...mixerSliders({ calibration: 'mixer' }),
    ...grouped(
      OUTPUT_GROUPS.map((g) => g.title),
      CHANNELS,
      { calibration: 'output' },
    ),
  ],
  colorBalance: [
    ...sliders(['Hue shift', 'Vibrance'], { balance: 'master' }),
    ...grouped(
      BALANCE_GRADING.map((g) => g.title),
      GRADING_LABELS,
      { balance: 'master' },
    ),
    ...TONE_RANGES.flatMap((r) => [
      ...sliders(['Temperature'], { balance: 'mixer', balanceRange: r }),
      ...mixerSliders({ balance: 'mixer', balanceRange: r }),
    ]),
    ...sliders(['Fulcrum', 'Mid-tones range', 'Shadows fall-off', 'Highlights fall-off', 'White fulcrum'], {
      balance: 'settings',
    }),
  ],
  colorPrimaries: [
    ...PRIMARIES.flatMap((p) => sliders(['Hue', 'Saturation', 'Brightness'], { primary: p })),
    ...sliders(
      [
        'White level',
        'Gamut coverage',
        'Neutral protection',
        'Brightness smoothing',
        'Saturation smoothing',
        'Hue smoothing',
      ],
      { primariesAdvanced: ADVANCED },
    ),
  ],
  toneCurve: [
    ...sliders(['Darkest node', 'Brightest node', 'Strength']),
    { label: 'Smoothing', conditional: 'preserving detail' },
    { label: 'Edge refinement', conditional: 'preserving detail' },
  ],
  contrastEqualizer: sliders(['Mix']),
  filmic: sliders([
    'White relative exposure',
    'Black relative exposure',
    'Dynamic range scaling',
    'Contrast',
    'Toe',
    'Shoulder',
    'Hue preservation',
    'AgX bleach',
    'Hardness',
    'Target black luminance',
    'Target white luminance',
  ]),
  glow: [
    ...sliders(['Threshold', 'Threshold softness', 'Radius', 'Falloff']),
    { label: 'Angle', conditional: 'a shape other than round' },
    { label: 'Thickness', conditional: 'a shape other than round' },
    ...sliders(['Strength', 'Tint hue', 'Tint saturation']),
  ],
  diffuse: [
    ...sliders(['Iterations', 'Central radius', 'Radius span']),
    ...DIFFUSE_ORDERS.map((label) => ({ label, group: 'Speed', nth: 0 })),
    ...DIFFUSE_ORDERS.map((label) => ({ label, group: 'Direction', nth: 1, views: { diffuseAdvanced: ADVANCED } })),
    ...sliders(['Sharpness', 'Edge sensitivity', 'Edge threshold', 'Luminance threshold'], {
      diffuseAdvanced: ADVANCED,
    }),
  ],
  lens: sliders(['Distortion', 'Chromatic aberration', 'Vignetting']),
  geometry: sliders(['Straighten', 'Vertical', 'Horizontal', 'Shear', 'Aspect']),
  retouch: [
    { label: 'Opacity', conditional: 'a spot selected' },
    { label: 'Feather', conditional: 'a spot selected other than a brush stroke' },
    { label: 'Stroke size', conditional: 'a brush spot selected' },
    { label: 'Stroke hardness', conditional: 'a brush spot selected' },
    { label: 'Blur radius', conditional: 'a blur spot selected' },
  ],
  multipleExposure: sliders(['Its exposure']),
  rawDenoise: [
    ...sliders(['Strength']),
    ...sliders(['Noise level', ...CHANNELS.map((c) => `${c} correction`)], { denoiseAdvanced: ADVANCED }),
  ],
};
