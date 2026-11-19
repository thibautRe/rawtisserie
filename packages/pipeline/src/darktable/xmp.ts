/**
 * darktable's and Ansel's edits in an XMP sidecar (`DSC01234.ARW.xmp`): the history
 * (`darktable:history`, one `rdf:li` per entry), how much of it applies
 * (`darktable:history_end`), the pipeline order and the drawn shapes
 * (`darktable:masks_history`). Both write the same format (xmp_version 2 and up, darktable
 * 3.0 onwards: `src/common/exif.cc` upstream, Ansel's `src/common/xmp_sidecar.cc`); older
 * sidecars keep the history in parallel arrays and aren't read.
 *
 * Parameters are encoded as hex, or as `gz` + two digits + base64 of a zlib stream
 * (`dt_exif_xmp_encode`); `decodeBlob` reads both.
 */

/** Which application wrote the sidecar. */
export type DarktableApp = 'darktable' | 'ansel';

export interface DarktableEntry {
  /** Position in the history (0-based). */
  num: number;
  /** Module id (`exposure`, `filmicrgb`…). */
  operation: string;
  enabled: boolean;
  /** Version of the module's parameter struct. */
  modversion: number;
  /** Encoded parameters (`decodeBlob`). */
  params: string;
  /** Tells instances of a module apart (0: the first one). */
  multiPriority: number;
  /** The instance's name, as shown in darktable ('' for the first one). */
  multiName: string;
  blendopVersion: number | null;
  /** Encoded blending and mask parameters (`dt_develop_blend_params_t`), if any. */
  blendopParams: string | null;
}

export interface DarktableMaskEntry {
  /** History entry this state of the shape belongs to. */
  num: number;
  id: number;
  /** `dt_masks_type_t` flags (circle, path, group, clone…). */
  type: number;
  name: string;
  version: number;
  /** Encoded points (`dt_masks_point_*_t`, `nb` of them). */
  points: string;
  nb: number;
  /** Encoded source position (clone/heal shapes). */
  src: string;
}

export interface DarktableXmp {
  app: DarktableApp;
  xmpVersion: number;
  entries: DarktableEntry[];
  /** Entries before this one apply. */
  historyEnd: number;
  /** `operation,multiPriority,…` in pipeline order (`darktable:iop_order_list`), if written. */
  iopOrder: { operation: string; multiPriority: number }[] | null;
  masks: DarktableMaskEntry[];
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A property of `xml` (the packet, or one `rdf:li`): an attribute, or an element with text. */
function prop(xml: string, name: string): string | null {
  const attribute = new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1];
  const element = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml)?.[1];
  const v = attribute ?? element;
  return v === undefined ? null : decodeEntities(v).trim();
}

/** The `rdf:li` items (their whole markup) of property `name`'s sequence. */
function listItems(xml: string, name: string): string[] {
  const block = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
  if (!block) return [];
  // An item is either empty (`<rdf:li …/>`, attributes) or has children (`<rdf:li …>…</rdf:li>`).
  return [...block.matchAll(/<rdf:li\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/rdf:li>)/g)].map((m) => m[0]);
}

const int = (v: string | null, fallback: number) => {
  const n = v === null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Whether `xml` (a sidecar's text) holds darktable or Ansel edits we can read. */
export const hasDarktableHistory = (xml: string) =>
  /<darktable:history[\s>]/.test(xml) && prop(xml, 'darktable:xmp_version') !== null;

/**
 * The edits in a darktable or Ansel sidecar, or null if it has none we can read (no
 * history, or the format before darktable 3.0).
 */
export function parseDarktableXmp(xml: string): DarktableXmp | null {
  const xmpVersion = int(prop(xml, 'darktable:xmp_version'), 0);
  if (xmpVersion < 2) return null;
  const entries: DarktableEntry[] = [];
  for (const [i, li] of listItems(xml, 'darktable:history').entries()) {
    const operation = prop(li, 'darktable:operation');
    const params = prop(li, 'darktable:params');
    const modversion = prop(li, 'darktable:modversion');
    // darktable refuses the whole history then (`_read_history_v2`).
    if (!operation || params === null || modversion === null) return null;
    const blendopVersion = prop(li, 'darktable:blendop_version');
    entries.push({
      num: int(prop(li, 'darktable:num'), i),
      operation,
      enabled: prop(li, 'darktable:enabled') === '1',
      modversion: int(modversion, 0),
      params,
      multiPriority: int(prop(li, 'darktable:multi_priority'), 0),
      multiName: prop(li, 'darktable:multi_name') ?? '',
      blendopVersion: blendopVersion === null ? null : int(blendopVersion, 0),
      blendopParams: prop(li, 'darktable:blendop_params'),
    });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.num - b.num);
  const masks: DarktableMaskEntry[] = listItems(xml, 'darktable:masks_history').map((li) => ({
    num: int(prop(li, 'darktable:mask_num'), 0),
    id: int(prop(li, 'darktable:mask_id'), 0),
    type: int(prop(li, 'darktable:mask_type'), 0),
    name: prop(li, 'darktable:mask_name') ?? '',
    version: int(prop(li, 'darktable:mask_version'), 0),
    points: prop(li, 'darktable:mask_points') ?? '',
    nb: int(prop(li, 'darktable:mask_nb'), 0),
    src: prop(li, 'darktable:mask_src') ?? '',
  }));
  const order = prop(xml, 'darktable:iop_order_list');
  const parts = order ? order.split(',') : [];
  const iopOrder = parts.length
    ? Array.from({ length: Math.floor(parts.length / 2) }, (_, i) => ({
        operation: parts[2 * i]!.trim(),
        multiPriority: int(parts[2 * i + 1]!, 0),
      }))
    : null;
  const historyEnd = Math.min(int(prop(xml, 'darktable:history_end'), entries.length), entries.length);
  return {
    app: whichApp(xml, entries.slice(0, historyEnd)),
    xmpVersion,
    entries,
    historyEnd,
    iopOrder,
    masks,
  };
}

/** Modules only darktable 5.6 has (`src/iop`), and only Ansel. */
const DARKTABLE_ONLY = new Set([
  'agx',
  'clahe',
  'colorharmonizer',
  'colortransfer',
  'enlargecanvas',
  'equalizer',
  'overlay',
  'primaries',
  'rasterfile',
  'sigmoid',
]);
const ANSEL_ONLY = new Set([
  'colorprimaries',
  'crystgrain',
  'drawlayer',
  'rawdenoiseai',
  'restorescans',
  'splittoningrgb',
]);
/** Parameter versions of the modules both have, where they differ: `[darktable, Ansel]`. */
const VERSIONS: Readonly<Record<string, readonly [number, number]>> = {
  borders: [4, 3],
  colorequal: [4, 1],
  crop: [3, 1],
  demosaic: [6, 4],
  denoiseprofile: [12, 11],
  diffuse: [2, 3],
  dither: [2, 1],
  exposure: [7, 6],
  filmicrgb: [6, 5],
  hazeremoval: [3, 1],
  lens: [10, 5],
  retouch: [3, 4],
  temperature: [4, 3],
  watermark: [7, 5],
};

/**
 * Which application wrote the history. Neither says so in the sidecar, and a photo
 * edited in one and then the other keeps traces of both (darktable keeps Ansel's
 * pipeline order, say), so the history's modules decide: those only one has, and
 * versions only one writes. Without any, the hashes: only darktable writes the basic
 * and auto-applied ones.
 */
function whichApp(xml: string, entries: readonly DarktableEntry[]): DarktableApp {
  let darktable = 0;
  let ansel = 0;
  for (const e of entries) {
    const versions = VERSIONS[e.operation];
    if (DARKTABLE_ONLY.has(e.operation) || (versions && e.modversion > versions[1])) darktable++;
    if (ANSEL_ONLY.has(e.operation) || (versions && e.modversion > versions[0])) ansel++;
  }
  if (darktable !== ansel) return darktable > ansel ? 'darktable' : 'ansel';
  return /darktable:(history_basic_hash|history_auto_hash|harmony_guide_type)\b/.test(xml) ||
    !/darktable:history_current_hash\b/.test(xml)
    ? 'darktable'
    : 'ansel';
}

/** The bytes of encoded parameters (hex, or `gzNN` + base64 of zlib data), or null if damaged. */
export async function decodeBlob(encoded: string): Promise<Uint8Array | null> {
  if (encoded.startsWith('gz')) {
    let compressed: Uint8Array;
    try {
      compressed = Uint8Array.from(atob(encoded.slice(4).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
    try {
      const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }
  if (encoded.length % 2 || /[^0-9a-f]/i.test(encoded)) return null;
  const out = new Uint8Array(encoded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(encoded.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Encode parameters as darktable does (for tests and fixtures). */
export async function encodeBlob(bytes: Uint8Array, compress = false): Promise<string> {
  if (!compress) return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
  const factor = Math.min(Math.floor(bytes.length / zipped.length) + 1, 99);
  return `gz${String(factor).padStart(2, '0')}${btoa(String.fromCharCode(...zipped))}`;
}

/**
 * The history as it applies: per instance (operation and `multiPriority`), its last entry
 * before `historyEnd`, in pipeline order (`iopOrder` if written, else history order).
 */
export function activeEntries(xmp: DarktableXmp): DarktableEntry[] {
  const last = new Map<string, DarktableEntry>();
  for (const e of xmp.entries.slice(0, xmp.historyEnd)) last.set(`${e.operation}\u0000${e.multiPriority}`, e);
  const active = [...last.values()];
  if (!xmp.iopOrder) return active;
  const rank = new Map(xmp.iopOrder.map((o, i) => [`${o.operation}\u0000${o.multiPriority}`, i]));
  const at = (e: DarktableEntry) => rank.get(`${e.operation}\u0000${e.multiPriority}`) ?? Number.MAX_SAFE_INTEGER;
  return active.toSorted((a, b) => at(a) - at(b));
}
