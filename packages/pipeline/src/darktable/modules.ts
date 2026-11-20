/**
 * darktable's and Ansel's modules as the import sees them: their names, what our own
 * pipeline does in their place, and the translators that turn their parameters into our
 * modules (`Translator`). Struct layouts are copied from upstream, darktable 5.6.2
 * (commit 20891f6) and Ansel's master (commit fa3c276), `src/iop/<operation>.c`.
 */
import { type ModuleInstance, resolveLutRefs } from '../params.ts';
import { Layout } from './struct.ts';
import { calibration } from './calibration.ts';
import { TONE_TRANSLATORS } from './tone.ts';
import { GEOMETRY_TRANSLATORS } from './geometry.ts';
import { colorBalance } from './colorbalance.ts';
import { lens } from './lens.ts';
import { colorPrimaries, splitToning } from './ansel.ts';
import { toneEqualizer } from './toneequal.ts';
import { diffuse } from './diffuse.ts';
import { rgbPrimaries } from './primaries.ts';
import { contrastEqualizer } from './equalizer.ts';
import { retouch } from './retouch.ts';
import { colorEqualizer } from './colorequal.ts';
import { type Translator, instance, unreadable } from './translate.ts';

export type { TranslateContext, Translation, Translator } from './translate.ts';

/** The names darktable shows for its modules (operation ids otherwise). */
export const DARKTABLE_MODULE_NAMES: Readonly<Record<string, string>> = {
  agx: 'AgX',
  ashift: 'rotate and perspective',
  atrous: 'contrast equalizer',
  basecurve: 'base curve',
  basicadj: 'basic adjustments',
  bilat: 'local contrast',
  bloom: 'bloom',
  blurs: 'blurs',
  borders: 'framing',
  cacorrect: 'raw chromatic aberrations',
  cacorrectrgb: 'chromatic aberrations',
  channelmixer: 'channel mixer',
  channelmixerrgb: 'color calibration',
  clipping: 'crop and rotate',
  colorbalance: 'color balance',
  colorbalancergb: 'color balance rgb',
  colorchecker: 'color look up table',
  colorcorrection: 'color correction',
  colorequal: 'color equalizer',
  colorin: 'input color profile',
  colorize: 'colorize',
  colorout: 'output color profile',
  colorprimaries: 'color primaries',
  colorreconstruct: 'color reconstruction',
  colorzones: 'color zones',
  crop: 'crop',
  defringe: 'defringe',
  demosaic: 'demosaic',
  denoiseprofile: 'denoise (profiled)',
  diffuse: 'diffuse or sharpen',
  dither: 'dithering',
  enlargecanvas: 'enlarge canvas',
  exposure: 'exposure',
  filmic: 'filmic',
  filmicrgb: 'filmic rgb',
  finalscale: 'scale',
  flip: 'orientation',
  gamma: 'display encoding',
  globaltonemap: 'global tonemap',
  graduatednd: 'graduated density',
  grain: 'grain',
  hazeremoval: 'haze removal',
  highlights: 'highlight reconstruction',
  highpass: 'highpass',
  hotpixels: 'hot pixels',
  lens: 'lens correction',
  levels: 'levels',
  liquify: 'liquify',
  lowlight: 'lowlight vision',
  lowpass: 'lowpass',
  lut3d: 'LUT 3D',
  monochrome: 'monochrome',
  negadoctor: 'negadoctor',
  nlmeans: 'astrophoto denoise',
  overexposed: 'overexposed',
  overlay: 'composite',
  primaries: 'rgb primaries',
  rawdenoise: 'raw denoise',
  rawoverexposed: 'raw overexposed',
  rawprepare: 'raw black/white point',
  retouch: 'retouch',
  rgbcurve: 'rgb curve',
  rgblevels: 'rgb levels',
  rotatepixels: 'rotate pixels',
  scalepixels: 'scale pixels',
  shadhi: 'shadows and highlights',
  sharpen: 'sharpen',
  sigmoid: 'sigmoid',
  soften: 'soften',
  splittoning: 'split-toning',
  spots: 'spot removal',
  temperature: 'white balance',
  tonecurve: 'tone curve',
  toneequal: 'tone equalizer',
  velvia: 'velvia',
  vibrance: 'vibrance',
  vignette: 'vignetting',
  watermark: 'watermark',
};

export const darktableModuleName = (operation: string) => DARKTABLE_MODULE_NAMES[operation] ?? operation;

/**
 * Modules our pipeline does in its own way, whatever their settings: not imported, and
 * not a loss worth listing as skipped (raw preparation, demosaicing, colour profiles).
 */
export const BUILT_IN_OPERATIONS: ReadonlySet<string> = new Set([
  'rawprepare',
  'demosaic',
  'highlights',
  'colorin',
  'colorout',
  'gamma',
  'finalscale',
  'dither',
  'overexposed',
  'rawoverexposed',
  'mask_manager',
  'rotatepixels',
  'scalepixels',
]);

// ── Exposure ───────────────────────────────────────────────────────────────────

const EXPOSURE_V6 = new Layout([
  ['mode', 'i32'],
  ['black', 'f32'],
  ['exposure', 'f32'],
  ['deflicker_percentile', 'f32'],
  ['deflicker_target_level', 'f32'],
  ['compensate_exposure_bias', 'gboolean'],
]);
/** darktable 5.0 onwards (Ansel stays at 6). */
const EXPOSURE_V7 = new Layout([
  ...EXPOSURE_V6.fields.map((f) => [f.name, f.type] as const),
  ['compensate_hilite_pres', 'gboolean'],
]);

/** Cameras whose files say how much highlight preservation underexposed them (darktable reads it from the maker notes). */
const HIGHLIGHT_PRESERVATION_MAKES = /nikon|fujifilm/i;

const exposure: Translator = {
  operations: ['exposure'],
  kinds: ['exposure'],
  translate(entry, bytes, { metadata }) {
    const p = (entry.modversion === 7 ? EXPOSURE_V7 : entry.modversion === 6 ? EXPOSURE_V6 : null)?.read(bytes);
    if (!p) return unreadable(entry);
    const notes: string[] = [];
    let ev = p.exposure as number;
    if (p.compensate_exposure_bias) ev -= Math.min(5, Math.max(-5, metadata.exposureBias ?? 0));
    if (p.compensate_hilite_pres && HIGHLIGHT_PRESERVATION_MAKES.test(metadata.make ?? ''))
      notes.push("The camera's highlight preservation (D-Range) isn't compensated");
    if (p.mode === 1) notes.push('Automatic (deflicker) mode: its exposure was measured on the image, kept as set');
    // darktable scales by 1 / (2^-ev − black) after subtracting black; we scale by 2^ev.
    const black = p.black as number;
    const white = 2 ** -ev - black;
    if (white > 1e-6) ev = -Math.log2(white);
    else notes.push('Black level correction out of range');
    return {
      instance: instance('exposure', { ev, black }),
      status: notes.length ? 'approximated' : 'mapped',
      ...(notes.length && { note: notes.join('. ') }),
    };
  },
};

// ── LUT 3D ─────────────────────────────────────────────────────────────────────

/** darktable's and Ansel's (v3, the same struct). */
const LUT3D_V3 = new Layout([
  ['filepath', { char: 512 }],
  ['colorspace', 'i32'],
  ['interpolation', 'i32'],
  ['nb_keypoints', 'i32'],
  ['c_clut', { array: 'u8', n: 2048 * 2 * 3 }],
  ['lutname', { char: 128 }],
]);
/** `dt_iop_lut3d_colorspace_t`; 5 is ProPhoto in darktable, BT.1886 in Ansel. */
const LUT_SPACES = ['sRGB', 'Adobe RGB', 'gamma Rec709', 'linear Rec709', 'linear Rec2020'];
const LUT_INTERPOLATIONS_DT = ['tetrahedral', 'trilinear', 'pyramid'] as const;

const lut3d: Translator = {
  operations: ['lut3d'],
  kinds: ['lut'],
  translate(entry, bytes, { app, luts }) {
    const p = entry.modversion === 3 ? LUT3D_V3.read(bytes) : null;
    if (!p) return unreadable(entry);
    const path = (p.filepath as string).trim();
    if (!path) return { instance: null, status: 'skipped', note: 'No LUT file chosen' };
    if ((p.nb_keypoints as number) > 0)
      return { instance: null, status: 'skipped', note: `A compressed G'MIC LUT (${p.lutname as string}): not read` };
    const file = path.split(/[\\/]/).pop()!;
    const name = file.replace(/\.[^.]*$/, '');
    const notes: string[] = [];
    const space = p.colorspace as number;
    if (space !== 0)
      notes.push(`Applied on sRGB, not ${LUT_SPACES[space] ?? (app === 'ansel' ? 'BT.1886' : 'linear ProPhoto RGB')}`);
    const ref = resolveLutRefs(
      {
        version: 0,
        modules: [instance('lut', { lut: { id: '', name, path }, interpolation: 'tetrahedral' })],
      },
      luts,
    ).modules[0] as ModuleInstance<'lut'>;
    const interpolation = LUT_INTERPOLATIONS_DT[p.interpolation as number] ?? 'tetrahedral';
    const result = instance('lut', { ...ref.params, interpolation });
    if (!ref.params.lut!.id)
      return {
        instance: result,
        status: 'needsFile',
        note: [`Add “${file}” to your LUTs`, ...notes].join('. '),
        file: { name: file, path },
      };
    return {
      instance: result,
      status: notes.length ? 'approximated' : 'mapped',
      ...(notes.length && { note: notes.join('. ') }),
    };
  },
};

/** Every translator, in no particular order: each takes its own operations. */
export const TRANSLATORS: readonly Translator[] = [
  exposure,
  lut3d,
  calibration,
  ...TONE_TRANSLATORS,
  ...GEOMETRY_TRANSLATORS,
  colorBalance,
  lens,
  colorPrimaries,
  splitToning,
  toneEqualizer,
  diffuse,
  rgbPrimaries,
  contrastEqualizer,
  retouch,
  colorEqualizer,
];
