/**
 * darktable's and Ansel's contrast equalizer (`atrous.c`, v2, the same struct in both)
 * as ours, a port of Ansel's: five curves (luminance and colour detail, edges, and the
 * two noise thresholds) over detail size, coarse (0) to fine (1), and the mix. Theirs
 * have six nodes whose positions can move; ours, six fixed ones where theirs start: a
 * moved curve is read at ours (between its nodes, linearly).
 */
import { EQUALIZER_NODES, type ModuleParams } from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

const BANDS = 6;
const CURVES = { array: { array: 'f32', n: BANDS }, n: 5 } as const;
const ATROUS_V2 = new Layout([
  ['octaves', 'i32'],
  ['x', CURVES],
  ['y', CURVES],
  ['mix', 'f32'],
]);

/** Curve `ch` (nodes `x`, `y`) at position `t`. */
function at(x: number[], y: number[], t: number): number {
  const nodes = x.map((v, i) => [v, y[i]!] as const).toSorted((a, b) => a[0] - b[0]);
  if (t <= nodes[0]![0]) return nodes[0]![1];
  for (let i = 1; i < nodes.length; i++) {
    const [[x0, y0], [x1, y1]] = [nodes[i - 1]!, nodes[i]!];
    if (t <= x1) return y0 + ((y1 - y0) * (t - x0)) / Math.max(x1 - x0, 1e-6);
  }
  return nodes.at(-1)![1];
}

export const contrastEqualizer: Translator = {
  operations: ['atrous'],
  kinds: ['contrastEqualizer'],
  translate(entry, bytes): Translation {
    const p = entry.modversion === 2 ? ATROUS_V2.read(bytes) : null;
    if (!p) return unreadable(entry);
    const [xs, ys] = [p.x as number[][], p.y as number[][]];
    const ours = Array.from({ length: EQUALIZER_NODES }, (_, i) => i / (EQUALIZER_NODES - 1));
    let moved = false;
    const curve = (ch: number) => {
      if (xs[ch]!.some((v, i) => Math.abs(v - i / (BANDS - 1)) > 1e-3)) moved = true;
      return ours.map((t) => at(xs[ch]!, ys[ch]!, t));
    };
    const params: ModuleParams['contrastEqualizer'] = {
      luma: curve(0),
      chroma: curve(1),
      edges: curve(2),
      lumaDenoise: curve(3),
      chromaDenoise: curve(4),
      mix: p.mix as number,
    };
    const out: Translation = { instance: instance('contrastEqualizer', params), status: 'mapped' };
    return (moved as boolean) ? { ...out, status: 'approximated', note: 'Its moved nodes read at ours' } : out;
  },
};
