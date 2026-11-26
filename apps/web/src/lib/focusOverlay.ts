/**
 * How a focus map (roadmap 8.9) is drawn over a photo: each edge in one colour, more
 * opaque the sharper it is, the opacity dropping fast with the blur (cubically, clear
 * at `MAX_BLUR`). `examples/focus.rs` draws the same.
 */
import {
  BLUR_SCALE,
  type FocusMap,
  type FocusView,
  focusCells,
  focusView,
  MAX_BLUR,
  NO_EDGE,
  type SensorMapping,
} from '@rawtisserie/pipeline';
import { useEffect, useState } from 'react';

/** The tint, in sRGB. */
export const FOCUS_TINT = [90, 255, 120] as const;
/** Edges this sharp (σ, sensor pixels) or sharper are fully opaque. */
const OPAQUE = 0.5;

/** Opacity (0…255) by cell value. */
const ALPHA = Uint8ClampedArray.from({ length: 256 }, (_, v) => {
  if (v === NO_EDGE) return 0;
  const t = Math.min(1, Math.max(0, 1 - (v / BLUR_SCALE - OPAQUE) / (MAX_BLUR - OPAQUE)));
  return Math.round(255 * t * t * t);
});

/** The overlay's pixels (`width × height`, RGBA). */
export function focusOverlayPixels(view: FocusView): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(view.width * view.height * 4);
  for (let i = 0; i < view.cells.length; i++) {
    const a = ALPHA[view.cells[i]!]!;
    if (!a) continue;
    out[i * 4] = FOCUS_TINT[0];
    out[i * 4 + 1] = FOCUS_TINT[1];
    out[i * 4 + 2] = FOCUS_TINT[2];
    out[i * 4 + 3] = a;
  }
  return out;
}

/** Inflated maps, by their packed cells (a photo's map stays the same). */
const inflated = new Map<string, Promise<Uint8Array>>();

function cellsOf(map: FocusMap): Promise<Uint8Array> {
  let cells = inflated.get(map.cells);
  if (!cells) {
    cells = focusCells(map);
    inflated.set(map.cells, cells);
    // A few photos' worth: the loupe moves on through many.
    if (inflated.size > 8) inflated.delete(inflated.keys().next().value!);
  }
  return cells;
}

/**
 * `map` on the output frame of `width × height` pixels (full resolution) that `mapping`
 * places on the sensor; null until it's ready, or without a map. `key` names the
 * frame: the view is placed again only when it changes.
 */
export function useFocusView(
  map: FocusMap | null,
  frame: { mapping: SensorMapping; width: number; height: number; key: string } | null,
): FocusView | null {
  const [view, setView] = useState<{ view: FocusView; map: FocusMap; key: string } | null>(null);
  const key = frame?.key;
  useEffect(() => {
    if (!map || !frame) return;
    let live = true;
    cellsOf(map).then(
      (cells) => {
        if (live)
          setView({ view: focusView(map, cells, frame.mapping, frame.width, frame.height), map, key: frame.key });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [map, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return view && view.map === map && view.key === key ? view.view : null;
}
