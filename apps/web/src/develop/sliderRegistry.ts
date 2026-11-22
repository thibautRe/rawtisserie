/**
 * Every `ParamSlider` on screen, so that something else can drive one as a drag would
 * (the spotlight, roadmap 2.6): its value and range as last rendered, and its handlers.
 */
import type { Extent, SliderCurve, SliderRange } from './slider.ts';

export interface SliderHandle {
  /** The slider's root element, to find the ones within a part of the page. */
  root: HTMLElement | null;
  label: string;
  value: number;
  range: SliderRange;
  /** The track's extent: the useful range, grown to a value set past it. */
  extent: Extent;
  curve: SliderCurve;
  format: (v: number) => string;
  disabled: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}

const sliders = new Set<() => SliderHandle>();

/** Adds a slider (`get` gives it as last rendered); returns its removal. */
export function registerSlider(get: () => SliderHandle): () => void {
  sliders.add(get);
  return () => void sliders.delete(get);
}

/** The sliders inside `container`, in the page's order. */
export function slidersIn(container: Element): SliderHandle[] {
  return [...sliders]
    .map((get) => get())
    .filter((s): s is SliderHandle & { root: HTMLElement } => !!s.root && container.contains(s.root))
    .sort((a, b) => (a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}
