/**
 * Export options and settings. `ExportOptions` and `ExportMetadata` mirror
 * `crates/pipeline/src/export/` (what `renderExport` takes); `export.test.ts` checks
 * that Rust reads them back unchanged. `ExportSettings` is what the export dialog
 * shows and what's saved (the user's last settings and their export presets, on the
 * server): `exportOptions` turns it into options.
 */
import { DEFAULT_FRAME, type Frame } from './frame.ts';
import type { PhotoMetadata } from './metadata.ts';

export type ExportFormat = 'jpeg' | 'png' | 'tiff';
/** Mirrors `output::ColorSpace`. */
export type ColorSpace = 'srgb' | 'displayP3' | 'adobeRgb' | 'rec2020';
export type Sharpening = 'none' | 'low' | 'standard' | 'high';
/** `all`; `noLocation`: all but GPS; `copyright`: artist and copyright only; `none`. */
export type MetadataMode = 'all' | 'noLocation' | 'copyright' | 'none';
export type BitDepth = 8 | 16;

/** Bounds of the exported image (frame included). Never upscaled. */
export type ExportSize =
  | { type: 'full' }
  | { type: 'longEdge'; size: number }
  | { type: 'shortEdge'; size: number }
  /** 0 leaves a side unbounded. */
  | { type: 'fit'; width: number; height: number }
  | { type: 'megapixels'; megapixels: number };

/** What `renderExport` takes. Mirrors `export::ExportOptions`. */
export interface ExportOptions {
  format: ExportFormat;
  /** JPEG quality, 1–100. */
  quality: number;
  /** PNG and TIFF; JPEG is always 8 bits. */
  depth: BitDepth;
  colorSpace: ColorSpace;
  size: ExportSize;
  sharpening: Sharpening;
  frame: Frame | null;
  metadata: MetadataMode;
}

/** What goes in the file's EXIF and XMP. Mirrors `export::ExportMetadata`. */
export interface ExportMetadata {
  photo: PhotoMetadata;
  title: string | null;
  description: string | null;
  /** 0–5 stars. */
  rating: number;
  label: string | null;
  tags: string[];
}

export const EXPORT_FORMATS: { value: ExportFormat; label: string; extension: string; mimeType: string }[] = [
  { value: 'jpeg', label: 'JPEG', extension: 'jpg', mimeType: 'image/jpeg' },
  { value: 'png', label: 'PNG', extension: 'png', mimeType: 'image/png' },
  { value: 'tiff', label: 'TIFF', extension: 'tif', mimeType: 'image/tiff' },
];

export const COLOR_SPACES: { value: ColorSpace; label: string }[] = [
  { value: 'srgb', label: 'sRGB' },
  { value: 'displayP3', label: 'Display P3' },
  { value: 'adobeRgb', label: 'Adobe RGB' },
  { value: 'rec2020', label: 'Rec. 2020' },
];

export const SHARPENING: { value: Sharpening; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' },
];

export const METADATA_MODES: { value: MetadataMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'noLocation', label: 'All except location' },
  { value: 'copyright', label: 'Copyright only' },
  { value: 'none', label: 'None' },
];

export type SizeMode = ExportSize['type'];

export const SIZE_MODES: { value: SizeMode; label: string }[] = [
  { value: 'full', label: 'Full resolution' },
  { value: 'longEdge', label: 'Long edge' },
  { value: 'shortEdge', label: 'Short edge' },
  { value: 'fit', label: 'Width × height' },
  { value: 'megapixels', label: 'Megapixels' },
];

/** Largest side a size can ask for (JPEG's limit). */
export const MAX_EXPORT_SIZE = 65_535;

/** The export dialog's settings: what's saved, as last used and in export presets. */
export interface ExportSettings {
  format: ExportFormat;
  quality: number;
  depth: BitDepth;
  colorSpace: ColorSpace;
  /** The bounds of each mode are kept when switching between them. */
  size: {
    mode: SizeMode;
    longEdge: number;
    shortEdge: number;
    /** 0 leaves a side unbounded. */
    width: number;
    height: number;
    megapixels: number;
  };
  sharpening: Sharpening;
  metadata: MetadataMode;
  framed: boolean;
  /** Its `aspect` follows `frameAspect`. */
  frame: Frame;
  /** The frame's aspect ratio: a crop tool preset (`aspect.ts` in the web app), and the ratio typed for `custom`. */
  frameAspect: { preset: string; custom: string };
  /** File name pattern, without extension (see `exportFilename`). */
  filename: string;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'jpeg',
  quality: 92,
  depth: 16,
  colorSpace: 'srgb',
  size: { mode: 'full', longEdge: 2048, shortEdge: 1080, width: 1920, height: 1080, megapixels: 12 },
  sharpening: 'none',
  metadata: 'all',
  framed: false,
  frame: DEFAULT_FRAME,
  frameAspect: { preset: 'original', custom: '' },
  filename: '{name}',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string | number>(values: readonly { value: T }[], v: unknown, fallback: T): T =>
  values.some((x) => x.value === v) ? (v as T) : fallback;
const number = (v: unknown, fallback: number, min: number, max: number, integer = true): number => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const r = integer ? Math.round(n) : n;
  return Math.min(max, Math.max(min, r));
};
const string = (v: unknown, fallback: string, max = 200) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const color = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

function normalizeFrame(raw: unknown): Frame {
  const f = isObject(raw) ? raw : {};
  const d = DEFAULT_FRAME;
  const position = Array.isArray(f.position) ? f.position : [];
  return {
    size: number(f.size, d.size, 0, 10, false),
    aspect: number(f.aspect, d.aspect, 0, 100, false),
    orientation: f.orientation === 'portrait' || f.orientation === 'landscape' ? f.orientation : 'auto',
    position: [number(position[0], 0.5, 0, 1, false), number(position[1], 0.5, 0, 1, false)],
    color: color(f.color, d.color),
    line: number(f.line, d.line, 0, 10, false),
    lineOffset: number(f.lineOffset, d.lineOffset, 0, 10, false),
    lineColor: color(f.lineColor, d.lineColor),
  };
}

/**
 * Settings from anything (saved JSON, an older version), with defaults for what's
 * missing or invalid. Also reads the settings the export dialog kept before 8.5
 * (`size: '2048' | 'custom'`, `customSize`).
 */
export function normalizeExportSettings(raw: unknown): ExportSettings {
  const s = isObject(raw) ? raw : {};
  const d = DEFAULT_EXPORT_SETTINGS;
  const size = { ...d.size };
  if (isObject(s.size)) {
    const z = s.size;
    size.mode = oneOf(SIZE_MODES, z.mode, d.size.mode);
    size.longEdge = number(z.longEdge, d.size.longEdge, 1, MAX_EXPORT_SIZE);
    size.shortEdge = number(z.shortEdge, d.size.shortEdge, 1, MAX_EXPORT_SIZE);
    size.width = number(z.width, d.size.width, 0, MAX_EXPORT_SIZE);
    size.height = number(z.height, d.size.height, 0, MAX_EXPORT_SIZE);
    size.megapixels = number(z.megapixels, d.size.megapixels, 0.01, 10_000, false);
  } else if (typeof s.size === 'string') {
    // The old dialog: a long edge, 0 for full resolution, or `custom` for `customSize`.
    const edge = s.size === 'custom' ? Number(s.customSize) : Number(s.size);
    if (edge > 0) size.longEdge = number(edge, d.size.longEdge, 1, MAX_EXPORT_SIZE);
    size.mode = edge > 0 ? 'longEdge' : 'full';
  }
  const frameAspect = isObject(s.frameAspect) ? s.frameAspect : {};
  return {
    format: oneOf(EXPORT_FORMATS, s.format, d.format),
    quality: number(s.quality, d.quality, 1, 100),
    depth: s.depth === 8 ? 8 : 16,
    colorSpace: oneOf(COLOR_SPACES, s.colorSpace, d.colorSpace),
    size,
    sharpening: oneOf(SHARPENING, s.sharpening, d.sharpening),
    metadata: oneOf(METADATA_MODES, s.metadata, d.metadata),
    framed: s.framed === true,
    frame: normalizeFrame(s.frame),
    frameAspect: {
      preset: string(frameAspect.preset, d.frameAspect.preset, 40),
      custom: string(frameAspect.custom, '', 40),
    },
    filename: string(s.filename, d.filename).trim() || d.filename,
  };
}

/** The bounds the settings ask for. */
export function exportSize(s: ExportSettings['size']): ExportSize {
  switch (s.mode) {
    case 'full':
      return { type: 'full' };
    case 'longEdge':
      return { type: 'longEdge', size: s.longEdge };
    case 'shortEdge':
      return { type: 'shortEdge', size: s.shortEdge };
    case 'fit':
      return { type: 'fit', width: s.width, height: s.height };
    case 'megapixels':
      return { type: 'megapixels', megapixels: s.megapixels };
  }
}

/** What `renderExport` takes for these settings. */
export function exportOptions(s: ExportSettings): ExportOptions {
  return {
    format: s.format,
    quality: s.quality,
    depth: s.format === 'jpeg' ? 8 : s.depth,
    colorSpace: s.colorSpace,
    size: exportSize(s.size),
    sharpening: s.sharpening,
    frame: s.framed ? s.frame : null,
    metadata: s.metadata,
  };
}

/** A named set of export settings, saved by a user (`/api/export-presets`). */
export interface ExportPreset {
  id: string;
  name: string;
  settings: ExportSettings;
}

/** What a file name pattern can refer to. */
export interface FilenameFields {
  /** The original file's name. */
  filename: string;
  /** The version's name, or null for an unnamed one. */
  versionName: string | null;
  /** 1-based position among the photo's versions. */
  versionIndex: number;
  versionCount: number;
  title: string | null;
  capturedAt: string | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  rating: number;
}

export const FILENAME_TOKENS: { token: string; description: string }[] = [
  { token: '{name}', description: 'Original file name' },
  { token: '{version}', description: 'Version name, or its number if the photo has several' },
  { token: '{title}', description: 'Title' },
  { token: '{date}', description: 'Capture date (YYYY-MM-DD)' },
  { token: '{time}', description: 'Capture time (HHMMSS)' },
  { token: '{camera}', description: 'Camera model' },
  { token: '{lens}', description: 'Lens model' },
  { token: '{iso}', description: 'ISO' },
  { token: '{rating}', description: 'Rating (stars)' },
];

/** Characters file systems refuse, and control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const SEPARATORS = /[-_ .]/;

/**
 * The file name for `pattern` (tokens of `FILENAME_TOKENS`, other text kept), with
 * `extension`. Tokens with no value are left out, along with the separator before
 * them; characters file systems don't allow become `_`.
 */
export function exportFilename(pattern: string, fields: FilenameFields, extension: string): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(fields.capturedAt ?? '');
  const values: Record<string, string | null> = {
    name: fields.filename.replace(/\.[^.]+$/, ''),
    version: fields.versionName?.trim() || (fields.versionCount > 1 ? `v${fields.versionIndex}` : null),
    title: fields.title?.trim() || null,
    date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
    time: date?.[4] ? `${date[4]}${date[5]}${date[6]}` : null,
    camera: fields.camera?.trim() || null,
    lens: fields.lens?.trim() || null,
    iso: fields.iso ? String(fields.iso) : null,
    rating: fields.rating > 0 ? String(fields.rating) : null,
  };
  let out = '';
  let rest = pattern;
  for (;;) {
    const m = /\{(\w+)\}/.exec(rest);
    if (!m) break;
    out += rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    const key = m[1]!.toLowerCase();
    if (!(key in values)) {
      out += m[0];
      continue;
    }
    const value = values[key];
    if (value) out += value;
    // An empty token takes the separator before it along (`{name}-{version}` → `name`).
    else if (SEPARATORS.test(out.slice(-1)) && (!rest || SEPARATORS.test(rest[0]!))) out = out.slice(0, -1);
  }
  out += rest;
  const name = out
    .replace(UNSAFE, '_')
    .replace(/^[-_ .]+|[-_ .]+$/g, '')
    .slice(0, 200);
  return `${name || values.name || 'export'}.${extension}`;
}
