import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type ZoomLayout, type ZoomView, panView, placeView, zoomAround, zoomCentredOn, zoomScale } from './zoom.ts';

/** How long the view must stay still before the zoomed-in region is rendered. */
const SETTLE_MS = 150;
/** Pointer travel (CSS pixels) below which a middle click is a click rather than a pan. */
const CLICK_SLOP = 4;
/** Wheel travel (pixels) that zooms by 2× with a mouse wheel; one notch is usually 100. */
const WHEEL_PER_OCTAVE = 300;
/** The same for a touchpad pinch, which comes as wheel events with `ctrlKey` and small deltas. */
const PINCH_PER_E = 100;
/** Horizontal finger travel (CSS pixels) at fit that's a swipe to the next or previous photo. */
const SWIPE_MIN = 60;

type Settle = 'now' | 'later';

/** Safari's pinch events (not in the DOM typings). */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/**
 * Zoom and pan the image shown in `windowRef` (`zoom.ts`), which must stay mounted: mouse wheel and touchpad
 * pinch zoom around the pointer, a middle click (or a left one with `clickToggles`)
 * toggles between fit and 100 % centred on the point clicked, and dragging (left or middle button) pans once zoomed in. A left
 * button press on an element marked `data-no-pan` (shapes being edited) is left to it.
 * On touch screens, two fingers pinch and pan, and with `onSwipe` a horizontal swipe at
 * fit goes to the next (1) or previous (-1) photo.
 *
 * Moving the view writes `stageRef`'s transform directly, without rendering React, so
 * the main thread stays free while the wheel turns. What it returns, the view to render
 * at full quality, only changes once the view has stayed still for a moment (or right
 * away for a click), with `zoomTo` to set the zoom level from elsewhere (the status bar).
 */
export function useZoom(
  windowRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
  /** Read after each render, so it may be set later in the render that calls this. */
  layoutRef: RefObject<ZoomLayout | null>,
  enabled: boolean,
  {
    clickToggles = false,
    onSwipe,
    mirror,
  }: {
    /** A left click (without dragging) toggles too, as a middle click does. */
    clickToggles?: boolean;
    onSwipe?: (direction: 1 | -1) => void;
    /**
     * Another window of the same size whose stage moves with this one (the developer's
     * compared image, roadmap M5). Its own gestures move both, unless its pointer events are off.
     */
    mirror?: { window: RefObject<HTMLElement | null>; stage: RefObject<HTMLElement | null> };
  } = {},
) {
  const swipe = useRef(onSwipe);
  swipe.current = onSwipe;
  const [settled, setSettled] = useState<ZoomView | null>(null);
  const state = useRef({
    view: null as ZoomView | null,
    layout: null as ZoomLayout | null,
    panning: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });

  const apply = () => {
    const s = state.current;
    const stage = stageRef.current;
    if (!stage || !s.layout) return;
    const p = placeView(s.layout, s.view);
    s.view = p.view;
    const transform = `translate(${p.tx}px, ${p.ty}px) scale(${p.k})`;
    const cursor = s.panning ? 'grabbing' : p.view ? 'grab' : '';
    stage.style.transform = transform;
    const mirrored = mirror?.stage.current;
    if (mirrored) mirrored.style.transform = transform;
    for (const win of [windowRef.current, mirror?.window.current]) if (win) win.style.cursor = cursor;
  };

  const show = (view: ZoomView | null, settle: Settle) => {
    const s = state.current;
    s.view = view;
    apply();
    clearTimeout(s.timer);
    if (settle === 'now') setSettled(s.view);
    else s.timer = setTimeout(() => setSettled(state.current.view), SETTLE_MS);
  };

  // Every render: the layout may have changed (window size, new frame, crop…).
  useLayoutEffect(() => {
    state.current.layout = layoutRef.current;
    apply();
  });

  // Back to fit while zoom isn't available (cropping).
  useEffect(() => {
    if (!enabled) show(null, 'now');
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(state.current.timer), []);

  useEffect(() => {
    if (!enabled) return;
    const s = state.current;
    const windows = [windowRef.current, mirror?.window.current].filter((w): w is HTMLElement => !!w);
    const detach = windows.map(attach);
    return () => {
      for (const d of detach) d();
      s.panning = false;
      apply();
    };
  }, [enabled, clickToggles]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Listen to gestures on `win` (the window or its mirror); returns the cleanup. */
  function attach(win: HTMLElement) {
    const s = state.current;
    /** Pointer position in the window's content box. */
    const local = (e: { clientX: number; clientY: number }) => {
      const r = win.getBoundingClientRect();
      return [e.clientX - r.left - win.clientLeft, e.clientY - r.top - win.clientTop] as const;
    };
    const zoomBy = (factor: number, e: { clientX: number; clientY: number }, settle: Settle) => {
      if (!s.layout) return;
      const [x, y] = local(e);
      show(zoomAround(s.layout, s.view, zoomScale(s.layout, s.view) * factor, x, y), settle);
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 800 : 1;
      const dy = e.deltaY * unit;
      const factor = e.ctrlKey ? Math.exp(-dy / PINCH_PER_E) : 2 ** (-dy / WHEEL_PER_OCTAVE);
      zoomBy(Math.min(2, Math.max(0.5, factor)), e, 'later');
    };

    // Fingers on the window (touch pointers), and the pinch while two are.
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; x: number; y: number } | null = null;
    const pinchState = () => {
      const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
      return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    // Safari's pinch: a touchpad's on macOS; on iOS the pointers do it (below).
    let gestureScale = 1;
    const gestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      if (touches.size) return;
      const g = e as GestureEvent;
      zoomBy(g.scale / gestureScale, g, 'later');
      gestureScale = g.scale;
    };

    let drag: {
      id: number;
      button: number;
      x: number;
      y: number;
      moved: boolean;
      /** Where it started, and whether at fit (a swipe, with a finger). */
      x0: number;
      y0: number;
      swipes: boolean;
    } | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          // A second finger: a pinch, not a drag or a tap.
          e.preventDefault();
          win.setPointerCapture(e.pointerId);
          drag = null;
          pinch = pinchState();
          return;
        }
        if (touches.size > 2) return;
      }
      if (drag || !(e.button === 1 || (e.button === 0 && (s.view || clickToggles)))) return;
      if (e.button === 0 && e.target instanceof Element && e.target.closest('[data-no-pan]')) return;
      e.preventDefault();
      drag = {
        id: e.pointerId,
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        moved: false,
        x0: e.clientX,
        y0: e.clientY,
        swipes: e.pointerType === 'touch' && !s.view && !!swipe.current,
      };
      win.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2 && touches.has(e.pointerId) && s.layout) {
        const now = pinchState();
        const [x, y] = local({ clientX: now.x, clientY: now.y });
        const zoomed = zoomAround(
          s.layout,
          s.view,
          zoomScale(s.layout, s.view) * (now.distance / pinch.distance),
          x,
          y,
        );
        show(panView(s.layout, zoomed, now.x - pinch.x, now.y - pinch.y), 'later');
        pinch = now;
        return;
      }
      if (!drag || e.pointerId !== drag.id || !s.layout) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
      drag = { ...drag, x: e.clientX, y: e.clientY, moved: true };
      s.panning = s.view !== null;
      show(panView(s.layout, s.view, dx, dy), 'later');
    };
    const end = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (pinch) {
        // The pinch is over; the finger left on doesn't start a drag.
        if (touches.size < 2) pinch = null;
        return;
      }
      if (!drag || e.pointerId !== drag.id) return;
      const click = e.type === 'pointerup' && (drag.button === 1 || clickToggles) && !drag.moved;
      const [dx, dy] = [e.clientX - drag.x0, e.clientY - drag.y0];
      const swiped =
        e.type === 'pointerup' && drag.swipes && Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > 1.5 * Math.abs(dy);
      drag = null;
      s.panning = false;
      if (swiped) {
        apply();
        return swipe.current?.(dx < 0 ? 1 : -1);
      }
      if (!click || !s.layout) return apply();
      if (s.view) return show(null, 'now');
      const [x, y] = local(e);
      show(zoomCentredOn(s.layout, null, 1, x, y), 'now');
    };
    // Middle-button autoscroll starts on mousedown, on the platforms that have it.
    const mouseDown = (e: MouseEvent) => e.button === 1 && e.preventDefault();

    win.addEventListener('wheel', wheel, { passive: false });
    win.addEventListener('gesturestart', gestureStart);
    win.addEventListener('gesturechange', gestureChange);
    win.addEventListener('pointerdown', down);
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', end);
    win.addEventListener('pointercancel', end);
    win.addEventListener('mousedown', mouseDown);
    return () => {
      win.removeEventListener('wheel', wheel);
      win.removeEventListener('gesturestart', gestureStart);
      win.removeEventListener('gesturechange', gestureChange);
      win.removeEventListener('pointerdown', down);
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', end);
      win.removeEventListener('pointercancel', end);
      win.removeEventListener('mousedown', mouseDown);
    };
  }

  /** Zoom to `scale` (null: fit), keeping the point at the centre of the window. Stable. */
  const zoomTo = useRef((scale: number | null) => {
    const s = state.current;
    if (!s.layout) return;
    const { windowWidth, windowHeight } = s.layout;
    show(scale === null ? null : zoomAround(s.layout, s.view, scale, windowWidth / 2, windowHeight / 2), 'now');
  }).current;

  return { view: settled, zoomTo };
}
