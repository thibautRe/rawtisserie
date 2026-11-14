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
  primaries → filmic → sRGB (measured before colour balance replaced saturation and
  shadows/highlights). A full 2400×1600 render with the spatial stages cached
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
  | ------------------ | -------------- | --------------- |
  | exposure           | 835×557 @ 18   | 1344×896 @ 22   |
  | filmic contrast    | 835×557 @ 14   | 1344×896 @ 17   |
  | primaries hue      | 835×557 @ 10   | 1344×896 @ 11   |

- **Frames as `ImageBitmap`**: the pipeline worker builds the bitmap and the canvas
  takes it with `transferFromImageBitmap`. The main thread doesn't copy pixels
  (`putImageData` used to cost ~60 ms per 4 s drag in `Canvas2DResourceProvider`).
- **`ModulePanel` and `RenameDialog` memoised**, with stable handlers. A closed Chakra
  `Dialog` was re-rendering its state machine on every slider move (~35 ms per 4 s).
- **WebAssembly SIMD** (`+simd128` in `.cargo/config.toml`): the compiler vectorises the
  pipeline's loops. Same results (no float reassociation), and every stage is faster:
  slider drags gained 8–18 % image fps, a zoomed-in render with the equalizer went from
  2.25 s to 1.54 s. Needs Safari 16.4+ (other browsers and Node have had it since 2021).
- **Zoom renders only the visible region** (`RenderSize::with_region`): from a patch of
  the base demosaiced around it, with the detail stages' reach as margin (capped at
  1024 px; within a level of the whole render, `tests/regions.rs`). The equalizer's
  margin is ¾ of its reach (`equalizer::margin`): ½ was off by several levels with
  extreme curves. The page enlarges the fitted render with a CSS transform and asks for the
  region once the view has been still for 150 ms, so wheel steps and pans cost nothing
  in the pipeline. Zoomed in, the fitted render keeps the committed recipe during a
  drag, so only the region renders. Native, 1300×900 view, lens + sharpen + equalizer:
  first zoom 570–690 ms (patch ~120–230 ms), pan within the patch ~450 ms, colour slider
  ~135 ms. Browser, default recipe: first zoom ~250 ms, 100 % pan ~110 ms, exposure drag
  at 100 % ~22 fps through the pool. With the equalizer on, its margin at 100 % (~380 px
  around a ~1300×900 view) is most of the cost: in wasm, a first zoom takes ~1.2 s and a
  pan ~1 s (2.25 s and 2 s before SIMD and the ¾ margin). Next step would be the
  equalizer itself (~140 ns/px native, 8 bands of 5-tap edge-aware passes).
- **Diffuse steps split by channel across the pool** (2026-11-11). Diffuse's channels
  never mix, so before a render the pipeline worker takes each uncached diffuse step as
  a job (`Developer::next_diffuse_job`: its three planes, prepared), diffuses two
  channels on pool workers and one itself, and hands them back (`provide_diffuse`); the
  render uses them. Same pixels (`tests/diffuse_jobs.rs`). Browser, 1024×683 fitted
  render, 16-thread laptop: AA filter 241 → 209 ms, denoise fine 1091 → 437 ms, lens
  deblur medium 1693 → 665 ms, add local contrast 4286 → 1516 ms. Needs a pool (6+
  hardware threads); without one, the developer diffuses them itself as before.
- **Diffuse's region margin follows how diffusion spreads** (2026-11-11). Zoomed in, a
  region was developed with diffuse's full theoretical reach (iterations × one
  iteration's), capped at 1024 px: 100 % views of iterated presets diffused ~12× the
  visible pixels, with twice the bands of a fitted render. Now the margin is one
  iteration's reach × max(1, ½·√iterations) (`DiffuseOp::reach`), and bands whose weight
  leaves them next to nothing (coefficients < 1e-4) are skipped, which halves the reach
  of each. Probed at 100 % on a 1800×1600 crop for every kind of built-in preset:
  identical in 8 bits at ½·√iterations; ⅓ was 1–2 levels off, and without the
  one-iteration floor, "fast sharpness" (1 iteration, radius 128) was too. Native,
  single thread, 1024×683 region at 100 %: denoise fine 25.6 → 1.6 s, lens deblur
  medium 21.0 → 3.7 s, AA filter unchanged (~0.45 s). Add local contrast stays ~22 s:
  its bands span hundreds of pixels at 100 %, so its margin is still the 1024 px cap.
  Left for it: keep the diffused area around the view while panning, or show the view
  without the widest steps first.
- **Full-resolution demosaic reads each photosite once** (it used to normalise every
  neighbour again, ~20 times per pixel): patches and full-size exports are 2–3× faster,
  bit-identical.
- **Masks** (roadmap 4.5). Native, 2400×1600, Sony ARW, with lens correction: a masked
  point slider drags at +4 % over unmasked (~470 vs ~455 ms here); moving a mask's
  shape costs ~50 ms over a point render; adding a 40 px edge-aware gradient ~250 ms
  once. What got it there: the detail stage isn't redone when only masks change (its
  key holds the masked steps' drawn parts); unchanged planes are reused; the guided
  filter's box means run along rows in f32 with f64 running sums (the column pass was
  cache-hostile, ~500 → ~150 ms); plane resampling maps positions exactly on a 16 px grid
  aligned to the frame and interpolates (lens mapping per pixel was ~110 ms for a
  full-frame gradient), skipping blocks that can't reach the shapes; a masked step runs
  as mask values, then the step on a copy, then the blend (three independent loops);
  the generic chain matches each step's type once per chunk rather than per pixel
  (which also speeds up recipes with repeated kinds); and hue uses a 4096-entry table
  over the "diamond angle" instead of `atan2`. A hue range is still the dearest part
  (~+20 % of a point pass). A feathered mask with ranges is computed with the spatial
  stages (its input through the point modules before it, then the guided filter): its
  range sliders, and point sliders before it, cost ~+200 ms at 2400 px and fall back to
  the draft while dragging.
- **Incremental primaries table**: see above. It's bit-identical to a full build
  (`updates_match_full_builds`).

## Pool size: CPU contention, not main-thread work

With 8 workers the colour scenarios went over the 50 % `mainBusy` budget (43–58 %), even
though the main thread did no more work per frame. Even skipping drawing entirely only
saved ~3 %. The main thread's tasks simply ran slower: they shared physical cores with
busy workers, and all-core load lowers the turbo clock. Measured:

| workers | mainBusy, colour scenarios | exposure / filmic fps |
| ------- | -------------------------- | --------------------- |
| 8       | 43–58 %                    | 30 / 24               |
| 6       | 42–56 %                    | 28 / 22               |
| 4       | 39–46 %                    | 22 / 17               |

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

## Colour balance (2026-11-08)

Native, i9-10885H, 4 MP of random colours, `ColorBalanceStage::apply_all` alone:

| path                                  | ns/pixel |
| ------------------------------------- | -------- |
| mixers only (weights table + 3×3 mix) | ~4       |
| saturation/brilliance (dt UCS)        | ~78      |
| plus chroma/vibrance/hue (Yrg)        | ~94      |

The dt UCS path is ~13 powers in a dependent chain. Written one pixel at a time it ran
at ~400 ns/pixel: one pixel is ~800 µops, too long for the CPU to overlap the next one,
and the compiler doesn't interleave pixels on its own (an unrolled 4-pixel loop changed
nothing). What got it to ~100: branch-free code (selects, `exp2_fast` without the
`floor` libm call, no `rem_euclid`), short loops over the chunk in structure-of-arrays
scratch (`Grading::apply_all`), and powers sharing their logarithms.

Then to ~78 (same output): the gamut table's position (`atan2`) computed in its own
vectorised loop, only the table reads left scalar (15 → 4 ns); the gamut soft-clip and
the conversion back split into two loops, the lightness and log-chroma recomputed only
in chunks where some colour clipped, and the chromaticity kept unnormalised (one
division instead of three). A `found |= …` accumulated inside a loop stopped that loop
vectorising (+20 ns): test the flags in a pass of their own.

Vectorisation check: LLVM's `-C remark=loop-vectorize` didn't report most of these
loops at all, vectorised or not. Count packed (`mulps`) against scalar (`mulss`)
instructions per source line instead (`objdump -d -l` on a build with
`CARGO_PROFILE_RELEASE_STRIP=none CARGO_PROFILE_RELEASE_DEBUG=line-tables-only`).

Where the ~78 ns go: range weights and xyY ~5, forward to dt UCS with saturation and
brilliance ~30, gamut lookup ~4, soft-clip and back ~40. A 2D table over (luminance,
colourfulness) could replace the forward part (~30 → ~10–15); the rest depends on
three values (lightness, chroma and the hue's gamut edge), so a table doesn't fit it.

## Library grid scrolling (2026-11-14)

Measured in the production build at 4× CPU slowdown, scrolling 600 photos with
thumbnails 37 px a frame for 150 frames: 1.2 s of script and 4 long tasks (~470 ms)
before, ~0.5 s and one (~80 ms) after. Almost all of it was Chakra resolving style props
(emotion's `serializeStyles`), not React or the DOM:

- Cards mount by the row as it scrolls, ~10 styled elements each. `PhotoCard` is now
  plain elements styled by one global stylesheet (`photoCardCss.ts`, in `theme.ts`),
  its state in data attributes: card mounts went from ~1.4 ms to too small to show.
- Every card on screen rendered again whenever a page came in: the grid's `onClick`
  depended on the photos list. It's a stable callback now.
- So did the whole sidebar (`useLibrarySearch` returned a new object each render), the
  status bar and the app menu: memoised.
- Sizes and offsets that change while scrolling (the grid's height and top) were style
  props, each new value a new CSS rule and a restyle of the page: inline styles now.
  The grid also renders only when other rows come into range, not on every scroll event.

What's left is `LibraryPage`'s own render when a page arrives. To measure: React's
profiling build (`react-dom/profiling`) with a `__REACT_DEVTOOLS_GLOBAL_HOOK__` that sums
each fiber's `selfBaseDuration` (skipping subtrees whose `child` didn't change), and a
CDP CPU profile of the unminified build. Test data needs thumbnails: without, every card
shows a spinner, and their animations dominate the measure.
