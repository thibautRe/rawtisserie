# Performance notes

What has been measured, what was built from it, and what didn't work. Read this before
another performance pass. Follow-up ideas are in [ROADMAP.md](ROADMAP.md#performance).

Unless stated otherwise, numbers come from 2026-11-03, on an Intel i9-10885H laptop
(8 cores / 16 threads), with the golden Sony A7 III raw. "Native" means
`cargo run --release`; "browser" means `npm run test:perf -w @rawtisserie/web`
(Chromium, 1920×1080 viewport, full preview 1344×896, draft 835×557).

## Where the time goes

- **Point operations are linear in pixel count**: about 75 ns per pixel, native and
  single-threaded. Exposure → calibration → saturation → shadows/highlights →
  primaries → filmic → sRGB. A full 2400×1600 render with the spatial stages cached
  takes 290 ms, a 1200×800 draft 71 ms. That's why a fixed 0.5 MP draft was used for
  every drag, and why drafts look blurry.
- **Colour primaries' table**: 64³ nodes, `clut` + `delta` ≈ 6 MB. A full build from
  cached weights is 12–17 ms native. Half of that was decoding the same 64 grid values
  over and over (now decoded once). A hue drag reaches ~38 % of the nodes, and ~96 % of
  those really change, so the incremental update (`ColorPrimariesStage::update`, about
  9 ms) is close to the floor without approximating `finish()`'s sin/cos. The weights
  (`FieldWeights`, ~70 ms) only rebuild for gamut coverage and smoothing.
- **The main thread during a drag** is mostly React and Chakra re-rendering on every
  pointer move (`useResolvedProps`, `cva`, emotion's `serializeStyles`), plus the
  browser's style recalc, hit testing, layout and paint. This floor is ~30 %
  `mainBusy` for any slider; image frames add comparatively little.

## Built

- **Worker pool for the point pass** (`apps/web/src/develop/pointPool.ts`,
  `point.worker.ts`). The workers share no memory: each runs its own copy of the wasm
  module and keeps a horizontal strip of the cached spatial image. So it needs no
  nightly Rust, no COOP/COEP headers, and no separate Node build. Colour/tone drags
  render at full size; spatial drags keep the draft.

  | browser, image fps | draft (before) | pool, 4 workers |
  |---|---|---|
  | exposure | 835×557 @ 18 | 1344×896 @ 22 |
  | filmic contrast | 835×557 @ 14 | 1344×896 @ 17 |
  | primaries hue | 835×557 @ 10 | 1344×896 @ 11 |

- **Frames as `ImageBitmap`**: the pipeline worker builds the bitmap and the canvas
  takes it with `transferFromImageBitmap`. The main thread doesn't copy pixels
  (`putImageData` used to cost ~60 ms per 4 s drag in `Canvas2DResourceProvider`).
- **`ModulePanel` and `RenameDialog` memoised**, with stable handlers. A closed Chakra
  `Dialog` was re-rendering its state machine on every slider move (~35 ms per 4 s).
- **Incremental primaries table**: see above. It's bit-identical to a full build
  (`updates_match_full_builds`).

## Pool size: CPU contention, not main-thread work

With 8 workers the colour scenarios went over the 50 % `mainBusy` budget (43–58 %), even
though the main thread did no more work per frame. Even skipping drawing entirely only
saved ~3 %. The main thread's tasks simply ran slower: they shared physical cores with
busy workers, and all-core load lowers the turbo clock. Measured:

| workers | mainBusy, colour scenarios | exposure / filmic fps |
|---|---|---|
| 8 | 43–58 % | 30 / 24 |
| 6 | 42–56 % | 28 / 22 |
| 4 | 39–46 % | 22 / 17 |

UI fps (60) and input latency were fine in every configuration: `mainBusy` is a proxy.
The pool uses `min(4, hardwareConcurrency / 2 − 1)` workers, and none below 6
hardware threads. Re-measure on other machines before changing it.

## Tried and rejected

- **Baking the whole point chain into one 3D LUT** (so it could be applied at full
  size): only ~2× faster than the exact chain (~40 ns/px applying, 13 ms to build at
  33³, 100 ms at 65³). Accuracy was also poor: at 65³, 99 % of pixels within 2–7 levels
  but outliers up to 55, worse at 33³. Saturated colours and channels near zero fall
  between log-grid nodes. Filmic's own LUT works because its input is narrower.
- **Guided upsampling** (applying the draft's colour change to the last full frame):
  it still needs a full-resolution pass per frame, about the cost of a LUT, and it
  fringes at colour edges.
- **Building the primaries table once and broadcasting it to the pool**: no lower
  latency. Without shared memory every worker needs its own 6 MB copy, and posting it
  to N workers costs about as much as building it. Building a slice per worker and
  exchanging slices has the same problem. The duplicated builds waste CPU, not time.
- **Keeping frames out of React** (drawing from a callback, render time written
  straight into the DOM): no measurable `mainBusy` change, so it was reverted. Frame
  commits are not where the main thread's time goes; pointer-move renders are.

## How to measure

- Native: `cargo run --release --example bench -- photo.ARW 2400`. It's noisy on a
  laptop (±20 %): compare runs back to back.
- Browser: `PERF_NO_BUDGETS=1 PERF_JSON=out.json npm run test:perf -w @rawtisserie/web`.
  The scenarios run in order and keep their edits. "Equalizer mix" is a point-only
  change while the curves are flat (`is_identity`), so it uses the pool.
- Main-thread breakdowns: drive the same drag with Playwright, record a CDP trace
  (`Tracing.start`, categories `devtools.timeline,v8,blink,cc`), and sum self time
  per event name on `CrRendererMain`. For JS, use `Profiler.start` on a build made
  with `build: { minify: false }` so function names survive. Do this before guessing.
  Twice here, the obvious suspect (frame commits, canvas presentation) wasn't it.
