/**
 * Zooming the developer's image: where the image sits in its window for a zoom level,
 * and which part of it a zoomed-in render must cover. Pure functions; `useZoom.ts`
 * applies them to the page.
 *
 * The image is shown through a window (the viewport, or the inside of the ISO 12646
 * frame). At "fit" it is the fitted render, centred. Zoomed in, the same element is
 * scaled up with a CSS transform (instant, but blurry), and a render of the visible
 * region at the zoom level is laid over it once the view stops moving.
 */

/** Highest zoom: 8 device pixels per full-resolution pixel (800 %). */
export const MAX_ZOOM = 8;

/** What the zoom maps between, in CSS pixels unless stated otherwise. */
export interface ZoomLayout {
  /** The window the image is seen through. */
  windowWidth: number;
  windowHeight: number;
  /** The image at fit. */
  fitWidth: number;
  fitHeight: number;
  /** Device pixels per full-resolution pixel at fit. */
  fitScale: number;
  /** Size of the (cropped) image at full resolution: 100 %. */
  sourceWidth: number;
  sourceHeight: number;
  dpr: number;
}

/** A zoomed-in view. */
export interface ZoomView {
  /** Device pixels per full-resolution pixel: 1 is 100 %. */
  scale: number;
  /** The point of the image (0…1) at the centre of the window. */
  cx: number;
  cy: number;
}

/** The image's element, `fitWidth × fitHeight`, is shown with `translate(tx, ty) scale(k)`. */
export interface Placed {
  /** The view, kept within the image; null at fit. */
  view: ZoomView | null;
  k: number;
  tx: number;
  ty: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the image goes for `view` (fit if null), keeping the window on the image. */
export function placeView(layout: ZoomLayout, view: ZoomView | null): Placed {
  const zoomed = view !== null && view.scale > layout.fitScale;
  const k = zoomed ? view.scale / layout.fitScale : 1;
  // Smaller than the window along an axis: centred. Larger: no empty space at the edges.
  const axis = (window: number, fit: number, c: number) => {
    const size = fit * k;
    const t = size <= window ? (window - size) / 2 : clamp(window / 2 - c * size, window - size, 0);
    // On whole device pixels, so that 100 % stays sharp.
    const snapped = Math.round(t * layout.dpr) / layout.dpr;
    return [snapped, size <= window ? 0.5 : (window / 2 - t) / size] as const;
  };
  const [tx, cx] = axis(layout.windowWidth, layout.fitWidth, view?.cx ?? 0.5);
  const [ty, cy] = axis(layout.windowHeight, layout.fitHeight, view?.cy ?? 0.5);
  return { view: zoomed ? { scale: view.scale, cx, cy } : null, k, tx, ty };
}

/** The current zoom level (device pixels per full-resolution pixel). */
export function zoomScale(layout: ZoomLayout, view: ZoomView | null) {
  return view?.scale ?? layout.fitScale;
}

/** `scale` between fit and 800 %, or null for fit (or within a rounding error of it). */
function zoomLevel(layout: ZoomLayout, scale: number) {
  const s = clamp(scale, layout.fitScale, Math.max(layout.fitScale, MAX_ZOOM));
  return s <= layout.fitScale * 1.001 ? null : s;
}

/** The image point (0…1) under `(x, y)` (window coordinates). */
function pointAt(layout: ZoomLayout, view: ZoomView | null, x: number, y: number) {
  const p = placeView(layout, view);
  return [
    clamp((x - p.tx) / (layout.fitWidth * p.k), 0, 1),
    clamp((y - p.ty) / (layout.fitHeight * p.k), 0, 1),
  ] as const;
}

/**
 * Zoom to `scale` (fit at most, 800 % at least), keeping the image point under `(x, y)`
 * (window coordinates) where it is.
 */
export function zoomAround(layout: ZoomLayout, view: ZoomView | null, scale: number, x: number, y: number) {
  const s = zoomLevel(layout, scale);
  if (s === null) return null;
  const [u, v] = pointAt(layout, view, x, y);
  const k = s / layout.fitScale;
  const tx = x - u * layout.fitWidth * k;
  const ty = y - v * layout.fitHeight * k;
  const cx = (layout.windowWidth / 2 - tx) / (layout.fitWidth * k);
  const cy = (layout.windowHeight / 2 - ty) / (layout.fitHeight * k);
  return placeView(layout, { scale: s, cx, cy }).view;
}

/** Zoom to `scale`, bringing the image point under `(x, y)` to the centre of the window. */
export function zoomCentredOn(layout: ZoomLayout, view: ZoomView | null, scale: number, x: number, y: number) {
  const s = zoomLevel(layout, scale);
  if (s === null) return null;
  const [cx, cy] = pointAt(layout, view, x, y);
  return placeView(layout, { scale: s, cx, cy }).view;
}

/** Move the image by `(dx, dy)` CSS pixels. */
export function panView(layout: ZoomLayout, view: ZoomView | null, dx: number, dy: number) {
  const p = placeView(layout, view);
  if (!p.view) return null;
  const cx = (layout.windowWidth / 2 - (p.tx + dx)) / (layout.fitWidth * p.k);
  const cy = (layout.windowHeight / 2 - (p.ty + dy)) / (layout.fitHeight * p.k);
  return placeView(layout, { ...p.view, cx, cy }).view;
}

/**
 * What to render for a zoomed-in view: the bounds of the whole image at the zoom level
 * (never above 100 %: beyond that, its pixels are enlarged) and the visible part of it,
 * in device pixels. Null at fit.
 */
export function visibleRegion(layout: ZoomLayout, view: ZoomView | null) {
  const p = placeView(layout, view);
  if (!p.view) return null;
  const scale = Math.min(p.view.scale, 1);
  const width = Math.max(1, Math.round(layout.sourceWidth * scale));
  const height = Math.max(1, Math.round(layout.sourceHeight * scale));
  // The window, as fractions of the image.
  const span = (t: number, window: number, size: number) => [clamp(-t / size, 0, 1), clamp((window - t) / size, 0, 1)];
  const [x0, x1] = span(p.tx, layout.windowWidth, layout.fitWidth * p.k);
  const [y0, y1] = span(p.ty, layout.windowHeight, layout.fitHeight * p.k);
  const x = Math.floor(x0! * width);
  const y = Math.floor(y0! * height);
  const region = {
    x,
    y,
    width: Math.max(1, Math.ceil(x1! * width) - x),
    height: Math.max(1, Math.ceil(y1! * height) - y),
  };
  return { width, height, region, scale };
}
