# RAWtisserie — notes for contributors

See README.md for commands, docs/ARCHITECTURE.md for the architecture overview and
docs/MODULES.md for the image modules. User-facing docs (the seed of a future
documentation site) are in docs/guide/.

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
  A `raster` shape (roadmap 4.15) is another instance's mask as it applies it, in the
  output frame: no bounds, nothing to draw (`GeometricShape` in TS for the rest), never
  a retouch spot. A drawn part with one is combined after its sources' masks
  (`mask::RasterParts`: in the detail pass, or `PointMask::Raster`), and sources are kept
  for it (`DetailStep::source`, `PointMask::Source`); only instances before it count.
  Styles name sources among their instances `style-<index>` (`withRasterSources`).
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
- An instance may carry `autoTune: true` (filmic and tone curve only, both languages):
  a preset or style asked for its auto-tune, not run yet. The default recipe's filmic
  has it: a new image's first history entry (`AUTO_RECIPE_LABEL`) is that recipe
  resolved; a version's original (history at 0) is `originalEditParams`, unresolved. Renderers ignore it; whoever
  has the image resolves it with `resolveAutoTunes` (`autoTune.ts`) at `AUTO_TUNE_SIZE`:
  the developer on commit and on open, the server's render worker (writing the entry
  back) and zoom worker. Measures must stay pure functions of (recipe, image).
- The tone curve ("Tones" in the UI) is also the tone equalizer: with `preserveDetail` it
  reads an EIGF-smoothed mask. Its statistics are computed like masks feathered whole
  (`PointMask::Tones` in `PointMasksKey`) from samples of its input, and travel as two
  planes (`tone_curve::plane_ids`) that the point pass blends with the pixel.
- After changing Rust code used from JS, run `npm run build:wasm` (output is gitignored).
- Commits go through Prettier (`.githooks/pre-commit`, set up by `npm install`'s
  `prepare`): staged files are formatted and staged again; one that also has unstaged
  changes stops the commit if what's staged isn't formatted.
- rawler (RAW decoding) is patched from our fork (`[patch.crates-io]` in `Cargo.toml`,
  tag `rawtisserie/rawler-0.8.0-wasm` of thibautRe/dnglab; upstream PR
  dnglab/dnglab#960): something that works natively can still fail in
  wasm32-unknown-unknown (`std::time::Instant` panics there).
  `packages/pipeline/src/goldenRaws.test.ts` decodes every golden RAW through the wasm
  build. When upgrading rawler, drop the patch if a release has the fix, or tag a new one.
- Deleting from the library moves versions to the trash (`versions.trashed_at`,
  `photos/trash.ts`); only the trash deletes rows and files. Anything that reads
  versions for the library must leave trashed ones out (`whereClause`, `findVersion`
  do; the trash's own routes and the render queue don't). The trash page reuses the
  library's grid, selection (`useGridSelection`) and loupe: keep them working without
  editing (`Loupe`'s `onChange`/`onDevelop` and `PhotoGrid`'s `onOpen` are optional).
- Imports (`library/imports.ts`) live outside the pages, so they survive navigation:
  files are hashed in the browser and checked (`POST /api/photos/check`) before upload,
  versions get the import's id (`import_id`, the library's `?import=` filter), and an
  original deleted for good leaves only its hash in `deleted_originals`, so it's skipped
  unless uploaded with `allowDeleted`, as is a file whose versions are all in the trash
  (taken anyway, it gets a new version). The upload route checks all of it again.
  Every import is reviewed first (`ImportReview`): `findKnown` asks by name, size and
  modification time (`photos.file_modified_at`), without hashing; files it finds in the
  library or the trash are skipped without being read, hashed or sent. The review also reads
  tags, rating and label from the files' XMP/IPTC and `.xmp` sidecars (`fileTags.ts`; a
  RAW file also gets its JPEG's), sent with the upload for the new version. The app uploads in
  chunks (`photos/uploads.ts`: `/api/uploads`, resumable, taken in by `ingestReceived`
  like `POST /api/photos`, which stays for single requests).
- Tags are paths, levels separated by `|` (`People|Alice`, shown People › Alice; `lib/tags.ts`
  ↔ server `photos/tags.ts`), counted under their ancestors (filters, the tree's counts,
  `TAG_LEVELS`; exports write each level to `dc:subject` and the paths to
  `lr:hierarchicalSubject`). Tags are managed from the library's Tags filter (`library/TagTree.tsx`, each row's menu;
  the tag manager page it replaced redirects there): its editor (`TagEditor.tsx`) sets a
  tag's path, missing levels created with it, and shortcut; it renames, moves, merges and deletes
  across every version, trashed ones included, the tags under it too; `user_tags` holds
  tags no photo has yet and the tags' shortcuts. Anything that stores tag names must
  follow a rename there (saved filters do: `filter_presets`, `followTagRename`, in `tag`,
  `notTag` and `tagAny`; so does the library's address, `useTagManagement`). Tag filters (roadmap 8.12) group picked tags by parent, all or any
  (`tagAny`), and exclude (`notTag`) except under picked ones: `library/tagFilter.ts` ↔
  server `photos/query.ts` (`tagConditions`). Tag shortcuts (`useTagShortcuts`, `lib/keys.ts`) may be sequences
  (Ctrl+Alt+O, Ctrl+Alt+A), matched by physical key (`code`); they listen first (capture)
  and, while a sequence goes on, its keys do nothing else. A new app shortcut must go
  into `reservedPress`'s lists, or a tag's could hide it.
- Edits from darktable and Ansel (roadmap 8.15) are imported from sidecars at import only:
  the review reads them (`fileTags.ts`), the version keeps the sidecar's text
  (`versions.imported_edits`, in `SentVersion` too), and `startingHistory`
  (`importedEdits.ts`) makes the entry `importLabel(app)` after the starting one, in the
  render worker, the zoom worker and the developer alike (a pure function of the text and
  the photo, like the report the developer shows while that entry is current). Their
  modules are C structs read by `darktable/struct.ts` layouts copied from upstream
  (compare with it, as for the Ansel ports); a translator per module (`darktable/modules.ts`)
  decides our kinds it covers, and every enabled module of theirs lands in the report.
  darktable's duplicates (`NAME_01.ARW.xmp`, `duplicatesOf`) become more versions of the
  photo (`uploads.duplicates`). Their LUTs are referred to by name and path (`LutRef.path`,
  `id` empty) until the user has a LUT of that name: `resolveLutRefs`, at import and by
  the server when a LUT is added or renamed (`resolveImportedLuts`, in place, re-rendered).
- Collections (roadmap 8.14) are where photos come from, a tree like folders
  (`collections`, `photos.collection_id`: per photo, its versions with it; server
  `photos/collections.ts` ↔ `lib/collections.ts`). Names are unique among siblings and never
  have `|` (kept free to separate levels one day: refused when typed, `-` from files), so
  a path of names finds one: uploads and transfers (`SentVersion.collection`) name theirs
  and `collectionAt` makes what's missing. The filter (`collection`: ids, each with those
  under it, or `none`) is in `whereClause`. Anything new that creates photos decides
  their collection. The import review sorts new photos (`importCollections.ts`, capture
  times read in the browser by `captureTime.ts`, since the server learns them only when
  it renders); the sidebar's block (`CollectionFilter.tsx`) never scrolls on its own.
- Library actions on a selection take a `Target` (roadmap 8.13): ids, or `{ filter, except }`
  when Ctrl+A selected everything the filters match (`useGridSelection`'s `target()`).
  Server routes resolve it with `targetClause` (`photos/query.ts`) in their own query; a
  new bulk action must too, or it only reaches the photos loaded. Work done in the browser
  per photo gets the ids from `/api/versions/ids`. Above `LARGE_SELECTION` (200) actions
  ask first (`useConfirmLarge`). Photos an action changes stay listed, as in the loupe,
  until the user applies the filters again: `keepListed` before the change (the list is
  then read through `POST /api/versions/list` with `keep`, and targets carry it). A new
  action that changes photos from the library keeps them too.
- The API's shapes live in `packages/api` (`@rawtisserie/api`), imported by both apps: the
  web app's hooks type their requests with them, and the server's DTOs (`versionDto`,
  `adminUserDto`, `transferDto`…) and handlers declare them as return types, so a field
  renamed on one side fails `typecheck` on the other. Dates are sent as ISO strings
  (`.toISOString()`, never a `Date` left for JSON). What the web sends is checked against
  the routes' zod schemas at compile time (`Fits` in `photos/query.ts`): add one for a new
  request type. A new response shape goes there, not in either app.
- Sending to another instance (`apps/server/src/transfer/`): the sender's server posts
  `SentVersion`s (`protocol.ts`) to the receiver's `/api/transfer/…`, authorised by an
  access token that can only add. Anything new a version carries (a column, a photo
  correction) must go into `SentVersion` (and `sendVersion`/`update` on each side), or it
  won't travel; a change the other side can't read bumps `PROTOCOL`. Requests to other
  instances go through `remoteFetch`, which refuses private addresses.
- Storage quotas count original files only (`accounts/quota.ts`); anything new that
  stores user files must decide whether it counts, and check `fits` before storing.
  Admin-only routes use `requireAdmin` (and the page checks `isAdmin` too).
- Limits against unintended use are in `apps/server/src/limits.ts`: rate limits (per user,
  per address signed out; a route's own with `config.rateLimit`) and how many of each thing
  a user may keep (`MAX_COUNT`, `checkCount`). Anything new a user can create (a table of
  their own rows, files outside the quota) gets a count there; check it on every path that
  creates one (transfers too).
- Library renders are AVIF, encoded by `sharp` (native) in the render worker from wasm's
  `renderFinal`; `versions.render_format` says what a version's stored renders are
  (older ones stay JPEG until rendered again), so build keys with `renderKey(…, format)`.
  Loupe tiles stay JPEG. sharp is imported by the render queue on the main thread too,
  before any worker: keep it that way, workers stop when idle.
- Renders that fail are retried by the queue (`render/queue.ts`): after `RETRY_DELAYS_MS`,
  then by each new build on start (`config.revision`, the image's commit), so a failure
  never needs a re-render by hand. A new way for a render to fail goes through `fail`,
  not straight to `render_status = 'failed'`.
- Files (originals, renders, uploaded LUTs) go through the object store
  (`apps/server/src/storage/`: local disk or S3, by key), never `fs` directly, so both
  work; worker threads use it too. Uploads in progress stay on local disk.
- A file the server reads at run time (data in `packages/pipeline`, models, the web
  app) must be in the production image: `apps/server/src/scripts/check-image.ts`, run
  as the image's last build step, reads each the way the server does. Add what you add
  to it, or the image builds without it and production fails (lensfun's database did).
- `docs/DEPLOYMENT.md` has the deployment diagram and what CI (`.github/workflows/ci.yml`)
  runs. Update it with any change to what runs in production, where it stores things, or
  how it's built and checked.
- The server runs TypeScript directly with Node's type stripping (no build step): use
  `.ts` import extensions, `import type` for types, and no enums/namespaces/parameter
  properties (`erasableSyntaxOnly`).
- Server tests run without `.env`, as in CI (no database). Importing `db.ts` is fine:
  `config.databaseUrl` is read and the pool (`db`, a proxy) created on first use. So
  don't read required settings at module load, and keep what tests call off the database.
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
- `Developer` caches intermediate images (base → geometry → diffuse/equalizer/glow) keyed by the
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
  Point-op caches live in `PointOpsCache`, shared by both. Diffuse steps are split by
  channel across the pool too: before a render the pipeline worker takes
  `Developer::next_diffuse_job`s and hands back their planes (`provide_diffuse`), which
  the render then uses. They're matched by `diffuse_key` (geometry key, frame, padded
  region, steps up to it): it must cover everything a diffuse step's input depends on,
  or a render picks up a stale one. `tests/diffuse_jobs.rs` checks it's the same render. Pool size is capped at 4: more
  workers starve the main thread on hyperthreaded laptops. Findings and dead ends are in
  `docs/PERFORMANCE.md`; read it before another performance pass.
- The spotlight (roadmap 2.6, a prototype: `develop/Spotlight.tsx`) knows every slider
  of the module panel from `develop/panelCatalog.ts` (`SPOTLIGHT_SLIDERS`, with the tabs
  and folds each is on): a slider added, renamed or moved in `ModulePanel` goes there
  too. `npm run test:spotlight -w @rawtisserie/web` focuses each one and fails otherwise.
- The developer's main thread must stay idle during a drag: Chakra's style resolution is
  what's expensive, not the pixels. Sections of `ModulePanel` and the other panels are
  memoised, so `Section` deps must list everything its content reads, and handlers go
  through `latest`/`useStableCallback` so they never see an old recipe. `ParamSlider`
  ignores its handlers when comparing props: give it a new `key` if it gets rebound. Check with
  `npm run test:perf -w @rawtisserie/web` (slider drags in a real browser, with budgets).
  `npm run test:sliders -w @rawtisserie/web` checks `ParamSlider`'s pointer handling and
  commits against the slider library, in a browser too. Run it after changing either.
  `npm run test:library -w @rawtisserie/web` goes between the library and the developer (API
  mocked): run it after changing what they share (`library/libraryView.ts`, the film roll),
  or the library export (`export/`; it exports a golden RAW, skipped without them).
- The colour picker (roadmap 2.7): the page sends the pointer's place (and the pipette's
  pins, kept in sensor coordinates) to the pipeline worker (`pointer`/`pins`), which reads
  the pixel between messages and after each render with `Developer::sample`
  (`pipeline/sample.rs`): one pixel of the cached spatial image through the point modules,
  and nothing when that cache is cold (it must never render). Samples land in a store
  (`picker.ts`) that only the markers and the readout subscribe to, so the developer and
  its memoised panels don't render on pointer moves. A new module with a graph of the
  image marks it through `ModuleRead` (Rust) and `useModuleReads`. The worker samples
  between messages, and warms the shown view's cache only when idle (`sampleAt`). In a
  browser: `npm run test:picker -w @rawtisserie/web`.
- Compare (roadmap M5, `develop/compare.ts`): the developer renders a second recipe, a
  history entry or another version with the edited one's lens and geometry instances
  (`FRAMING_KINDS`, `compareRecipe`), in its own pane whose stage the zoom moves too
  (`useZoom`'s `mirror`). Its renders are flagged `compare`, so the picker and raw denoise
  keep following the edited image: a new kind of secondary render must be flagged too.
  A new framing module kind goes into `FRAMING_KINDS`. In a browser: `npm run test:compare -w @rawtisserie/web`.
- Drawing shapes (`develop/ShapeOverlay.tsx`): the path tool's draft lives in the overlay
  (pointer moves re-render it, not the developer); its bar is portalled below the image
  (`bar`), Apply, Enter and Esc close the path and leave the tool, and while the tool is on
  Ctrl/⌘+Z undoes its nodes (none left: it leaves the tool), not the history. The
  compared image gets a read-only copy (`readOnly`, in an `inert` element). In a
  browser: `npm run test:shapes -w @rawtisserie/web`.
- Phones (roadmap 10.1): below `md` (`useNarrow`, `lib/useNarrow.ts`) the library and the
  trash put their side panels in `PanelDrawer`s, a tap opens the loupe and a long press
  selects (`longPress.ts`; closing the loupe doesn't select there). The loupe's
  `details` (the info panel) sit below the photo there, which stays selected while shown. Layout-only changes
  go in responsive style props; touch targets are `{ base: 'sm', md: '2xs' }`. A new
  side panel or toolbar must work at 390 px: `test:library` has a phone case.
- `/ui` (`pages/UiPage.tsx`) shows the UI's building blocks on one page, with static data
  and a dark/light toggle: add new shared components and patterns there. Fonts are tokens (`theme.ts`): `heading`, `body`, `label` (small uppercase
  labels) and `numeric` (values that change as you edit, with `tabular-nums`). `npm run test:ui -w @rawtisserie/web` renders it in every mode
  (`UI_SHOTS=dir` saves screenshots).
- Golden-image tests (`crates/pipeline/tests/golden.rs`) need `./scripts/fetch-golden-raws.sh`
  once. A change that moves the output fails them; if it's intended, re-bless with
  `GOLDEN_UPDATE=1 cargo test --release -p rawtisserie-pipeline --test golden` and say
  why in the commit. Pipeline refactors and optimisations must keep them passing as is.
- `ops/filmic.rs` is a port of Ansel's `filmicrgb.c` (GPL-3.0-or-later). When changing
  it, compare against upstream rather than reasoning from scratch, and check the 3D
  LUT accuracy with `cargo run --release --example filmic_lut_error -- photo.ARW`.
- `ops/primaries.rs`, `ops/equalizer.rs`, `ops/calibration.rs`, `ops/retouch.rs`,
  `ops/tone_curve.rs`, `ops/color_balance.rs` and `ops/diffuse.rs` follow Ansel's
  `colorprimaries.c`, `atrous.c`, `channelmixerrgb.c`, `retouch.c`/`pixel/heal.c`,
  `rgbcurve.c`, `colorbalancergb.c` + `splittoningrgb.c` and `diffuse.c` (same license;
  deviations are listed in the module docs). Diffuse's band pass is per channel plane, in
  short loops over 64-pixel chunks, one per operator (none at speed 0): keep it that way,
  it's most of the module's cost, and a saturating `f32 as i32` there stops it vectorising
  (hence `to_int_unchecked` in its `fast_exp`, which upstream's results don't depend on).
  Its built-in presets are Ansel's (`DIFFUSE_PRESETS`); darktable's use another edge
  energy, so their edge settings don't carry over. Colour balance's range weights are mirrored in TS (`toneRangeWeights`,
  for the settings graph), and its range mixers reuse calibration's mixer views
  (`MixerTarget` in `ModulePanel`). Its per-pixel grading is split into short branch-free
  loops over 64-pixel chunks so they vectorise: keep it that way. The tone curve and the contrast equalizer draw with `curveAt` (`develop/curve.ts`), which mirrors `equalizer::curve`. Upstream sources:
  github.com/aurelienpierreeng/ansel, `src/iop/` and `src/pixel/colorequal_shared.c`.
- `rcd.rs` is Ansel's RCD demosaic (`src/iop/demosaic/rcd.c`, same license), for Bayer
  sensors at full resolution (`demosaic.rs`; downscaled bases are binned), and
  `markesteijn.rs` its Markesteijn 1-pass (`markesteijn.c`) for X-Trans. Both keep
  upstream's index arithmetic: compare with it line by line. An RCD pixel depends on the
  photosites within `rcd::BORDER`, so regions read their patch with that margin; tiles
  start on even photosites. Markesteijn's tiles are fixed on the sensor as upstream's: a
  region runs the tiles holding it, from `markesteijn::patch_bounds`.
- Images that aren't RAW files (JPEG, PNG, TIFF, WebP; `bitmap.rs`, roadmap 8.11) are a
  `RawPhoto` too, read as a plain RGB/grey layout and linearised by tables from their ICC
  profile. Their metadata has `imageFormat`. They start with an empty recipe and their
  original is empty (`originalRecipe`, not `originalEditParams`: pass the photo's to
  anything that compares or resets modules), and they have no filmic or lens correction
  (`RAW_ONLY_KINDS`; whatever applies a recipe fragment to a photo goes through
  `forPhoto`). Accepted extensions: the server's `IMAGE_EXTENSIONS` ↔ web `IMAGE_ACCEPT`.
  `bitmap::detect` tells a TIFF image from a TIFF-based RAW file; `tests/bitmap.rs`
  checks the golden RAWs aren't taken for images.
- Raw denoise (`rawDenoise`, roadmap 3.5): `nn.rs` runs ansel-denoise's networks (a port
  of Ansel's `nn_model.c`, checked against PyTorch by `tests/nn_parity.rs`; its 3×3
  kernel keeps upstream's accumulation order: keep it that way), `denoise.rs` the
  module (σ map from `data/noiseprofiles.bin`, built by `scripts/noise-profiles.mjs`
  with `data/noise-profile-aliases.json`: the database names cameras as rawspeed does,
  not as rawler does, so run the script again after updating rawler). Tiles are on a fixed grid
  (`denoise::TILE`), whatever the machine: don't make it depend on memory or cores, or
  photos denoise differently. The developer denoises beside renders
  (`pipeline/denoising.rs`: `next_denoise_tile` → `denoise::run_tile` anywhere →
  `provide_denoise_tile`), and swaps the denoised photo in once every tile is there;
  every public entry point that reads samples calls `sync_source` first. In the
  browser, tiles run on `denoisePool.ts`'s workers, and the page keeps the denoised
  photo (`RawPhoto::to_denoised_file`) in place of the original (`keepDenoised`), named
  by `denoiseKeyName` ↔ `DenoiseKey::name`. Models are pinned by hash in
  `scripts/fetch-denoise-models.sh` (sizes in `DENOISE_MODEL_BYTES`): never change the
  file behind an id; a retrained model is a new version (`LATEST_DENOISE_VERSION`).
- Lensfun (roadmap 3.6): the lens instance's `lensfun` is one shot's profile (mirrored:
  `params::LensfunProfile` ↔ `LensfunProfile`), evaluated by `LensProfile::from_lensfun`
  into the embedded data's tables; with it, the file's embedded data isn't used. The
  database (`packages/pipeline/lensfun/lensfun.json`, from `scripts/lensfun-db.mjs`,
  CC BY-SA 3.0) is read in TS only (`lensfun.ts`, a port of lensfun's search and
  interpolation): pass it to `defaultRecipe` (server: `lensfun()` from `node.ts`; app:
  `develop/lensfun.ts`, loaded only when `mayUseLensfun`). Presets, styles and
  copy/paste carry the strengths, never a profile (`presetParams`, `styleInstance`).
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
- Multiple exposure (`ops/multiple_exposure.rs`, the `multipleExposure` kind) blends another
  photo into the base, as it comes off the sensor (scaled to cover, centred). It refers to it
  by its original's SHA-256 (`PhotoRef`, `photos.sha256`), so it survives transfers and
  re-imports. Renderers get the photos separately, like LUTs (`ExposureStore`:
  `Developer::exposures_mut`, wasm `loadExposure`; `exposurePhotos` lists them); one that
  isn't loaded is skipped. The blend is part of the base's key (`Layer::key`, in
  `GeometryKey::layer` and the patch). Every renderer must load them: the developer
  (`RenderBackend.setExposureSource`, `/api/originals/:sha256`), the library export and
  previews, and the server's render and zoom workers (`RenderSource.exposures`).
  The photo is chosen with `PhotoPicker` (roadmap 4.16), the library's grid and filters
  over its own state (`useStateSearch`): anything new that chooses a photo uses it.
- Edit params are versioned (`CURRENT_VERSION` / `EDIT_PARAMS_VERSION`, currently 8).
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
