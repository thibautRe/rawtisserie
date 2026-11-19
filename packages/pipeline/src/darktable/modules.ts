/**
 * darktable's and Ansel's modules as the import sees them: their names, what our own
 * pipeline does in their place, and the translators that turn their parameters into our
 * modules (`Translator`). Struct layouts are copied from upstream, darktable 5.6.2
 * (commit 20891f6) and Ansel's master (commit fa3c276), `src/iop/<operation>.c`.
 */
import type { ModuleInstance, ModuleKind, ModuleParams } from '../params.ts';
import type { ImportMetadata, ImportStatus } from '../importedEdits.ts';
import type { DarktableApp, DarktableEntry } from './xmp.ts';
import { Layout } from './struct.ts';

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

/** What a translator is given for the photo. */
export interface TranslateContext {
  app: DarktableApp;
  metadata: ImportMetadata;
}

/** One entry's import: its instance (null: nothing of ours), and how well it went. */
export interface Translation {
  instance: ModuleInstance | null;
  status: Exclude<ImportStatus, 'builtIn'>;
  note?: string;
}

/**
 * Turns a darktable module (or several, of one job) into ours. It decides `kinds`: what
 * the photo's starting recipe has of those is replaced by what it gives, nothing when
 * the history doesn't have its modules (darktable didn't apply them).
 */
export interface Translator {
  operations: readonly string[];
  kinds: readonly ModuleKind[];
  translate(entry: DarktableEntry, params: Uint8Array, ctx: TranslateContext): Translation;
}

const instance = <K extends ModuleKind>(kind: K, params: ModuleParams[K]): ModuleInstance<K> =>
  ({ id: '', label: null, enabled: true, kind, params }) as ModuleInstance<K>;

const unreadable = (entry: DarktableEntry): Translation => ({
  instance: null,
  status: 'skipped',
  note: `Version ${entry.modversion} of its settings isn't supported`,
});

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

/** Every translator, in no particular order: each takes its own operations. */
export const TRANSLATORS: readonly Translator[] = [exposure];
