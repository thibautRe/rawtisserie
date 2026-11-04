import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ZOOM, type ZoomLayout, panView, placeView, visibleRegion, zoomAround, zoomCentredOn } from './zoom.ts';

// A 6000×4000 photo fitted in 1200×800 CSS pixels at dpr 1, in a 1400×900 window.
const layout: ZoomLayout = {
  windowWidth: 1400,
  windowHeight: 900,
  fitWidth: 1200,
  fitHeight: 800,
  fitScale: 0.2,
  sourceWidth: 6000,
  sourceHeight: 4000,
  dpr: 1,
};

test('fit is centred in the window', () => {
  assert.deepEqual(placeView(layout, null), { view: null, k: 1, tx: 100, ty: 50 });
});

test('zooming keeps the point under the pointer', () => {
  const view = zoomAround(layout, null, 1, 400, 250);
  assert.ok(view);
  assert.equal(view.scale, 1);
  const p = placeView(layout, view);
  assert.equal(p.k, 5);
  // Image point (300, 200) of the fitted image was under the pointer, and still is.
  assert.equal(p.tx + 300 * p.k, 400);
  assert.equal(p.ty + 200 * p.k, 250);
});

test('a click centres the point under the pointer', () => {
  // Image point (300, 200) of the fitted image is under (400, 250).
  const p = placeView(layout, zoomCentredOn(layout, null, 1, 400, 250));
  assert.equal(p.tx + 300 * p.k, 700);
  assert.equal(p.ty + 200 * p.k, 450);
  // Near a corner, the window stays on the image instead.
  const corner = placeView(layout, zoomCentredOn(layout, null, 1, 110, 60));
  assert.deepEqual([corner.tx, corner.ty], [0, 0]);
});

test('zoom stays between fit and 800 %', () => {
  assert.equal(zoomAround(layout, null, 0.1, 700, 450), null);
  assert.equal(zoomAround(layout, null, 0.2, 700, 450), null);
  assert.equal(zoomAround(layout, null, 100, 700, 450)?.scale, MAX_ZOOM);
});

test('the window stays on the image', () => {
  // Zoomed on the top-left corner, then panned further up-left: the corner stays put.
  const view = zoomAround(layout, null, 1, 100, 50);
  const p = placeView(layout, panView(layout, view, 500, 500));
  assert.equal(p.tx, 0);
  assert.equal(p.ty, 0);
  // Barely zoomed: smaller than the window across, so centred that way.
  const wide = placeView(layout, { scale: 0.23, cx: 0, cy: 0 });
  assert.equal(wide.tx, 10);
  assert.equal(wide.ty, 0);
});

test('the visible region is rendered at the zoom level, at most 100 %', () => {
  const view = { scale: 1, cx: 0.5, cy: 0.5 };
  const r = visibleRegion(layout, view)!;
  assert.deepEqual(r, { width: 6000, height: 4000, scale: 1, region: { x: 2300, y: 1550, width: 1400, height: 900 } });
  // At 400 %, a quarter of the window in full-resolution pixels (rounded outwards), at 100 %.
  const zoomed = visibleRegion(layout, { scale: 4, cx: 0.5, cy: 0.5 })!;
  assert.deepEqual(zoomed.region, { x: 2825, y: 1887, width: 350, height: 226 });
  assert.equal(visibleRegion(layout, null), null);
});
