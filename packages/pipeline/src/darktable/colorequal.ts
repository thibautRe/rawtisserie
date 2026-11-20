/**
 * darktable's colour equalizer (`colorequal.c`, v4) as our colour primaries: theirs
 * edits hue, saturation and brightness along the hue circle (8 nodes, red to magenta,
 * interpolated periodically: `_periodic_RBF_interpolate`, in darktable UCS hue);
 * ours moves six control colours. Their curves are read at our colours' hues: hue shift
 * in degrees, saturation and brightness factors (1 = no change) as our shifts. Its
 * guided filter, contrast and saturation threshold aren't carried over. Ansel's colour
 * equalizer (v1) is another module (curves in rings): not translated.
 */
import { PRIMARIES, type ModuleParams, defaultModuleParams } from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

const NODES = 8;
const NAMES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'lavender', 'magenta'];
const COLOREQUAL_V4 = new Layout([
  ['threshold', 'f32'],
  ['smoothing_hue', 'f32'],
  ['contrast', 'f32'],
  ['white_level', 'f32'],
  ['chroma_size', 'f32'],
  ['param_size', 'f32'],
  ['use_filter', 'gboolean'],
  ...['sat', 'hue', 'bright'].flatMap((k) => NAMES.map((n) => [`${k}_${n}`, 'f32'] as const)),
  ['hue_shift', 'f32'],
]);

/** `_get_hue_node`: node `k`'s hue, radians in darktable UCS (`ANGLE_SHIFT` +20°). */
const nodeHue = (k: number, shift: number) => (((k * 360) / NODES + shift + 20) * Math.PI) / 180;

/** Least squares by normal equations (`pseudo_solve`). */
function solve(a: number[][], b: number[]): number[] {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    const p = m.slice(c).reduce((best, row, i) => (Math.abs(row[c]!) > Math.abs(m[best]![c]!) ? c + i : best), c);
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** `_periodic_RBF_interpolate`: the curve through `nodes` at any hue (radians). */
function periodic(nodes: number[], smoothing: number, shift: number, clip: boolean): (hue: number) => number {
  const m = Math.ceil(3 * Math.sqrt(smoothing));
  const kernel = (d: number) => {
    let s = 0;
    for (let l = 0; l < m; l++) s += Math.exp((-l * l) / smoothing) * Math.cos(l * Math.abs(d));
    return Math.exp(s);
  };
  const a = Array.from({ length: NODES }, (_, i) =>
    Array.from({ length: NODES }, (_, j) => kernel(nodeHue(i, shift) - nodeHue(j, shift))),
  );
  const w = solve(a, nodes);
  return (hue) => {
    const v = w.reduce((s, wk, k) => s + wk * kernel(hue - nodeHue(k, shift)), 0);
    return clip ? Math.max(0, v) : v;
  };
}

/** darktable UCS hue (`xyY_to_dt_UCS_UV`, `dt_UCS_LUV_to_JCH`) of a linear Rec.2020 colour. */
function ucsHue(rgb: number[]): number {
  const X = 0.636958 * rgb[0]! + 0.1446169 * rgb[1]! + 0.168881 * rgb[2]!;
  const Y = 0.2627002 * rgb[0]! + 0.6779981 * rgb[1]! + 0.0593017 * rgb[2]!;
  const Z = 0.0280727 * rgb[1]! + 1.0609851 * rgb[2]!;
  const [x, y] = [X / (X + Y + Z), Y / (X + Y + Z)];
  const uvd = [
    -0.783941002840055 * x + 0.277512987809202 * y + 0.153836578598858,
    0.745273540913283 * x - 0.205375866083878 * y - 0.165478376301988,
    0.318707282433486 * x + 2.16743692732158 * y + 0.291320554395942,
  ];
  const [u, v] = [uvd[0]! / uvd[2]!, uvd[1]! / uvd[2]!];
  const us = (1.39656225667 * u) / (Math.abs(u) + 1.49217352929);
  const vs = (1.4513954287 * v) / (Math.abs(v) + 1.52488637914);
  return Math.atan2(1.86323315098672 * us + 1.971853092390862 * vs, -1.124983854323892 * us - 0.980483721769325 * vs);
}

/** Our control colours, as hues: Rec.2020's primaries and secondaries, in `PRIMARIES`' order. */
const CONTROL: Readonly<Record<(typeof PRIMARIES)[number], number[]>> = {
  red: [1, 0.1, 0.1],
  yellow: [1, 1, 0.1],
  green: [0.1, 1, 0.1],
  cyan: [0.1, 1, 1],
  blue: [0.1, 0.1, 1],
  magenta: [1, 0.1, 1],
};

export const colorEqualizer: Translator = {
  operations: ['colorequal'],
  kinds: ['colorPrimaries'],
  translate(entry, bytes): Translation {
    if (entry.modversion !== 4)
      return { instance: null, status: 'skipped', note: `Version ${entry.modversion} isn't darktable's` };
    const p = COLOREQUAL_V4.read(bytes) as Record<string, number> | null;
    if (!p) return unreadable(entry);
    const values = (k: string) => NAMES.map((n) => p[`${k}_${n}`]!);
    const smoothing = p.smoothing_hue!;
    const shift = p.hue_shift!;
    const sat = periodic(values('sat'), smoothing, shift, true);
    const hue = periodic(
      values('hue').map((d) => (d * Math.PI) / 180),
      smoothing,
      shift,
      false,
    );
    const bright = periodic(values('bright'), smoothing, shift, true);
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const params: ModuleParams['colorPrimaries'] = {
      ...structuredClone(defaultModuleParams.colorPrimaries),
      ...Object.fromEntries(
        PRIMARIES.map((name) => {
          const h = ucsHue(CONTROL[name]);
          return [
            name,
            {
              hue: clamp((hue(h) * 180) / Math.PI, -180, 180),
              saturation: clamp((sat(h) - 1) * 100, -100, 100),
              brightness: clamp((bright(h) - 1) * 0.25, -0.25, 0.25),
            },
          ];
        }),
      ),
      whiteLevel: p.white_level!,
    };
    return {
      instance: instance('colorPrimaries', params),
      status: 'approximated',
      note: 'Its curves read at our six control colours',
    };
  },
};
