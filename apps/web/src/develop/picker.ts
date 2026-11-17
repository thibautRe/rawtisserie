/**
 * The colour picker (roadmap 2.7): the pixel under the pointer, read by the pipeline
 * worker (`RenderBackend.pointer`/`onSample`). It changes as fast as the pointer moves,
 * so it lives in a small store that only what shows it subscribes to (the status bar's
 * readout, the scopes' and graphs' markers): the developer and its memoised panels
 * don't render again.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { PixelSample } from './protocol.ts';

/** The pixel under the pointer, and the pinned ones (the pipette), in pin order. */
export interface Samples {
  hover: PixelSample | null;
  pins: readonly (PixelSample | null)[];
}

const NONE: Samples = { hover: null, pins: [] };

export class SampleStore {
  #state: Samples = NONE;
  #listeners = new Set<() => void>();

  get = () => this.#state;

  set(hover: PixelSample | null, pins: readonly (PixelSample | null)[] = []) {
    this.#state = { hover, pins };
    for (const l of this.#listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };
}

const NO_STORE = new SampleStore();
export const SampleContext = createContext<SampleStore>(NO_STORE);

/** The pixel under the pointer and the pinned ones. */
export function useSamples(): Samples {
  const store = useContext(SampleContext);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The pixel under the pointer, or null. */
export function usePixelSample(): PixelSample | null {
  return useSamples().hover;
}

/** A marker's label: the pin's number, or none for the pointer. */
export interface Marked<T> {
  value: T;
  /** 1, 2, … for pinned samples; undefined for the one under the pointer. */
  pin?: number;
}

/** What to mark: the pinned samples (numbered), then the one under the pointer (drawn last, on top). */
export function marked(samples: Samples): Marked<PixelSample>[] {
  const pins = samples.pins.flatMap((s, i) => (s ? [{ value: s, pin: i + 1 }] : []));
  return samples.hover ? [...pins, { value: samples.hover }] : pins;
}

/** What instance `id` reads at the pinned samples and under the pointer (EV relative to middle grey). */
export function useModuleReads(id: string): Marked<number[]>[] {
  return marked(useSamples()).flatMap(({ value, pin }) => {
    const ev = value.reads.find((r) => r.id === id)?.ev;
    return ev?.length ? [{ value: ev, pin }] : [];
  });
}

// ── Values ──────────────────────────────────────────────────────────────────

const decode = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** CIE LCh(ab) (D65) of an 8-bit sRGB colour: lightness 0 … 100, chroma, hue in degrees (0 for a grey). */
export function lch([r, g, b]: readonly [number, number, number]): { l: number; c: number; h: number } {
  const [lr, lg, lb] = [decode(r), decode(g), decode(b)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  const [l, a, bb] = [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  const c = Math.hypot(a, bb);
  const h = c < 1e-3 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

/** A signed EV value: `+0.8 EV`, `−2.3 EV`. */
export const formatEv = (ev: number) => {
  const r = Math.round(ev * 10) / 10 + 0;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} EV`;
};
