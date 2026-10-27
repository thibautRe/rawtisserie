# RAWtisserie — notes for contributors

See README.md for the architecture overview and commands.

- **Edit params exist twice**: `crates/pipeline/src/params.rs` (source of truth) and
  `packages/pipeline/src/params.ts`. Change both together. `npm test -w @rawtisserie/pipeline`
  asserts the defaults match (it needs a fresh `npm run build:wasm`).
- **Photo metadata** is mirrored the same way: `crates/pipeline/src/metadata.rs` ↔
  `packages/pipeline/src/metadata.ts`.
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
- `Developer` caches intermediate images (base → geometry → blur/sharpen) keyed by the
  parameters that affect them. A new spatial/geometry parameter must go into the
  matching cache key in `pipeline.rs`, or edits won't invalidate the cache. Per-pixel
  operations belong in `ops/point.rs` (`PointOps`), which re-runs on every render. Keep
  it cheap: precompute in `PointOps::new` and use lookup tables, not `powf`/`exp` per pixel.
- Measure with `cargo run --release --example bench -- photo.ARW 2400`.
- Golden-image tests (`crates/pipeline/tests/golden.rs`) need `./scripts/fetch-golden-raws.sh`
  once. A change that moves the output fails them; if it's intended, re-bless with
  `GOLDEN_UPDATE=1 cargo test --release -p rawtisserie-pipeline --test golden` and say
  why in the commit. Pipeline refactors and optimisations must keep them passing as is.
- `ops/filmic.rs` is a port of Ansel's `filmicrgb.c` (GPL-3.0-or-later). When changing
  it, compare against upstream rather than reasoning from scratch, and check the 3D
  LUT accuracy with `cargo run --release --example filmic_lut_error -- photo.ARW`.
- Edit params are versioned (`CURRENT_VERSION` / `EDIT_PARAMS_VERSION`, currently 5).
  Breaking look changes add a migration that sets `render_status = 'pending'` so
  library previews are re-rendered.
- A recipe (v3) is a list of module instances; pipeline order is fixed by `ModuleKind`
  (same order as `MODULE_KINDS` in TS), and a kind without an enabled instance is
  skipped. A new module kind goes into the `modules!` macro in `params.rs`, the TS
  `ModuleParams`/`MODULE_KINDS`/`defaultModuleParams`, and the matching pipeline stage.
  Older recipes are migrated on load (`params/v2.rs` ↔ `migrateV2`); the TS tests
  check that both normalise sample recipes identically.
