# RAWtisserie — notes for contributors

See README.md for the architecture overview and commands.

- **Edit params exist twice**: `crates/pipeline/src/params.rs` (source of truth) and
  `packages/pipeline/src/params.ts`. Change both together. `npm test -w @rawtisserie/pipeline`
  asserts the defaults match (it needs a fresh `npm run build:wasm`).
- **Photo metadata** is mirrored the same way: `crates/pipeline/src/metadata.rs` ↔
  `packages/pipeline/src/metadata.ts`. So are **drawn shapes** (`shapes.rs` ↔ `shapes.ts`)
  and the sensor mapping (`geometry::SensorMapping` ↔ `toSensor`/`fromSensor`), the
  export frame (`frame.rs` ↔ `frame.ts`, layout compared in `frame.test.ts`), and export
  options and metadata (`export/` ↔ `export.ts`; `export.test.ts` checks Rust reads them
  back unchanged). Saved export settings are `ExportSettings` (TS only), normalised by
  `normalizeExportSettings` on the server and in the app.
- Shapes live in the recipe's top-level `shapes` (absent when empty), in normalised sensor
  coordinates; lengths are fractions of the sensor's shorter side. `normalize` drops
  spots and drawn mask parts without their shape, and shapes nothing uses, in both
  languages. Anything new that refers to shapes must be counted in Rust's `shape_refs`
  and TS's `paramShapeRefs`/`mapShapeRefs` (module parameters) or
  `maskShapeRefs`/`mapMaskShapeRefs` (an instance's mask), or its shapes get dropped.
  Presets and styles carry the shapes they use and rename them on apply through those.
- Masks (`ops/mask.rs`, `params::Mask` ↔ `Mask` in TS, mirrored like the params): an
  instance's optional `mask`, absent from the JSON when there's none, kept only on
  `ModuleKind::maskable` kinds (`MASKABLE_KINDS`). The drawn part is spatial: it's cached
  per slot (`MasksKey`, by the resolved shapes and feather). A mask with ranges and a
  feather (`Mask::feathers_whole`) is computed whole with the spatial stages, on the
  module's input (`PointMasksKey`: the point modules before it). Both keys must stay in
  `is_spatial_cached`, or the pool renders stale planes. The planes travel with the
  spatial image (`Developer::spatial`, wasm `spatialMaskIds`/`spatialMaskRows`). Other
  ranges, invert and opacity are per pixel (`MaskStage`, in the point pass). A masked
  step leaves the fixed chain for `Chain::Steps`; keep both fast (`examples/bench.rs`
  has mask cases). A mask also carries the blend mode (`ops/blend.rs`): scene-referred
  before filmic (fulcrum = the neutral value), on encoded sRGB for LUTs. LUT masks are
  measured on filmic's input, and only uniform LUTs (no shapes, no ranges) may be baked
  into filmic's table (`point::bakeable`).
- The tone curve ("Tones" in the UI) is also the tone equalizer: with `preserveDetail` it
  reads an EIGF-smoothed mask. Its statistics are computed like masks feathered whole
  (`PointMask::Tones` in `PointMasksKey`) from samples of its input, and travel as two
  planes (`tone_curve::plane_ids`) that the point pass blends with the pixel.
- After changing Rust code used from JS, run `npm run build:wasm` (output is gitignored).
- The server runs TypeScript directly with Node's type stripping (no build step): use
  `.ts` import extensions, `import type` for types, and no enums/namespaces/parameter
  properties (`erasableSyntaxOnly`).
- DB schema changes: add a new numbered SQL file in `apps/server/migrations/` (never edit
  applied ones), then `npm run db:schema -w @rawtisserie/server` to regenerate the types.
  The generated files are post-processed by `src/scripts/fix-generated-types.ts`.
- Library data model: `photos` (the file, EXIF, metadata corrections) → `versions`
  (curation, render state, `history_end`/`revision`) → `history_entries` (full recipe
  snapshots). The library lists versions; a web `Photo` is a version (`id` = version id,
  `photoId` = the file). Renders are keyed by version id.
- Chakra UI v3: in semantic tokens, declare `_light` before `_dark`. Chakra emits the
  condition blocks in first-seen order, and the `.dark` block must come last to win.
- The pipeline is scene-referred linear Rec.2020 until tone mapping; spatial parameters
  are in full-resolution pixels and get scaled by the render scale. Tone mapping lands
  in the output space: sRGB for previews, the export's (`output::ColorSpace`) for
  exports (`PointOps::for_space`, `FilmicStage::for_space`).
- Retouch runs on the base (or region patch) in place: `Retouched` keeps what each spot
  overwrote and restores it when the spots change, and `GeometryKey::retouch` is the
  spots' hash. A region's patch must cover what the spots touching it read
  (`retouch::needed`); `tests/regions.rs` checks it.
- `Developer` caches intermediate images (base → geometry → blur/sharpen) keyed by the
  parameters that affect them. A new spatial/geometry parameter must go into the
  matching cache key in `pipeline.rs`, or edits won't invalidate the cache. Per-pixel
  operations belong in `ops/point.rs` (`PointOps`), which re-runs on every render. Keep
  it cheap: precompute in `PointOps::new` and use lookup tables, not `powf`/`exp` per pixel.
- Geometry (`ops/geometry.rs`) maps output pixels to the base through a homography
  (`Mapping`, `wx`/`wy` the projective terms), built from `ops/perspective.rs`'s warp
  and framing. Without perspective and with the default auto-crop it takes the old
  affine path, bit for bit: keep it that way, or golden images move. The warp is built
  at whatever resolution the frame is (the full sensor for `SensorMapping`, the binned
  base for renders): its parameters must be relative (the focal length is a multiple
  of the long side), or renders and guides disagree. `tests/perspective.rs` checks it.
- Zoomed-in views render a region (`RenderSize::with_region`) from a patch of the base.
  Spatial stages that read neighbours must report how far (`reach`, or the equalizer's
  `margin`) so the region gets that margin, and size-dependent choices must use the whole frame, not the region
  (see `equalizer::apply_in_frame`), and work reduced in cells must align them on the frame
  (`GlowOp::apply` takes the image's origin). `tests/regions.rs` checks regions match the whole render.
  The library's culling loupe uses region renders too: 100 % tiles rendered on the server
  (`render/zoom.ts`, one worker keeping the last RAW decoded).
- Measure with `cargo run --release --example bench -- photo.ARW 2400`.
- Interactive renders of colour/tone edits run on a worker pool (`develop/pointPool.ts`):
  the pipeline worker checks `Developer::is_spatial_cached` and sends each pool worker a
  strip of the spatial image, re-sent when its id (`spatial_image_id`) changes. So the
  spatial cache keys must be complete (see above), or the pool renders a stale image.
  `PointRenderer` must give exactly what `Developer::render` does (`tests/point_strips.rs`).
  Point-op caches live in `PointOpsCache`, shared by both. Pool size is capped at 4: more
  workers starve the main thread on hyperthreaded laptops. Findings and dead ends are in
  `docs/PERFORMANCE.md`; read it before another performance pass.
- The developer's main thread must stay idle during a drag: Chakra's style resolution is
  what's expensive, not the pixels. Sections of `ModulePanel` and the other panels are
  memoised, so `Section` deps must list everything its content reads, and handlers go
  through `latest`/`useStableCallback` so they never see an old recipe. `ParamSlider`
  ignores its handlers when comparing props: give it a new `key` if it gets rebound. Check with
  `npm run test:perf -w @rawtisserie/web` (slider drags in a real browser, with budgets).
  `npm run test:sliders -w @rawtisserie/web` checks `ParamSlider`'s pointer handling and
  commits against the slider library, in a browser too. Run it after changing either.
  `npm run test:library -w @rawtisserie/web` goes between the library and the developer (API
  mocked): run it after changing what they share (`library/libraryView.ts`, the film roll).
- Golden-image tests (`crates/pipeline/tests/golden.rs`) need `./scripts/fetch-golden-raws.sh`
  once. A change that moves the output fails them; if it's intended, re-bless with
  `GOLDEN_UPDATE=1 cargo test --release -p rawtisserie-pipeline --test golden` and say
  why in the commit. Pipeline refactors and optimisations must keep them passing as is.
- `ops/filmic.rs` is a port of Ansel's `filmicrgb.c` (GPL-3.0-or-later). When changing
  it, compare against upstream rather than reasoning from scratch, and check the 3D
  LUT accuracy with `cargo run --release --example filmic_lut_error -- photo.ARW`.
- `ops/primaries.rs`, `ops/equalizer.rs`, `ops/calibration.rs`, `ops/retouch.rs`,
  `ops/tone_curve.rs` and `ops/color_balance.rs` follow Ansel's `colorprimaries.c`, `atrous.c`,
  `channelmixerrgb.c`, `retouch.c`/`pixel/heal.c`, `rgbcurve.c` and
  `colorbalancergb.c` + `splittoningrgb.c` (same license; deviations are listed in
  the module docs). Colour balance's range weights are mirrored in TS (`toneRangeWeights`,
  for the settings graph), and its range mixers reuse calibration's mixer views
  (`MixerTarget` in `ModulePanel`). Its per-pixel grading is split into short branch-free
  loops over 64-pixel chunks so they vectorise: keep it that way. The tone curve and the contrast equalizer draw with `curveAt` (`develop/curve.ts`), which mirrors `equalizer::curve`. Upstream sources:
  github.com/aurelienpierreeng/ansel, `src/iop/` and `src/pixel/colorequal_shared.c`.
- White balance is colour calibration's job: the base image is balanced for D65 light
  (camera reference multipliers), and every recipe has a `colorCalibration` instance
  adapting from the as-shot light. A recipe without it renders D65-balanced colours.
- Creative LUTs (`ops/clut.rs`, the `lut` kind) are identified by the SHA-256 of their
  canonical form (`Clut::to_canonical`), not of the file. Recipes refer to them by that
  id; renderers get the tables separately (`ClutStore`: `Developer::luts_mut`,
  `PointRenderer::luts_mut`, wasm `loadLut`), so every pool worker needs them too, and a
  LUT that isn't loaded is skipped. They run after filmic on encoded sRGB (`Looks` in
  `ops/point.rs`); interactive renders bake them into filmic's 3D table
  (`FilmicStage::with_looks`), whose cache is keyed by filmic's parameters and the LUTs.
  They're stored and sent packed (`Clut::to_packed`, `.clut` files). The server keeps one
  file per table (`luts`) and a row per user who has it (`user_luts`, hidden rather than
  deleted, so recipes keep rendering); `collectLuts` removes tables nobody has, at start.
  Built-in LUTs are files in `packages/pipeline/luts/` listed in `BUILTIN_LUTS`: never
  change or remove one (recipes refer to its id), retire it instead.
- Edit params are versioned (`CURRENT_VERSION` / `EDIT_PARAMS_VERSION`, currently 7).
  Breaking look changes add a migration that sets `render_status = 'pending'` so
  library previews are re-rendered.
  Saved presets and styles (`presets.payload`) hold recipe fragments too: a migration
  that renames or reinterprets parameters must also handle them (`normalizeModulePreset`,
  `normalizeStyle` in `packages/pipeline/src/presets.ts`). A kind with distinct parts
  (e.g. colour calibration's tabs) lists them in `PRESET_GROUPS`, which must cover all
  its parameters.
- A recipe (v3) is a list of module instances; pipeline order is fixed by `ModuleKind`
  (same order as `MODULE_KINDS` in TS), and a kind without an enabled instance is
  skipped. A new module kind goes into the `modules!` macro in `params.rs`, the TS
  `ModuleParams`/`MODULE_KINDS`/`defaultModuleParams`, and the matching pipeline stage.
  Older recipes are migrated on load (`params/v2.rs` ↔ `migrateV2`); the TS tests
  check that both normalise sample recipes identically.
