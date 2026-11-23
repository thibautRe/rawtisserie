# 🍗 RAWtisserie roadmap

Written 2026-10-27, reorganised 2026-11-21. Items keep their numbers. Done ones are listed
under their milestone, with what's left of them, and their "as built" notes, which record
the decisions behind them, are in the [archive](ROADMAP-ARCHIVE.md) (since 2026-11-23); the
day-by-day log that used to open this file is in git history.

Most features (history, duplicates, autosave, presets, masks, multiple instances of a
module) depended on one thing: edits had to stop being one fixed struct and become **a
list of module instances with a history**. So the plan started with that foundation (M1),
then built on it in milestones that each ship something usable.

```
M1 Foundations ──┬─▶ M2 Workflow ........... done, but 2.6 keyboard-driven editing (1.0)
                 ├─▶ M3 Image quality ...... done, but 3.10 more embedded lens data
                 ├─▶ M4 Creative control ... done, but 4.2's auto-apply rules
                 ├─▶ M5 Compare ............ developer done; the library later
                 └─▶ M8 Library workflow ... done, but 8.9 focus areas, 8.15 phase 2
M6 Cloud processing ── independent; step 1 (native renderer) useful on its own
M7 Hosted service ──── 7.1, 7.3, 7.5, 7.11 done; the rest before opening sign-ups
M9 Branding ────────── 1.0; fonts and /ui done, logo, spinner, /develop page to do
M10 Responsive ─────── library on phones done; the developer after M6
```

Sizes: S ≈ a day or two, M ≈ a week, L ≈ 2–3 weeks, XL ≈ a month or more.

## 1.0 release scope

Left for 1.0, in this order:

1. ~~M5 compare~~: the developer's done (2026-11-21); the library's isn't needed for 1.0.
2. **[2.6 keyboard-driven, stepped editing](#26-keyboard-driven-stepped-editing-ml-before-10-needs-a-prototype)**:
   needs a prototype before it's planned.
3. ~~4.16 a photo picker for multiple exposure~~: done (2026-11-22).
4. **[M9 branding](#m9--branding-m-before-10--started)**: logo, spinner, the `/develop`
   landing page, a theme check. Can go in any time before launch.

Done for 1.0: raw denoise (3.5), lensfun (3.6), diffuse and sharpen (3.7), perspective
(3.8), tone curve and tone equalizer (4.6, 4.10), colour balance RGB (4.7), 3D LUTs
(4.8), frame (4.9), the mask UI (4.13, called done 2026-11-21), the library workflow
(8.1–8.5, 8.11), the library on phones (10.1).

Not decided for 1.0: M6 cloud processing, the rest of M7 (7.1, needed for a hosted
launch, is done), 4.2's auto-apply rules.

## After 1.0

1. M6 cloud processing. Step 1 (the native renderer) is useful on its own: server-side
   exports, faster denoise. Move it earlier if slow-hardware users become a priority.
2. M7 before opening sign-ups: 7.4 lazy re-renders and 7.6 purge rejected, then 7.9
   plans and billing. 7.2 and 7.7 once storage and database costs are worth the
   complexity; 7.8 can start any time; 7.10 only at a few hundred TB.
3. Smaller open items, any time: 3.10, 4.2's auto-apply rules, 8.9, 8.15 phase 2, the
   "Not done" and "Later" notes beside done items, [Performance](#performance) and
   [Cross-cutting](#cross-cutting) (rawler from a release, Rust tooling, the slider perf
   budget, render queue fairness).

---

## M1 — Foundations

Done (details in the [archive](ROADMAP-ARCHIVE.md)):

- [1.1 Recipe v3: a list of module instances](ROADMAP-ARCHIVE.md#11-recipe-v3-a-list-of-module-instances-l--done)
- [1.2 Library data model: photos, versions, history](ROADMAP-ARCHIVE.md#12-library-data-model-photos-versions-history-m--done)

---

## M2 — Workflow

Done (details in the [archive](ROADMAP-ARCHIVE.md)):

- [2.1 Autosave, no Save button](ROADMAP-ARCHIVE.md#21-autosave-no-save-button-s--done)
- [2.2 History stack](ROADMAP-ARCHIVE.md#22-history-stack-m--done)
- [2.3 Duplicates](ROADMAP-ARCHIVE.md#23-duplicates-sm--done)
- [2.4 Over/under-exposure indicators](ROADMAP-ARCHIVE.md#24-overunder-exposure-indicators-sm--done)
- [2.5 Slider feel](ROADMAP-ARCHIVE.md#25-slider-feel-m--done)
- [2.7 Colour picker, always on](ROADMAP-ARCHIVE.md#27-colour-picker-always-on-ml--done).
  Not done: pins kept across sessions, a readout next to the pointer.

### 2.6 Keyboard-driven, stepped editing (M–L, before 1.0, needs a prototype)

> **Prototype** 2026-11-22: a spotlight (`develop/Spotlight.tsx`, matching in
> `spotlight.ts`, `npm run test:spotlight`). Ctrl+Space, then letters that abbreviate a
> module, a tab or a control as prefixes of their words in order, any word skipped
> ("filcon": Filmic › Contrast, "cbm": Color balance › Mixer, "temp": calibration's
> Temperature). The right panel shows only that module on those tabs (`ModulePanel`'s
> `only`) with the match outlined; Enter brings the whole panel back with the module
> where it was on screen (empty space above or below where needed, gone once scrolled
> out of sight: `useSpotlightPanel`) and focuses the match, so the keyboard works on it.
> Sliders, tabs and folds are known up front (`develop/panelCatalog.ts`, which also
> holds the labels the panel uses for them; `test:spotlight` focuses every slider listed,
> so the list can't drift from the panel); buttons and selects are read from the page as
> the panel has shown them. A first version drove the slider with the mouse, pointer locked:
> dropped, trapping the pointer felt wrong. To try, before deciding what 2.6 is.

**Required for 1.0** (decided 2026-11-21). Needs brainstorming and prototyping before
it's planned. The idea is a primarily
keyboard-driven flow that walks through an opinionated order of steps, one control at a
time, e.g.:

1. exposure,
2. filmic white/black relative exposures,
3. contrast (then toe/shoulder),
4. colour (white balance, saturation/vibrance, later primaries).

Open questions: how a step is shown (focus one slider, dim the rest, show a hint of
what to look at, e.g. turn on clipping indicators for the exposure steps), which keys
change the value, step forward/back and skip, and whether the sequence is fixed or a
preset. It builds on 2.5 (every slider usable from the keyboard) and fits the history
(2.2): one entry per step. It must fit the panels as they are now (modules as blocks,
the mask as a fold at the end of each: 4.13).

---

## M3 — Image quality modules

These ports read the Ansel sources directly (GPL-3.0, see Licensing). They need **golden-image
tests** first: small reference renders of a handful of RAWs, compared within a tolerance.

Done (details in the [archive](ROADMAP-ARCHIVE.md)):

- [3.1 Lens correction, auto-applied to new images](ROADMAP-ARCHIVE.md#31-lens-correction-auto-applied-to-new-images-l--done)
- [3.2 Colour primaries](ROADMAP-ARCHIVE.md#32-colour-primaries-ml--done)
- [3.3 Contrast equalizer](ROADMAP-ARCHIVE.md#33-contrast-equalizer-l--done)
- [3.4 Colour calibration](ROADMAP-ARCHIVE.md#34-colour-calibration-m--done)
- [3.5 Raw denoise (AI)](ROADMAP-ARCHIVE.md#35-raw-denoise-ai-xl--done)
- [3.6 Lens correction via lensfun](ROADMAP-ARCHIVE.md#36-lens-correction-via-lensfun-l--done)
- [3.7 Diffuse and sharpen](ROADMAP-ARCHIVE.md#37-diffuse-and-sharpen-l--done)
- [3.8 Perspective correction and vertical alignment](ROADMAP-ARCHIVE.md#38-perspective-correction-and-vertical-alignment-l--done)
- [3.9 Better demosaicing at full resolution](ROADMAP-ARCHIVE.md#39-better-demosaicing-at-full-resolution-ml--done)

### 3.10 More embedded lens data (M)

What 3.1 and 3.6 left: DNG opcodes (`WarpRectilinear`, `FixVignetteRadial`), then
Fujifilm, Olympus/OM and Panasonic embedded data (darktable's `lens.cc` reads them).
Each is another `LensSource` filling the same knot tables. Also worth having: the
focus distance from makers' notes, for lensfun's vignetting.

---

## M4 — Creative control

Done (details in the [archive](ROADMAP-ARCHIVE.md)):

- [4.1 Multiple instances of a module](ROADMAP-ARCHIVE.md#41-multiple-instances-of-a-module-sm--done)
- [4.3 Shapes: one format for masks and retouch](ROADMAP-ARCHIVE.md#43-shapes-one-format-for-masks-and-retouch-m--done)
- [4.4 Retouch: spot removal](ROADMAP-ARCHIVE.md#44-retouch-spot-removal-l--done).
  Not done yet: wavelet scales, automatic source search (a new spot's source goes beside
  it), the "visualise spots" view, and copying spots to other photos.
- [4.5 Masks](ROADMAP-ARCHIVE.md#45-masks-xl--done).
  Not done yet: picking a range from the image (eyedropper), raster masks (painted
  bitmaps, AI segmentation), and mask presets on their own.
- [4.6 Tone curve](ROADMAP-ARCHIVE.md#46-tone-curve-m--done).
  Not done: a histogram before the instance has been created (the wand creates it),
  picking a node from the image, and a local (edge-preserving) variant like the tone
  equalizer's (see 4.10).
- [4.7 Colour balance RGB](ROADMAP-ARCHIVE.md#47-colour-balance-rgb-l--done)
- [4.8 3D LUT](ROADMAP-ARCHIVE.md#48-3d-lut-m--done).
  Later: log-input `.cube` files (S-Log3, LogC…).
- [4.9 Frame](ROADMAP-ARCHIVE.md#49-frame-sm--done).
  Not done: picking the colour from the image, and per-photo frames (styles can't carry
  it). A "show frame" view while developing could come with editor layout options, next
  to the Ctrl/⌘+B assessment mode, if it turns out to be wanted.
- [4.10 Tone equalizer](ROADMAP-ARCHIVE.md#410-tone-equalizer-l--done).
  Not done: Ansel's quantization, iterations, averaged (geometric mean) filters and mask
  contrast compensation (the node range and the wand do its job); picking a node from
  the image.
- [4.11 Blend modes](ROADMAP-ARCHIVE.md#411-blend-modes-m--done).
  Not done: a swap of input and output (Ansel's "reverse"), hue/colour modes keeping
  lightness, and linear/vivid/pin light.
- [4.12 Glow: bloom and halation](ROADMAP-ARCHIVE.md#412-glow-bloom-and-halation-m--done).
  Later: other kernel shapes (starbursts), energy conservation (take the light that glows
  away from its source).
- [4.13 Mask UI redesign](ROADMAP-ARCHIVE.md#413-mask-ui-redesign-ml--done).
  Not done: which controls are shown by default and which behind an "advanced"
  disclosure (drawn shapes and a luminance range cover most uses), how the overlay modes
  (one range alone, what a range measures) are reached, and mask presets.
- [4.14 Multiple exposure](ROADMAP-ARCHIVE.md#414-multiple-exposure-m--done).
  Later, if wanted: more than two photos (more instances, or a list), alignment (offset,
  scale, rotation), the other photo's own white balance or recipe, raw denoise on it too
  (today only this photo is denoised), and re-rendering the photos that blend one in
  when it's deleted for good or comes back.
- [4.15 Raster masks: another module's mask as a shape](ROADMAP-ARCHIVE.md#415-raster-masks-another-modules-mask-as-a-shape-m--done).
  Later, if wanted: bitmap masks (painted, or AI segmentation).
- [4.16 A photo picker for multiple exposure](ROADMAP-ARCHIVE.md#416-a-photo-picker-for-multiple-exposure-sm--done)

### 4.2 Presets (M) — partly done

> **Partly done: module presets and styles** (`packages/pipeline/src/presets.ts`,
> `develop/presets.tsx`, `/api/presets`, migration `00005`). As built: presets and styles
> are applied on the client and give a plain recipe, so the pipeline never sees them. A
> module preset can hold part of a module: kinds with distinct parts declare
> `PRESET_GROUPS` (colour calibration: CAT / mixer / output; filmic: white and black
> exposure / look / display; primaries: colour edits / range and smoothing), the save dialog picks
> some, and applying sets only those, whole at the top level, so there's no merging inside
> a value. Kinds without groups are saved whole. No geometry presets (they belong to one
> image). Built-in presets live in code (`BUILTIN_PRESETS`); there are no built-in styles.
> Applying a preset switches the instance on; a preset or style is always its own history
> entry ("Filmic: preset High contrast", "Style: B&W"). Styles store full instances
> without ids. "Append" adds them as new instances, but single-instance kinds still
> replace theirs. Appending a style that has a first exposure or colour calibration adds
> its +0.7 EV push or white balance a second time. Saving under an existing
> name replaces that preset (unique per user, kind and module kind). No `position`
> column: lists are sorted by name. Payloads carry `version` and are normalised on read,
> so a future recipe migration must cover them too. Without an account, only built-in
> presets show and the styles menu is hidden.

- **Module presets:** named parameters for one module kind ("Filmic — high contrast").
  Built-in plus per-user.
- **Styles:** a chosen subset of module instances from a recipe. Applying one either
  replaces instances of those kinds or appends new instances (user's choice).
- **Auto-apply rules** by camera, lens, ISO or format. This reuses the
  `default_recipe` hook from 1.1, and auto lens correction can simply be a built-in
  rule.
- Table: `presets(id, owner_id, name, kind: module|style, module_kind, payload jsonb,
auto_apply jsonb, position)`.
- A style that includes masked instances or retouch spots carries the shapes they
  reference (see 4.3). So does a module preset (`ModulePresetPayload.shapes`): applying
  either imports the shapes, renaming ids the recipe already uses. For 4.5, a preset
  should optionally include the instance's `mask` ("Include mask" when saving, off by
  default): parametric ranges and gradients travel well, drawn paths and strokes rarely.

---

## M5 — Compare (M–L) — developer done

> **Developer done** 2026-11-21 (`develop/compare.ts`, `CompareMenu.tsx`, the compare
> panes in `DeveloperView.tsx`; `npm run test:compare -w @rawtisserie/web`). Decisions:
> the developer first, the library later; the edited image is compared with an entry of
> its history (entry 0, the original, included: no separate "before") or with another
> version of the photo. As built: **Compare** in the toolbar (or Y) turns it on, its menu
> picks the layout and the target, and each history entry has a compare button. Two
> layouts, remembered: **split** (the default; the compared image left of a draggable
> divider, double-click to centre) and **side by side** (half the viewport each). The
> compared recipe takes the edited one's lens correction and geometry (`compareRecipe`,
> `FRAMING_KINDS`), so both frame the photo alike, and follows its committed framing, not
> its look. The zoom moves both (`useZoom`'s `mirror`), zoomed-in regions included; the
> clipping indicators show on both. Hidden while cropping or placing guides. The same
> `Developer` renders both: compare renders are flagged (`compare` in the render request)
> so that the colour picker and raw denoise keep following the edited image. Holding `\`
> still shows the original in place. Turned off by the Compare button (orange while on),
> Y, Esc (before Esc leaves the developer), or the compared history entry's button
> again (2026-11-22). In the assessment mode the divider crosses the whole pane, the
> white frame and the grey around it included (`splitClip`).
>
> Not done: own cache slots for the compared recipe (it shares the edited image's by
> size, so its spatial stages are rebuilt once after the compared image renders);
> recipes with different raw denoise settings swap the denoised photo in and out on each
> alternation; the shape and pin overlays aren't drawn over the compared side.

- **Library (later):** select 2–4 versions → a compare view in a grid, with synchronised zoom and
  pan. The two-up culling of a burst that 8.3 and 8.9 point to. For different photos (a
  burst), the reference crop rectangle applied in normalised coordinates. Library
  comparisons use live renders at screen size: server previews today, the render service
  with M6.

---

## M6 — Cloud processing for slow hardware (XL)

1. **Native multithreaded renderer.** Build the same Rust crate natively with rayon
   (row-parallel loops behind a `parallel` feature; wasm stays single-threaded for
   now). Expose it as a small Rust render service (axum) or a N-API addon. This alone
   speeds up server thumbnails and exports several times.
2. **Interactive sessions.** The client opens a WebSocket per open version. The service
   decodes the original once and holds the `Developer` with all its caches. The client
   streams recipes (latest-wins, drafts while dragging); the server streams back
   viewport-sized frames as WebP or JPEG.
   - Target: under 100 ms per interaction (render 20–60 ms native multithreaded,
     encode ~5–10 ms, plus network).
   - Sessions are sticky to one worker (it holds the decoded image), use about
     0.5–1.5 GB each for 40–60 MP, and are evicted after a few idle minutes.
3. **Same UI.** A `RenderBackend` interface with two implementations: the local wasm
   worker (`LocalRenderBackend`) and remote. `DeveloperView` doesn't know which is
   in use.
4. **Choosing a backend.** Time the first render on the device; if it's slow, suggest
   cloud processing. Also a per-user setting: auto / local / cloud.
5. **Scope.** Library photos only, since their originals are already on the server. In
   the public developer, cloud processing would mean uploading the file, so it is off
   there unless the user explicitly opts in. Photos with local originals (7.8) upload
   the original into the session only; it is deleted when the session is evicted.
6. **Operations.** Concurrency limits, per-user quotas, a memory budget per worker, and
   metrics (render time, queue time, frame size).
   - Meter session time per user (open, active, evicted), so a paid add-on can have a
     fair-use allowance in hours and the quotas have something to count.
   - Capacity is set by peak concurrent sessions (evenings, weekends), not by total
     hours: memory per session decides how many fit on a worker. Record peak
     concurrency against the number of users allowed to use cloud processing.
   - Originals are read over the storage provider's internal network (free at OVH),
     so render workers should run in the same region as the object storage (7.1).

Prerequisite worth doing early: introduce `RenderBackend` while the developer is still
small, even with only the local implementation.

> **Done** (`develop/renderBackend.ts`). As built: the interface covers `render`,
> `exportJpeg`, `autoTuneFilmic` and `dispose`. Loading stays on `LocalRenderBackend`
> (`load(bytes)`), since a remote backend would open a session by version id instead.

---

## M7 — Hosted service: storage, quotas, history size (L–XL overall)

What a hosted, multi-user instance needs to keep its per-user costs low and predictable.
Originals dominate storage (25–120 MB each; previews add ~0.7 MB per version), and
database storage costs far more per GB than object storage, so the history matters too.
Target hosting is OVH (object storage and managed Postgres), but everything goes through
the S3 API so the provider stays a configuration choice.

Done (details in the [archive](ROADMAP-ARCHIVE.md)):

- [7.1 Object storage backend](ROADMAP-ARCHIVE.md#71-object-storage-backend-m--done)
- [7.3 Backups and soft delete](ROADMAP-ARCHIVE.md#73-backups-and-soft-delete-sm--done)
- [7.5 Quotas and usage](ROADMAP-ARCHIVE.md#75-quotas-and-usage-m--done).
  Not done: the photo-count limit (7.8) and removing inactive free libraries.
- [7.11 AVIF renders](ROADMAP-ARCHIVE.md#711-avif-renders-sm--done).
  Not done: converting old renders in bulk (re-render them if storage matters).

### 7.2 Storage tiers for originals (M, after 7.1)

Most originals are opened in the weeks after import, then rarely. Keep new imports in
the standard class and move originals that haven't been opened for N days (60–90) to a
cheaper class (OVH Infrequent Access, or Active Archive if its reads are immediate).

- Add `photos.last_opened_at`, updated when the developer loads the original, on export,
  and on server renders.
- The cheaper classes bill a minimum duration (30–90 days) and every GB read. Don't
  move recent imports (rejects get deleted early), and avoid bulk reads (7.4, exports
  of a whole library).
- App-driven moves (copy, verify, delete) work everywhere; use the provider's lifecycle
  rules instead if they support transitions.

### 7.4 Lazy re-renders (S–M)

Breaking look changes set `render_status = 'pending'` on every version (migrations
`00002`, `00004`), so the server reads every original again. With 7.2 that becomes a
bill for each migration and a slow queue.

- Re-render recently opened versions right away; mark the others stale and re-render
  them when they're shown in the grid or opened (a priority queue: visible first).
- Update the note in `CLAUDE.md` about migrations when this lands.

### 7.6 Purge rejected photos (S)

Many photographers keep everything, rejects included.

- A "Delete rejected" action in the library (reusing `DeleteVersionsDialog`): deletes
  rejected versions, and their photos once no version is left.
- Opt-in automatic deletion of versions rejected more than 30 days ago, with a reminder
  before it runs. Goes through the trash (7.3).

### 7.7 History size (M)

Every `history_entries` row holds a full recipe (a few KB), and autosave adds many per
edited version. Measure first: track history size per user.

1. **Diffs.** Store each entry as a diff from the previous one, with a full snapshot
   every N entries. The API is unchanged: the server rebuilds full recipes on read, and
   `splice`/`goto` ops keep working.
2. **Cold history in object storage.** The history of versions not opened for months
   moves to object storage as gzipped JSON, keeping only the current recipe in the
   database. It's loaded back when the version is opened.
3. **Automatic compression.** Run "Compress history" (2.2: one entry per instance that
   differs from the original) on versions untouched for N months. It drops
   entries the user didn't choose to drop, so it's a user setting and the default
   needs a decision. Lossless steps 1–2 come first.

### 7.8 Local originals (L)

A library whose originals stay on the user's disk or NAS: the server keeps previews,
recipes, history and metadata (~0.7 MB per photo instead of the whole RAW). The browser
already decodes and renders RAWs (`LocalRenderBackend`), and `photos.sha256`
identifies files.

- **Schema:** `photos.storage_key` becomes nullable, plus a `storage` column
  (`'cloud' | 'local'`, a SQL `CHECK`), `relative_path`, and a `library_roots` table
  (one row per folder the user picked).
- **Import in the browser:** pick a folder (`showDirectoryPicker()`; the handle is kept
  in IndexedDB, and Chrome can keep the permission across visits). On a small worker
  pool: read, hash, `load()` for metadata, render the thumbnail and preview with the
  default recipe, then upload metadata, hash, path and JPEGs to a new endpoint. The
  original never leaves the device. Resumable, and it skips known hashes.
- **Developer:** reads the file through the folder handle instead of `fetchBytes`. If
  it's missing or changed (size and date), a "locate" flow rescans the folder, matching
  by name and size, then hash.
- **Renders:** the server queue skips local photos. The browser renders and uploads
  the preview after edits, and re-renders stale previews (7.4) in the background when
  the folder is connected.
- **Export** runs in the browser (`exportJpeg`). Other devices see the whole library;
  editing needs the files ("original not on this device" badge).
- **Moving:** "Upload originals" for a selection turns local photos into cloud ones;
  making a cloud photo local only deletes the cloud copy after checking the local
  file's hash.
- **Browsers:** Firefox and Safari have no directory handles, so they re-pick the folder
  each session (`<input webkitdirectory>` or drag and drop).

### 7.9 Plans and billing (M, after 7.5)

Plans are enforced in the app: storage quota, whether originals are stored (7.8),
cloud processing entitlement and its fair-use hours (M6). Payment through Stripe or a
merchant of record (which handles EU VAT), annual billing as the default. Prices and
plans themselves are decided outside this repo.

### 7.10 Self-hosted object storage (XL, later)

At a few hundred TB, S3-compatible storage run on dedicated storage servers (MinIO,
Ceph or Garage) can cost several times less per TB than managed object storage, at the
price of operating it (disk replacement, monitoring, on-call). Only once 7.1 makes the
backend a configuration choice and the volume justifies it.

---

## M8 — Library workflow

Done (details in the [archive](ROADMAP-ARCHIVE.md)):

- [8.1 Apply a preset or style to a selection](ROADMAP-ARCHIVE.md#81-apply-a-preset-or-style-to-a-selection-sm--done)
- [8.2 Folder, recursive and SD card import, skipping known files](ROADMAP-ARCHIVE.md#82-folder-recursive-and-sd-card-import-skipping-known-files-m--done).
  Not done: remembering cards (the review's counts do that job), auto-import on card
  insertion (needs the desktop helper, see 7.8).
- [8.3 Fullscreen preview for culling](ROADMAP-ARCHIVE.md#83-fullscreen-preview-for-culling-m--done).
  Not done: two-up (M5), browser-side tiles for the public developer.
- [8.4 Export from the library: one photo or a selection](ROADMAP-ARCHIVE.md#84-export-from-the-library-one-photo-or-a-selection-ml--done).
  Not done: the grid has no context menu to add it to. Later: server-side jobs for
  cloud-compute users, after M6 step 1; AVIF/JPEG XL.
- [8.5 Export options](ROADMAP-ARCHIVE.md#85-export-options-m--done)
- [8.6 Copy and paste edits](ROADMAP-ARCHIVE.md#86-copy-and-paste-edits-sm--done)
- [8.7 Auto-tune when applying a preset or style](ROADMAP-ARCHIVE.md#87-auto-tune-when-applying-a-preset-or-style-m--done)
- [8.8 Append or apply per module in styles](ROADMAP-ARCHIVE.md#88-append-or-apply-per-module-in-styles-sm--done)
- [8.10 Sending to another instance](ROADMAP-ARCHIVE.md#810-sending-to-another-instance-m--done)
- [8.11 JPEG and other non-RAW images](ROADMAP-ARCHIVE.md#811-jpeg-and-other-non-raw-images-l--done).
  Later: grouping RAW + JPEG pairs.
- [8.12 Boolean tag filters and rating ranges](ROADMAP-ARCHIVE.md#812-boolean-tag-filters-and-rating-ranges-m--done)
- [8.13 Select everything the filters match](ROADMAP-ARCHIVE.md#813-select-everything-the-filters-match-m--done)
- [8.14 Collections](ROADMAP-ARCHIVE.md#814-collections-l--done).
  Not done: export folders named after collections (8.4's ZIP), drag and drop in the
  tree, splitting a collection at a photo (select from it and move them into a new one
  instead), and a photo's collection in its card or the loupe.

### 8.9 Focus areas (M–L)

Show where a photo is in focus, to tell at a glance whether the focus landed where it
should (the eye, not the ear), and reuse that knowledge where a view has to pick a part
of the image.

- **What it is:** a property of the capture, not of the recipe: computed once per photo
  (on import, by the render worker that already has the RAW decoded) and stored with
  the photo (`photos`), like the EXIF. Two sources:
  - _Where the camera focused:_ the AF point or area from the maker notes, when there
    is one (Sony's `FocusLocation`, Canon's AF info, Fujifilm's focus pixel…).
  - _What is sharp:_ a sharpness map measured on the demosaiced base (local high-frequency
    energy of the luminance, e.g. the contrast equalizer's finest bands, normalised by
    local contrast so flat sharp areas don't read as blurry). Stored coarse (a grid of a
    few dozen cells per side), plus the sharpest region's box.
- **Culling (most important):** in the loupe, a toggle (key to pick) overlaying the
  sharp areas (focus-peaking style: tinted edges or a heat map) and the AF point; zoom
  to 100 % on the focus area rather than the centre or the pointer.
- **Grid:** possibly a small indicator, and later filtering or sorting by sharpness
  (find the missed shots of a burst; pairs with M5's two-up compare).
- **Developer:** the same overlay among the status bar's view toggles.
- **Reuse:**
  - _Preset and style previews:_ spatial modules (diffuse or sharpen, contrast
    equalizer, denoise, glow) barely change the fitted image. Their previews would show
    a 100 % crop of the focus area instead, where the difference is visible and
    matters.
  - Default zoom target in the developer and the loupe.
  - Later: a crop or framing hint, and a sharpness check before export.
- **Open questions:** the sharpness measure (cheap, and robust to noise at high ISO and
  to motion blur vs. defocus), whether the maker-notes AF point is worth it beyond Sony
  first, and the overlay's look.

### 8.15 Import darktable and Ansel edits (L) — partly done

> **Phase 1 done** 2026-11-19 (`packages/pipeline/src/importedEdits.ts`, `darktable/`;
> migrations 00028–00029; web `fileTags.ts`, `ImportReview.tsx`, `develop/ImportNotice.tsx`).
> The import review reads the edits in a photo's sidecar (`NAME.ARW.xmp`, xmp_version
> 2+) and darktable's duplicates (`NAME_01.ARW.xmp`…, more versions); a checkbox imports
> them. The sidecar's text is kept with the version (`versions.imported_edits`, travels
> with transfers) and the render worker (or the developer, opened first) makes the
> history entry "Imported from darktable/Ansel" after the starting one
> (`startingHistory`). The developer warns while that entry is current, with a report of
> each module (came through, approximated, waiting for a file, left out, done our own
> way). Parameters are C structs (`darktable/struct.ts`, layouts from darktable 5.6.2 and
> Ansel's master); which application wrote a history is told by the modules and
> versions only one has.
>
> Translated: exposure; colour calibration and white balance (their D50-relative
> illuminants adapted to our D65; a white balance other than the camera reference
> folded in, from the camera's multipliers and matrix now in the metadata); filmic rgb
> (parameter for parameter); sigmoid and AgX (their curve fitted onto filmic, within
> 0.1–1 % on the user's files, with an exposure where it moves middle grey); colour
> balance rgb (master tab; 4 ways as split-toning mixers; contrast as a tone curve);
> lens correction (our choice of data, their strengths); orientation, rotate and
> perspective, and crop (fitted: their chain against ours, crop proportions kept);
> LUT 3D (by name and path until the user adds a LUT of that name); Ansel's colour
> primaries and split-toning rgb. Uniform opacity becomes the mask's; a masked
> instance comes switched off. Against darktable's/Ansel's own renders of 13 of the
> user's photos (`darktable-cli`, `ansel-cli`): mean ΔE2000 1.2–6.4 for 10, 8–10 for
> the rest; ~60 ms per import.

> **Phase 2 in progress** 2026-11-20: tone equalizer (our Tones preserving detail, nodes
> where their mask spans −8 … 0 EV), diffuse or sharpen (parameter for parameter),
> darktable's rgb primaries (its 3×3 matrix as a colour calibration mix), and masks:
> parametric ranges (grey, R/G/B, and Jz/Cz/hz through sampled JzAzBz ↔ u′v′ tables),
> drawn circles, ellipses, gradients and paths from `masks_history` with their group's
> operations, feathering, blend modes with their fulcrum; contrast equalizer (its curves
> at our nodes); retouch (spots from its forms: clone, heal, blur, fill, with brush
> strokes). On 19 of the user's photos the mean ΔE2000 against darktable's/Ansel's
> renders is 5.4 (5.74 before masks); on ~100 sidecars, 768 module entries come
> through (553 after phase 1) and 183 are left out (396); imports take ≤ 0.1 s.

Best effort, never the same pixels: our pipeline differs (demosaic, highlight
reconstruction, profiles). darktable's colour equalizer comes through as our colour
primaries (its curves read at our six control colours). Raster masks come through as
4.15's raster shapes (2026-11-20). Still to do, by use in the
user's files: brushes in masks; denoise as raw denoise; Ansel's colour
equalizer (rings of curves, another module). rgb curve comes through as Tones (each
curve's gain in EV at our nodes, linked through its norm or per channel). Later: Lightroom (`crs:` XMP) and Capture One
(`.cos`) through the same report and warning.

---

## M9 — Branding (M, before 1.0) — started

- **Logo:** a mark and wordmark for the 🍗 name. Favicon, app icons and an OpenGraph
  image.
- **Typography:** in the app since 2026-11-10, still being tried: **Geologica** (since
  2026-11-11) for headings, body and small uppercase labels (the `label` font token),
  **Lilex** for values that change as you edit (the `numeric` token: slider readouts,
  history numbers, mask ranges, the developer's camera/exposure line). Both Google
  Fonts (OFL), self-hosted with Fontsource. Inter is gone (no longer a fallback or on
  `/ui`). Tried before: Big Shoulders + Chivo Mono (Big Shoulders doesn't read at the
  panels' small sizes), Anybody + Lilex (Lilex for all text is wide: labels wrapped, the
  flag filter overflowed), Barlow Semi Condensed + Lilex (too narrow: rows of similar
  sliders, as in colour balance, were hard to tell apart), Asta Sans (Korean-first: its
  ellipsis is centred, even CSS truncation's). Geologica was picked from a sheet of a dozen
  (Golos Text, Schibsted Grotesk and Atkinson Hyperlegible Next were the runners-up).
- **Spinner:** a branded loading indicator instead of the default one. Reuse it for
  long loads (RAW decode, first render) with a progress hint.
- **`/develop` page:** the public developer is the front door. Give it a proper landing
  state (drop zone, short pitch, sample RAWs to try, link to sign up) and polish its
  empty and loading states.
- Check light and dark themes (`_light` before `_dark` in semantic tokens).
- **Light theme for the app (after 1.0):** the app is dark only (`class="dark"` in
  `index.html`), though the semantic tokens have their light values (`/ui` shows both).
  Still to do: a setting (dark, light, the system's), the image's surroundings in the
  developer and the loupe (which should stay dark or neutral grey for judging photos:
  the loupe's details are forced dark today), and a pass over every page.
- **Design system (M):** with the new fonts, settle the UI's vocabulary before it grows
  further, and make it visible:
  - A component gallery: a `/ui` route in the app, everything on one page (decided
    2026-11-10: no Storybook for now). Started 2026-11-10 (`pages/UiPage.tsx`): type
    scale, colours, buttons, the four view switchers, `ParamSlider`, the three section
    headers, fields, culling controls, with a dark/light toggle. Still to add: mixer views, curve editors, the film
    roll, the tag input with completion. `npm run test:ui` renders it in every mode and
    can save screenshots (`UI_SHOTS=dir`): a base for visual regression later.
  - Typography: the faces as tokens (see above), and a small set of text styles (today it's `2xs`,
    `xs`, `sm` ad hoc, headings as `Heading size="xs"` uppercase in some panels and
    sentence case in others). Tabular figures wherever numbers change during a drag.
  - One pattern per job. Switching between views is done four ways today: `Tabs`
    `line` (module pages, mask ranges), `Tabs` `subtle` (mixer views, colour balance
    ranges, tone channels), `SegmentGroup` (library filters, style modes) and attached
    `ButtonGroup`s (shape tools). Guidelines: tabs for pages of a panel, a segmented
    control for a choice of value, attached icon buttons for tools; then migrate.
  - Same for section headers (the filters' uppercase headings, the info panel's,
    `ModulePanel`'s), spacing in panels, and the collapsible pattern (the filters'
    "Technical", module sections).
  - Modules (2026-11-10): blocks on `bg.panel` over the panel's darker `bg`, with gaps,
    instead of separator lines (a bar on the side, coloured by state, was tried and
    dropped: too busy). Titles 12 px bold; the switch is always rightmost. The other
    panels (library sidebars, scopes and history) could follow the same surfaces.

---

## M10 — Responsive design

The app is unusable on a phone today: the library's sidebars, grid and loupe, and the
developer's panels, assume a wide window.

- **10.1 Library and settings (M–L, before 1.0) — done** 2026-11-16. Below `md` (768 px,
  `useNarrow`): the filters (with the sort) and the info panel open as drawers
  (`PanelDrawer`: from the side, and a sheet from the bottom), the grid has its own
  columns (2–6, 3 by default), a tap opens the loupe and a long press selects, after which
  taps add or remove and a selection bar (Details, Select all) replaces the status bar.
  The loupe swipes between photos and pinches with two fingers (`useZoom`, Android too;
  iOS's gesture events are ignored while fingers are down), with larger culling buttons.
  The trash works the same way; the settings and admin pages fit in one column (the admin
  tables scroll sideways in their card); tag shortcuts aren't shown on phones. Import
  goes through the phone's file picker (files only: folders and cards stay desktop).
  The developer isn't offered (10.2). `test:library` and `test:ui` have phone cases.
  2026-11-19 (NOTES.md): the loupe scrolls down to the photo's info panel (without its
  preview, rating, flag and label: the loupe has them), the photo shown selected
  meanwhile. Capture lines (loupe, developer, info panel) put the settings first: focal
  length, aperture, shutter speed, ISO, then the lens and the camera last (`captureLine`). Not done: pinching the grid to change its
  columns, swiping a sheet closed.
- **10.2 Developer (after M6):** phones can't develop full RAWs in wasm at an acceptable
  speed, so wait for cloud processing; then the panels as a bottom sheet over the image.

---

## Performance

> **Done** (2026-11-03): colour/tone drags render at full preview size on a pool of
> workers instead of a blurry draft. The primaries table updates incrementally, and
> frames reach the canvas as `ImageBitmap`s. Measurements, the pool-size trade-off and
> rejected ideas are in [PERFORMANCE.md](PERFORMANCE.md).

Ideas, roughly by value for effort:

- **P.1 Adaptive draft size (S).** Spatial drags (sharpen, equalizer curves, geometry)
  still use a fixed ~0.5 MP draft. Pick the size from the last render's time against a
  frame budget (~40–50 ms), so faster machines get sharper drafts.
- **P.2 wasm SIMD (S–M).** ✅ Built with `+simd128` (autovectorisation only): 8–18 %
  more image fps on drags, ~30 % off zoomed-in equalizer renders (docs/PERFORMANCE.md).
  Explicit SIMD in the equalizer's 5-tap passes is the next step there.
- **P.3 Adaptive pool size (S).** The pool is capped at 4 workers because more starve
  the main thread on an 8-core hyperthreaded laptop, and that cap fits one machine.
  Options: grow or shrink it from the measured frame rate or input latency, or let
  users choose.
- **P.4 Cheaper slider re-renders (M).** The ~30 % main-thread floor during any drag is
  React and Chakra re-rendering on each pointer move. Leaner primitives inside
  `ParamSlider`, or updating the dragged slider's DOM imperatively until release, would
  leave more room for the image (and the pool).
- **P.5 Real wasm threads (L).** Shared memory + rayon in the browser. That would drop
  the strip copies and per-worker table builds, and parallelise the spatial stages,
  which the pool can't (each worker would need the whole base image). The same
  row-parallel code as M6 step 1. Costs: nightly Rust with `-Z build-std` (atomics), a
  browser-only threaded build next to the Node one, and COOP/COEP headers on every page
  that loads the developer.
  Since 2026-11-11 both headers are sent in report-only mode (`apps/server/src/isolation.ts`,
  and Vite's dev and preview servers), and violations are logged by `POST /api/reports`.
  Checked then in Chromium: the developer would load as it is. The only report was our own
  workers' "worker initialization", which report-only mode causes and the server skips.
- **P.6 Faster primaries `finish()` (S).** After the incremental update, the remaining
  ~9 ms is real work on ~100k nodes (sin/cos, cube projection, HLG decodes). A fast
  sincos would cut it but changes output slightly: it needs a golden re-bless and a
  reason in the commit.
- **P.7 GPU final stage (L).** Upload the cached spatial image as a texture and run the
  point operations in a shader: full size at display rate. But it's a third copy of the
  colour maths (Rust, TS, shader) to keep in parity. Only if P.2–P.5 aren't enough.

---

## Cross-cutting

- **Golden-image tests** (before M3): about five reference RAWs from different brands
  (raw.pixls.us is CC0), each with a recipe and a small expected PNG, compared with a
  ΔE tolerance. Port changes must explain any diff.

  > **Done** (`crates/pipeline/tests/golden.rs`). As built: six RAWs (Sony ARW, Canon
  > CR3, Nikon NEF, Fujifilm X-Trans RAF, Leica DNG, Panasonic RW2), pinned by sha256 in
  > `tests/golden/raws.txt` and fetched by `scripts/fetch-golden-raws.sh` (not
  > committed). Every RAW is rendered with every recipe in `tests/golden/recipes`:
  > `default`, `edited` (all modules, two exposure instances, rotate/flip/straighten/
  > crop) at 400 px, and `detail`, a 10 % crop at full size, which goes through the
  > full demosaic, blur and sharpen instead of binning. That makes 18 PNGs (2.8 MB).
  > Tolerance: CIEDE2000 mean ≤ 0.15 and 99.9th percentile ≤ 1. Today's renders are
  > bit-identical between runs and between debug and release builds, and +0.02 EV on
  > one recipe already gives a mean of about 0.5. New modules should add a recipe that
  > uses them (for 3.1, one with lens correction on).

- **Performance budget:** extend `bench.rs` per module and record numbers in PRs
  (findings so far: [PERFORMANCE.md](PERFORMANCE.md)).
  Point modules must not use transcendental functions per pixel; anything nontrivial
  gets baked into a lookup table.
- **Rust tooling:** install `rustfmt` and `clippy` (`rustup component add rustfmt clippy`),
  run `cargo fmt --all` and `cargo clippy --workspace --all-targets` once and fix what
  they find (the retouch and shapes code was formatted by hand and never linted), then
  add both to `npm test` or a pre-commit check so they stay clean.
- **Slider perf budget:** `npm run test:perf -w @rawtisserie/web` is over its 50 %
  main-thread budget on "primaries hue" (~52 %) and "equalizer mix" (~51–55 %), on the
  code from before retouch too. On 2026-11-18 more rows were over on the same machine,
  before 3.6 as after (measured against the previous commit's wasm): filmic contrast
  and straighten (~64 % busy), image rates for exposure (9–13 fps), glow (6 fps) and
  straighten (2 fps, ~530 ms a geometry render at 835 px). Find what the main thread does in those drags (likely
  their sections' restyling) or revisit the budget.
- **Limits against unintended use** (from NOTES.md, 2026-11-18).

  > **Done** (`apps/server/src/limits.ts`). As built: rate limits per user (per address
  > when signed out, `TRUST_PROXY` behind Caddy), in memory: 1200 API requests a minute,
  > 10 logins a minute, 10 sign-ups an hour, 30 invitation lookups a minute, 600 loupe
  > tiles a minute; renders and originals aren't limited (files, asked for by the
  > hundred). Counts per user: 1000 presets and styles, 200 saved filters, 100 export
  > presets, 500 LUTs and 2 GB of LUT tables (removed ones included: they stay stored,
  > outside the quota), 5000 saved tags, 50 access tokens, 50 connected instances, 100
  > versions of a photo, 20 uploads in progress, whose sizes now count against the
  > quota until they're completed.

  Still open, larger:
  - **Render queue fairness:** the queue is first in, first out across users
    (`render/queue.ts`), so one user importing 10 000 photos holds back everyone's
    renders for hours. Round-robin between users (or by oldest pending per user).
  - **History entries per version** are unbounded: 7.7 has to settle what happens at a
    cap (compress, or move old entries out) before there can be one.
  - **Limits per account:** today they're constants. With 7.9's plans, some (LUTs,
    instances) may belong to the plan, set like the storage quota on `/admin`.
  - **Several server processes** would need a shared store for the rate limits
    (`@fastify/rate-limit` takes Redis): only with M6's scaling.

- **rawler from a release** (from NOTES.md, 2026-11-18): our patch (`[patch.crates-io]`,
  the fork's tag `rawtisserie/rawler-0.8.0-wasm`) is merged upstream
  (dnglab/dnglab#960, `0bf0fd9`, 2026-11-13), but not released: the latest release is
  still 0.8.0. Upstream master is 307 commits past it and changes what decoding uses:
  colour matrices are now camera profiles (`best_color_matrix`, no `color_matrix`,
  `xyz_to_cam` or `neutralwb` on `RawImage`), the black level model (row and column
  deltas, `BlackLevel::as_vec` gone, masked areas measured by their median), white
  balance normalisation and makernote fields: `decode.rs` and `metadata.rs` need
  porting, and golden images will likely move. So the pin stays on our fork until a
  release has the fix. Then: take the release from crates.io, drop the patch, port
  `decode.rs`, compare the golden images (re-bless only what's explained), and run
  `scripts/noise-profiles.mjs` and `scripts/lensfun-db.mjs` again (camera names).
- **Ansel parity:** for each port, record the upstream commit it follows (as
  `filmic.rs` does) and keep a short "deviations" list.
- **Licensing:** filmic, colour primaries, the contrast equalizer and lens correction
  are or would be ports of GPL-3.0-or-later code, so RAWtisserie should be
  GPL-3.0-or-later (or AGPL-3.0 if network use should also share changes — relevant
  once cloud processing exists). The lensfun database is CC-BY-SA 3.0 and needs
  attribution.
