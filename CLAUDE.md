# RAWtisserie — notes for contributors

See README.md for the architecture overview and commands.

- **Edit params exist twice**: `crates/pipeline/src/params.rs` (source of truth) and
  `packages/pipeline/src/params.ts`. Change both together. `npm test -w @rawtisserie/pipeline`
  asserts the defaults match (it needs a fresh `npm run build:wasm`).
- **Photo metadata** is mirrored the same way: `crates/pipeline/src/metadata.rs` ↔
  `packages/pipeline/src/metadata.ts`. So are **drawn shapes** (`shapes.rs` ↔ `shapes.ts`)
  and the sensor mapping (`geometry::SensorMapping` ↔ `toSensor`/`fromSensor`).
- Shapes live in the recipe's top-level `shapes` (absent when empty), in normalised sensor
  coordinates; lengths are fractions of the sensor's shorter side. `normalize` drops
  spots without their shape and shapes nothing uses, in both languages. Anything new that
  refers to shapes (masks) must be counted in `shape_refs`/`shapeRefs`, or its shapes
  get dropped, and styles must carry them (`styleFromRecipe`, `applyStyle`).
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
  are in full-resolution pixels and get scaled by the render scale.
- Retouch runs on the base (or region patch) in place: `Retouched` keeps what each spot
  overwrote and restores it when the spots change, and `GeometryKey::retouch` is the
  spots' hash. A region's patch must cover what the spots touching it read
  (`retouch::needed`); `tests/regions.rs` checks it.
- `Developer` caches intermediate images (base → geometry → blur/sharpen) keyed by the
  parameters that affect them. A new spatial/geometry parameter must go into the
  matching cache key in `pipeline.rs`, or edits won't invalidate the cache. Per-pixel
  operations belong in `ops/point.rs` (`PointOps`), which re-runs on every render. Keep
  it cheap: precompute in `PointOps::new` and use lookup tables, not `powf`/`exp` per pixel.
- Zoomed-in views render a region (`RenderSize::with_region`) from a patch of the base.
  Spatial stages that read neighbours must report how far (`reach`, or the equalizer's
  `margin`) so the region gets that margin, and size-dependent choices must use the whole frame, not the region
  (see `equalizer::apply_in_frame`). `tests/regions.rs` checks regions match the whole render.
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
- Golden-image tests (`crates/pipeline/tests/golden.rs`) need `./scripts/fetch-golden-raws.sh`
  once. A change that moves the output fails them; if it's intended, re-bless with
  `GOLDEN_UPDATE=1 cargo test --release -p rawtisserie-pipeline --test golden` and say
  why in the commit. Pipeline refactors and optimisations must keep them passing as is.
- `ops/filmic.rs` is a port of Ansel's `filmicrgb.c` (GPL-3.0-or-later). When changing
  it, compare against upstream rather than reasoning from scratch, and check the 3D
  LUT accuracy with `cargo run --release --example filmic_lut_error -- photo.ARW`.
- `ops/primaries.rs`, `ops/equalizer.rs`, `ops/calibration.rs` and `ops/retouch.rs`
  follow Ansel's `colorprimaries.c`, `atrous.c`, `channelmixerrgb.c` and
  `retouch.c`/`pixel/heal.c` (same license; deviations are listed in the module docs). Upstream sources:
  github.com/aurelienpierreeng/ansel, `src/iop/` and `src/pixel/colorequal_shared.c`.
- White balance is colour calibration's job: the base image is balanced for D65 light
  (camera reference multipliers), and every recipe has a `colorCalibration` instance
  adapting from the as-shot light. A recipe without it renders D65-balanced colours.
- Edit params are versioned (`CURRENT_VERSION` / `EDIT_PARAMS_VERSION`, currently 6).
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
