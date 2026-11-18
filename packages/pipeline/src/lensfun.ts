/**
 * Lens correction from lensfun's database (roadmap 3.6): find a photo's camera and lens,
 * and interpolate the lens's calibration for the shot, into the `LensfunProfile` a
 * recipe's lens instance keeps (`params.ts`; Rust evaluates it). The database is
 * `lensfun/lensfun.json` (CC BY-SA 3.0, the lensfun project), built by
 * `scripts/lensfun-db.mjs`; the server reads it from disk, the app fetches it.
 *
 * A port of lensfun's own search and interpolation (github.com/lensfun/lensfun,
 * `libs/lensfun/`: `database.cpp`'s `FindCamerasExt`, `FindLenses` and `MatchScore`,
 * `auxfun.cpp`'s `lfFuzzyStrCmp` and `_lf_interpolate`, `lens.cpp`'s `GuessParameters`
 * and `Interpolate*`), searched as darktable does: the camera by its make and model, the
 * lens by its model only (makers differ between files and the database). Deviations:
 * - Cameras are first looked up by rawler's names for them (the script joins them on
 *   the file's make and model, which lensfun records), since that's what metadata has.
 * - Computed in doubles; terms are kept to 7 significant digits (as f32 in Rust).
 * - The focus distance isn't read from files: vignetting is interpolated for 1000 m,
 *   as darktable does without one.
 */
import type { PhotoMetadata } from './metadata.ts';
import type { LensfunDistortionModel, LensfunProfile, LensfunTcaModel } from './params.ts';

export interface LensfunCamera {
  maker: string[];
  model: string[];
  mount: string;
  crop: number;
  /** rawler's names for it (make, model). */
  rawler?: [string, string][];
}

export interface LensfunLens {
  maker: string[];
  /** Its name, then the same in other languages. */
  model: string[];
  mounts: string[];
  /** The crop factor and aspect ratio of the sensor it was calibrated with. */
  crop: number;
  aspect?: number;
  /** Projection, when not rectilinear. */
  type?: string;
  focal?: [number, number];
  aperture?: [number, number];
  distortion?: [number, LensfunDistortionModel, ...number[]][];
  tca?: [number, LensfunTcaModel, ...number[]][];
  /** focal, aperture, distance, k1, k2, k3 */
  vignetting?: number[][];
}

/** `lensfun/lensfun.json`. */
export interface LensfunDb {
  source: string;
  license: string;
  /** Mount → the mounts whose lenses fit it (with an adapter). */
  mounts: Record<string, string[]>;
  cameras: LensfunCamera[];
  lenses: LensfunLens[];
}

/** Lensfun's `MinFocal`, `MaxFocal`, `MinAperture`, `MaxAperture` (0: unknown). */
interface Ranges {
  minFocal: number;
  maxFocal: number;
  minAperture: number;
  maxAperture: number;
}

/** Vignetting is interpolated for this distance (m) when the file doesn't say. */
const DEFAULT_DISTANCE = 1000;

// ── lfFuzzyStrCmp ────────────────────────────────────────────────────────────

const isSpace = (c: string) => /\s/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';
const isPunct = (c: string) => /[!-/:-@[-`{-~]/.test(c);

/** Words of `str` as lensfun splits them: runs of digits, punctuation or letters, casefolded and sorted. */
export function fuzzyWords(str: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && isSpace(str[i]!)) i++;
    if (i >= str.length) break;
    const start = i++;
    const first = str[start]!;
    let strip = 0;
    if (isDigit(first)) {
      while (i < str.length && (isDigit(str[i]!) || str[i] === '.')) i++;
      // "2.0" is "2"
      if (i - start >= 2 && str[i - 2] === '.' && str[i - 1] === '0') strip = 2;
    } else if (isPunct(first)) {
      while (i < str.length && isPunct(str[i]!)) i++;
    } else {
      while (i < str.length && !isSpace(str[i]!) && !isDigit(str[i]!) && !isPunct(str[i]!)) i++;
    }
    // Lone symbols and a lone "f" aren't words, except "+" and "*".
    if (i - start === 1 && (isPunct(first) || first.toLowerCase() === 'f') && first !== '*' && first !== '+') continue;
    words.push(str.slice(start, i - strip).toLowerCase());
  }
  return words.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * How well `match` matches `pattern` (sorted words), 0–100: `lfFuzzyStrCmp::Compare`.
 * With `allWords`, every word of the pattern must be in the match.
 */
export function fuzzyScore(pattern: string[], match: string[], allWords: boolean): number {
  if (!match.length || !pattern.length) return 0;
  let mi = 0;
  let score = 0;
  for (const word of pattern) {
    const old = mi;
    for (; mi < match.length; mi++) {
      const m = match[mi]!;
      if (word === m) {
        score++;
        break;
      }
      if (word < m) {
        // Sorted: the word can't be further on.
        if (allWords) return 0;
        mi = old - 1;
        break;
      }
    }
    if (allWords) {
      if (mi >= match.length) return 0;
      mi++;
    } else if (mi >= match.length) mi = old;
    else mi++;
  }
  return Math.trunc((score * 200) / (pattern.length + match.length));
}

/** The best score over a multilingual name's strings (`Compare (const lfMLstr)`). */
const bestScore = (pattern: string[], names: string[][], allWords: boolean) => {
  let best = 0;
  for (const words of names) {
    best = Math.max(best, fuzzyScore(pattern, words, allWords));
    if (best >= 100) break;
  }
  return best;
};

// As `_lf_strcmp`: ignoring case, and spaces at either end or repeated.
const fold = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// ── lfLens::GuessParameters ──────────────────────────────────────────────────

const LENS_NAME_PATTERNS: [RegExp, [number, number, number]][] = [
  // [min focal]-[max focal]mm f/[min aperture]-[max aperture]
  [/^[^:]*?([0-9]+[0-9.]*)[-]?([0-9]+[0-9.]*)?(mm)\s+(f\/|f|1\/|1:)?([0-9.]+)(-[0-9.]+)?.*$/, [1, 2, 5]],
  // 1:[min aperture]-[max aperture] [min focal]-[max focal]mm
  [/^.*?1:([0-9.]+)[-]?([0-9.]+)?\s+([0-9.]+)[-]?([0-9.]+)?(mm)?.*$/, [3, 4, 1]],
  // [min aperture]-[max aperture]/[min focal]-[max focal]
  [/^.*?([0-9.]+)[-]?([0-9.]+)?\s*\/\s*([0-9.]+)[-]?([0-9.]+)?.*$/, [3, 4, 1]],
];
const EXTENDER = /^.*?[0-9](\.[0.9]+)?x.*$/;
const NOT_A_LENS = ['adapter', 'reducer', 'booster', 'extender', 'converter', 'magnifier'];

function guessRanges(model: string | undefined, lens?: LensfunLens): Ranges {
  const r: Ranges = {
    minFocal: lens?.focal?.[0] ?? 0,
    maxFocal: lens?.focal?.[1] ?? 0,
    minAperture: lens?.aperture?.[0] ?? 0,
    maxAperture: lens?.aperture?.[1] ?? 0,
  };
  let minf = Infinity;
  let maxf = -Infinity;
  let mina = Infinity;
  let maxa = -Infinity;
  if (model && (!r.minAperture || !r.minFocal) && !NOT_A_LENS.some((w) => model.includes(w)) && !EXTENDER.test(model)) {
    for (const [pattern, [f1, f2, a1]] of LENS_NAME_PATTERNS) {
      const m = pattern.exec(model);
      if (!m) continue;
      if (m[f1] !== undefined) minf = parseFloat(m[f1]) || 0;
      if (m[f2] !== undefined) maxf = parseFloat(m[f2]) || 0;
      if (m[a1] !== undefined) mina = parseFloat(m[a1]) || 0;
      break;
    }
  }
  if (lens && (!r.minAperture || !r.minFocal)) {
    for (const [f] of [...(lens.distortion ?? []), ...(lens.tca ?? [])]) {
      minf = Math.min(minf, f);
      maxf = Math.max(maxf, f);
    }
    for (const [f, a] of lens.vignetting ?? []) {
      minf = Math.min(minf, f!);
      maxf = Math.max(maxf, f!);
      mina = Math.min(mina, a!);
      maxa = Math.max(maxa, a!);
    }
  }
  if (minf !== Infinity && !r.minFocal) r.minFocal = minf;
  if (maxf !== -Infinity && !r.maxFocal) r.maxFocal = maxf;
  if (mina !== Infinity && !r.minAperture) r.minAperture = mina;
  if (maxa !== -Infinity && !r.maxAperture) r.maxAperture = maxa;
  if (!r.maxFocal) r.maxFocal = r.minFocal;
  return r;
}

// ── The database, indexed ────────────────────────────────────────────────────

interface IndexedLens {
  lens: LensfunLens;
  ranges: Ranges;
  words: string[][];
}

export interface CameraMatch {
  camera: LensfunCamera;
  /** Found by name (rawler's or lensfun's), not only by a fuzzy match. */
  exact: boolean;
}

export interface LensMatch {
  lens: LensfunLens;
  score: number;
}

/** A photo's camera and lens in the database, and its profile, or why there's none. */
export interface LensfunMatch {
  camera: LensfunCamera | null;
  lens: LensfunLens | null;
  profile: LensfunProfile | null;
}

export class Lensfun {
  readonly db: LensfunDb;
  readonly #lenses: IndexedLens[];
  readonly #cameraWords: { camera: LensfunCamera; maker: string[][]; model: string[][] }[];

  constructor(db: LensfunDb) {
    this.db = db;
    this.#lenses = db.lenses.map((lens) => ({
      lens,
      ranges: guessRanges(lens.model[0], lens),
      words: lens.model.map(fuzzyWords),
    }));
    this.#cameraWords = db.cameras.map((camera) => ({
      camera,
      maker: camera.maker.map(fuzzyWords),
      model: camera.model.map(fuzzyWords),
    }));
  }

  /** The camera that took a photo: by rawler's name, else lensfun's, else the best fuzzy match. */
  findCamera(make: string | null | undefined, model: string | null | undefined): CameraMatch | null {
    if (!make || !model) return null;
    const [mk, md] = [fold(make), fold(model)];
    const byRawler = this.db.cameras.find((c) => c.rawler?.some(([a, b]) => fold(a) === mk && fold(b) === md));
    if (byRawler) return { camera: byRawler, exact: true };
    const byName = this.db.cameras.find(
      (c) => c.maker.some((m) => fold(m) === mk) && c.model.some((m) => fold(m) === md),
    );
    if (byName) return { camera: byName, exact: true };
    // `FindCamerasExt`: every word of the pattern in the name, then any.
    const [makerWords, modelWords] = [fuzzyWords(make), fuzzyWords(model)];
    for (const allWords of [true, false]) {
      let best: { camera: LensfunCamera; score: number } | null = null;
      for (const c of this.#cameraWords) {
        const s1 = bestScore(makerWords, c.maker, allWords);
        const s2 = s1 && bestScore(modelWords, c.model, allWords);
        if (s1 && s2 && (!best || s1 + s2 > best.score)) best = { camera: c.camera, score: s1 + s2 };
      }
      if (best) return { camera: best.camera, exact: false };
    }
    return null;
  }

  /** Mounts whose lenses fit `mount`: itself, then the compatible ones. */
  mountsFor(mount: string): string[] {
    return [mount, ...(this.db.mounts[mount] ?? [])];
  }

  /**
   * Lenses for `model` (as a file names it) on `camera`, best first: `FindLenses` without
   * a maker, every word of the name in the lens's (`MatchScore`).
   */
  findLenses(camera: LensfunCamera | null, model: string): LensMatch[] {
    const pattern = guessRanges(model);
    const words = fuzzyWords(model);
    const compat = camera ? (this.db.mounts[camera.mount] ?? []) : [];
    const found: LensMatch[] = [];
    for (const l of this.#lenses) {
      const score = matchScore(pattern, words, l, camera, compat);
      if (score > 0) found.push({ lens: l.lens, score });
    }
    // Stable: equal scores keep the database's order, as lensfun's sort mostly does.
    return found.sort((a, b) => b.score - a.score);
  }

  /** Every lens, for picking one by hand: those that fit `camera` first. */
  lenses(camera: LensfunCamera | null): LensfunLens[] {
    if (!camera) return [...this.db.lenses];
    const mounts = this.mountsFor(camera.mount);
    const fits = (l: LensfunLens) => l.mounts.some((m) => mounts.includes(m));
    return [...this.db.lenses.filter(fits), ...this.db.lenses.filter((l) => !fits(l))];
  }

  /** A lens by its name (`LensfunProfile.lens`). */
  lens(name: string): LensfunLens | null {
    return this.db.lenses.find((l) => l.model[0] === name) ?? null;
  }

  /** The ranges lensfun reads from a lens's name and calibrations. */
  ranges(lens: LensfunLens): Ranges {
    return this.#lenses.find((l) => l.lens === lens)?.ranges ?? guessRanges(lens.model[0], lens);
  }

  /**
   * The correction for a photo, if its camera and lens are in the database and the lens
   * has calibrations for its sensor: what a new photo starts with.
   */
  match(metadata: Pick<PhotoMetadata, 'make' | 'model' | 'lensModel' | 'focalLength' | 'fNumber'>): LensfunMatch {
    const camera = this.findCamera(metadata.make, metadata.model)?.camera ?? null;
    const name = metadata.lensModel?.trim();
    const lens = (name && this.findLenses(camera, name)[0]?.lens) || null;
    const profile = lens ? this.profile(lens, camera?.crop ?? null, metadata) : null;
    return { camera, lens, profile };
  }

  /**
   * `lens`'s correction for a shot on a sensor of crop factor `crop` (the lens's own
   * calibration sensor when unknown), or null when it has nothing usable for it.
   */
  profile(
    lens: LensfunLens,
    crop: number | null,
    shot: Pick<PhotoMetadata, 'focalLength' | 'fNumber'>,
  ): LensfunProfile | null {
    const focal = shot.focalLength;
    if (!focal || !(focal > 0)) return null;
    const cropFactor = crop && crop > 0 ? crop : lens.crop;
    // `GetClosestCalibrationSet`: a calibration made on a larger sensor than the camera's
    // (or only slightly smaller) covers it.
    if (cropFactor / lens.crop < 0.96) return null;
    const distortion = interpolateSpline(lens.distortion ?? [], focal, 'distortion');
    const tca = interpolateSpline(lens.tca ?? [], focal, 'tca');
    const aperture = shot.fNumber && shot.fNumber > 0 ? shot.fNumber : null;
    const vignetting = aperture ? interpolateVignetting(lens, this.ranges(lens), focal, aperture) : null;
    if (!distortion && !tca && !vignetting) return null;
    const p: LensfunProfile = {
      lens: lens.model[0]!,
      cropFactor: round(cropFactor),
      calibCropFactor: round(lens.crop),
      calibAspectRatio: round(lens.aspect ?? 1.5),
      focalLength: round(focal),
    };
    if (aperture) p.fNumber = round(aperture);
    if (distortion) p.distortion = { model: distortion.model as LensfunDistortionModel, terms: distortion.terms };
    if (tca) p.tca = { model: tca.model as LensfunTcaModel, terms: tca.terms };
    if (vignetting) p.vignetting = vignetting;
    return p;
  }
}

const round = (x: number) => Number(x.toPrecision(7));

function matchScore(
  pattern: Ranges,
  words: string[],
  match: IndexedLens,
  camera: LensfunCamera | null,
  compat: string[],
) {
  let score = 0;
  const lens = match.lens;
  if (camera) {
    // One calibration set: the lens's.
    const [c, m] = [camera.crop, lens.crop];
    if (c > 0.01 && c < m * 0.96) return 0;
    if (c >= m * 1.41) score += 2;
    else if (c >= m * 1.31) score += 4;
    else if (c >= m * 1.21) score += 6;
    else if (c >= m * 1.11) score += 8;
    else if (c >= m * 1.01) score += 10;
    else if (c >= m) score += 5;
    else if (c >= m * 0.96) score += 3;
    else return 0;
  }
  const compare = (a: number, b: number) => {
    if (!a || !b) return 0;
    const r = a / b;
    return r <= 0.99 || r >= 1.01 ? -1 : 1;
  };
  for (const key of ['minFocal', 'maxFocal', 'minAperture', 'maxAperture'] as const) {
    const c = compare(pattern[key], match.ranges[key]);
    if (c < 0) return 0;
    if (c > 0) score += 10;
  }
  if (lens.mounts.length && (camera || compat.length)) {
    if (camera && lens.mounts.some((m) => fold(m) === fold(camera.mount))) score += 10;
    else if (compat.some((c) => lens.mounts.some((m) => fold(m) === fold(c)))) score += 9;
    else return 0;
  }
  const s = bestScore(words, match.words, true);
  if (!s) return 0;
  return score + (Math.trunc((s * 4) / 10) || 1);
}

// ── lfLens::InterpolateDistortion / InterpolateTCA ──────────────────────────

/** `_lf_interpolate`: a Hermite spline through y2 (t = 0) and y3 (t = 1); y1, y4 may be missing. */
function hermite(y1: number | null, y2: number, y3: number, y4: number | null, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const tg2 = y1 === null ? y3 - y2 : (y3 - y1) * 0.5;
  const tg3 = y4 === null ? y3 - y2 : (y4 - y2) * 0.5;
  return (2 * t3 - 3 * t2 + 1) * y2 + (t3 - 2 * t2 + t) * tg2 + (-2 * t3 + 3 * t2) * y3 + (t3 - t2) * tg3;
}

/**
 * Terms at `focal` from calibrations at other focal lengths: the two around it and the
 * next ones out, with the terms that go as 1/f scaled by f (`__parameter_scales`: all of
 * distortion's, TCA's but its first two).
 */
function interpolateSpline(
  rows: [number, string, ...number[]][],
  focal: number,
  kind: 'distortion' | 'tca',
): { model: string; terms: number[] } | null {
  let model: string | null = null;
  // The two nearest on either side of `focal`, as `__insert_spline` keeps them.
  const spline: (typeof rows)[number][] = [];
  const dist = [-Infinity, -Infinity, Infinity, Infinity];
  for (const row of rows) {
    if (model === null) model = row[1];
    else if (row[1] !== model) continue;
    const d = focal - row[0];
    if (d === 0) return { model, terms: row.slice(2).map((t) => round(t as number)) };
    // Slots 0–1: calibrations at longer focal lengths (1 the nearest); 2–3: shorter (2 the nearest).
    if (d < 0) {
      if (d > dist[1]!) {
        dist[0] = dist[1]!;
        dist[1] = d;
        spline[0] = spline[1]!;
        spline[1] = row;
      } else if (d > dist[0]!) {
        dist[0] = d;
        spline[0] = row;
      }
    } else if (d < dist[2]!) {
      dist[3] = dist[2]!;
      dist[2] = d;
      spline[3] = spline[2]!;
      spline[2] = row;
    } else if (d < dist[3]!) {
      dist[3] = d;
      spline[3] = row;
    }
  }
  if (model === null) return null;
  const [s0, s1, s2, s3] = [spline[0], spline[1], spline[2], spline[3]];
  if (!s1 || !s2) {
    const only = s1 ?? s2;
    return only ? { model, terms: only.slice(2).map((t) => round(t as number)) } : null;
  }
  const t = (focal - s1[0]) / (s2[0] - s1[0]);
  const count = s1.length - 2;
  const terms: number[] = [];
  for (let i = 0; i < count; i++) {
    const scaled = kind === 'distortion' || i >= 2;
    const scale = (row: (typeof rows)[number] | undefined) => (scaled && row ? row[0] : 1);
    const term = (row: (typeof rows)[number] | undefined) => (row ? (row[2 + i] as number) * scale(row) : null);
    terms.push(round(hermite(term(s0), term(s1)!, term(s2)!, term(s3), t) / (scaled ? focal : 1)));
  }
  return { model, terms };
}

// ── lfLens::InterpolateVignetting ────────────────────────────────────────────

function interpolateVignetting(
  lens: LensfunLens,
  ranges: Ranges,
  focal: number,
  aperture: number,
  distance = DEFAULT_DISTANCE,
): [number, number, number] | null {
  const rows = lens.vignetting ?? [];
  if (!rows.length) return null;
  // `__vignetting_dist`: focal length across the lens's range, aperture and distance reciprocal.
  const span = ranges.maxFocal - ranges.minFocal;
  const norm = (f: number) => (span !== 0 ? (f - ranges.minFocal) / span : f - ranges.minFocal);
  const away = (row: number[]) =>
    Math.hypot(norm(row[0]!) - norm(focal), 4 / row[1]! - 4 / aperture, 0.1 / row[2]! - 0.1 / distance);
  // Inverse distance weighting, p = 3.5.
  const terms = [0, 0, 0];
  let total = 0;
  let nearest = Infinity;
  for (const row of rows) {
    const d = away(row);
    if (d < 0.0001) return [round(row[3]!), round(row[4]!), round(row[5]!)];
    nearest = Math.min(nearest, d);
    const w = Math.abs(1 / d ** 3.5);
    for (let i = 0; i < 3; i++) terms[i]! += w * row[3 + i]!;
    total += w;
  }
  if (nearest > 1 || !(total > 0)) return null;
  return terms.map((t) => round(t / total)) as [number, number, number];
}
