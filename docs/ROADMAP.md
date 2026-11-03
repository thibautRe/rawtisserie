# 🍗 RAWtisserie roadmap

Status: plan, written 2026-10-27. Done: 1.1 (recipe v3); 1.2 (versions and history);
2.1 (autosave); 2.2 (history stack); 2.3 (duplicates); 2.4 (clipping indicators); 2.5
(slider feel); the `RenderBackend` interface (M6 prerequisite); golden-image tests
(before M3); 3.1 with
Sony's embedded data (lensfun and other makers postponed); 3.2 (colour primaries);
3.3 (contrast equalizer); 3.4 (colour calibration); 4.1 (multiple instances); 4.2 module
presets and styles (auto-apply rules to do); full-size colour drags on a worker pool (see
Performance).

Most of the requested features (history, duplicates, autosave, presets, masks, multiple
instances of a module) depend on the same thing: edits must stop being one fixed struct
and become **a list of module instances with a history**. So the plan starts with that
foundation, then builds features on top in milestones that each ship something usable.

```
M1 Foundations ──┬─▶ M2 Workflow (autosave, history, duplicates, clipping indicators, sliders, guided editing)
                 ├─▶ M3 Image quality (lens correction, colour primaries, contrast equalizer)
                 ├─▶ M4 Creative control (module instances, presets, shapes, retouch, masks)
                 └─▶ M5 Compare
M6 Cloud processing ── independent; can start any time (native renderer first)
```

Sizes: S ≈ a day or two, M ≈ a week, L ≈ 2–3 weeks, XL ≈ a month or more.

---

## M1 — Foundations

### 1.1 Recipe v3: a list of module instances (L)

> **Done.** As built: `mask` and `opacity` are left out until M4 (adding them later is
> backward compatible). Spatial order stays blur → sharpen, as before. A missing kind
> means "off"; the default recipe is exposure + filmic. Unknown kinds are an error in
> Rust and dropped in TS. Types are still mirrored by hand, cross-checked by tests.
> `default_recipe(metadata)` came with 3.1 (`EditParams::default_for`).

Today `EditParams` is a struct with one section per module. v3 becomes:

```jsonc
{
  "version": 3,
  "modules": [
    {
      "id": "m1",
      "kind": "exposure",
      "label": null,
      "enabled": true,
      "params": { "ev": 0.7, "black": 0 },
      "mask": null,
      "opacity": 1,
    },
    {
      "id": "m2",
      "kind": "exposure",
      "label": "sky",
      "enabled": true,
      "params": { "ev": -0.5, "black": 0 },
      "mask": {/* M4 */},
      "opacity": 1,
    },
    { "id": "m3", "kind": "filmic", "enabled": true, "params": {/* … */} },
  ],
}
```

- **Pipeline order is fixed by module kind** (as in Ansel), and instances of the same
  kind keep their list order. Module kinds that require a single instance (demosaic,
  lens, geometry, filmic, output) say so.
- **Rust:** a `Module` trait (or enum) per kind declares its stage (`base`,
  `geometry`, `spatial`, `point`) and how to apply itself. Each stage's cache key is the
  hash of the instances in that stage, so today's caching carries over. Point modules
  still compile into the single fused pass.
- **Target order:**
  - base: demosaic → highlight clip → as-shot WB → vignetting (lens) → camera → working
  - retouch (4.4): spot removal in the sensor frame, its own cached stage
  - geometry: distortion + TCA (lens) → orientation → straighten → crop → resample
  - spatial: contrast equalizer → sharpen → blur
  - point: exposure → colour calibration/WB → colour primaries → saturation/vibrance →
    shadows/highlights → filmic → output → clipping overlay

  Spatial stages run before point stages. This is already the case and keeps
  exposure/colour sliders cheap. It requires spatial modules to be exposure-invariant
  (see 3.3).

- **Migration:** a pure `v2 → v3` function in Rust and TS (each section becomes one
  instance). It's cheap and deterministic, so worth doing even for test content.
- **Image-specific defaults:** add `default_recipe(metadata)` (Ansel's `reload_defaults`)
  as the single place that decides what a new image starts with: exposure bias
  compensation, filmic white/black, and auto-applied lens correction (3.1).
- **TS:** the `params.ts` mirror becomes `modules.ts` with per-kind param types and
  defaults generated from one schema. Consider `tsify`/`schemars` to stop maintaining
  two copies by hand.

### 1.2 Library data model: photos, versions, history (M)

> **Done** (migration `00003`). As built: migrated versions reuse their photo's id, so
> existing render files and links keep working; new uploads get distinct ids. The API is
> version-centric (`/api/versions…`); only uploads and originals stay under
> `/api/photos`. Saving already goes through `POST /api/versions/:id/history` with
> `baseRevision` (409 on mismatch) and truncates entries after `history_end`, which is
> ready for 2.1/2.2. History labels are still a generic "Edit" until 2.1 sends real
> ones. Deleting a version deletes its photo once no version is left.

Split "the file" from "an edit of the file", like darktable duplicates:

| Table                   | Holds                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `photos`                | original file, sha256, EXIF/metadata (unchanged)                                                                                     |
| `versions` (new)        | `photo_id`, `name`, `position`, rating, flag, colour label, title/description/tags, `history_end`, `revision`, render status/version |
| `history_entries` (new) | `version_id`, `seq`, `created_at`, `label` ("exposure +0.3 EV"), `recipe jsonb` (full snapshot)                                      |

- Full recipe snapshots per entry keep reads trivial (a few KB each); compress later if needed.
- **Decision:** ratings, flags and labels move to versions, so variants can be culled
  separately. EXIF stays on photos.
- The library grid lists versions; versions of the same photo show a stack badge.
- Renders are keyed by version.
- Migration: one version per existing photo, one history entry from `edit_params`.

---

## M2 — Workflow

### 2.1 Autosave, no Save button (S, after 1.2)

> **Done** (`develop/useAutosave.ts`). As built: coalescing is decided by the client,
> which sends `replace: true` (with `baseRevision`) to overwrite the entry it wrote
> last; the revision check guarantees nobody wrote since, so no "session" column was
> needed. The 30 s window counts from the entry's creation, and a replaced entry keeps
> its `created_at`. Labels come from a recipe diff (`develop/changes.ts`, e.g.
> "Exposure: ev 1.2"). Ctrl+S saves immediately. Since 2.2 coalescing happens in the
> client's history model and saves are batches of history ops (see 2.2).

- Each committed change (slider release, crop applied…) is sent, debounced ~750 ms,
  as `POST /api/versions/:id/history` with `{ recipe, label, baseRevision }`.
- **Coalescing:** if the previous entry is the same module instance, comes from the same
  session, and is less than 30 s old, replace it rather than append.
- **Conflicts:** `revision` gives optimistic concurrency. Another tab editing the same
  version gets a 409 → "This version changed elsewhere — reload".
- **Flush on leave:** `visibilitychange`/`pagehide` with `fetch(..., { keepalive: true })`.
- The header shows "Saving… / Saved". The `beforeunload` warning stays, but only while
  a save is pending or in flight.
- The public `/develop` page has no server, so it keeps undo/redo in memory.

### 2.2 History stack (M, after 1.2)

> **Done** (`develop/history.ts`, `develop/HistoryPanel.tsx`). As built: the client owns
> the history (`HistoryStore`: entries, `end`, coalescing) and mirrors each change on
> the server as ops, batched in one `POST /api/versions/:id/history` per save:
> `splice` (drop entries from `from` on, insert new ones) and `goto` (move
> `history_end`). The version detail includes every entry's recipe, so moving through
> history is instant. Dropping undone entries and compressing both offer an Undo toast
> until the next history change. Compressing keeps one entry per instance that differs
> from the original, in order of each one's last change. The public `/develop` page uses
> the same store in memory, and "Add to library" uploads its whole history.

- A left panel in the developer (as in Ansel): entries newest-first with module icon and
  change summary, plus a "0 — original" entry at the bottom.
- Clicking an entry moves `history_end` there and renders that state. Editing from an
  earlier point **truncates** later entries (Ansel/darktable semantics), with an undo
  toast. Linear, not branching: duplicates cover branching.
- **Compress history:** collapse to one entry per module instance.
- Undo/redo shortcuts move `history_end` instead of the local stack.

### 2.3 Duplicates (S–M, after 1.2)

> **Done.** As built: `POST /api/versions/:id/duplicate` (`fromOriginal` for an empty
> history) inserts the copy right after its source. The copy keeps the curation and the
> whole history, undone entries included. The copy is rendered again rather than
> copying files. Reordering is `POST /api/versions/:id/move { position }`, and renaming
> is the `versionName` patch field. Unnamed versions show as "Version N" (their
> position). The developer's switcher (`develop/VersionMenu.tsx`) waits for pending
> saves before duplicating, and keeps the decoded original when switching between
> versions of the same photo. Library: Ctrl+D / Ctrl+Shift+D duplicate the selection,
> and the delete dialog says which photos lose their last version (and their RAW file).

- Library and developer actions: **Duplicate** (copies the history) and **Duplicate
  from original** (starts from `default_recipe`).
- Rename, reorder and delete versions. Deleting the last version asks to delete the photo.
- Developer: a version switcher next to the file name.

### 2.4 Over/under-exposure indicators (S–M, independent)

> **Done.** As built: both are painted by `ops/clipping.rs` as a pass after the render
> (nothing runs when they're off), measured on the 8-bit output, so the defaults mean
> "rounds to 0 / 255". Over is red, under blue, sensor magenta (zebra stripes cross
> the other way). The sensor mask is built on demand (any photosite ≥ 0.99 in the
> binned block, ~270 ms once for 24 MP) and cached per slot after geometry. The
> toggles live in a status bar under the image (O, Shift+O) next to the assessment
> frame; thresholds are API-only for now. Exports never include them.

Two toggles, like Ansel's `overexposed.c` and `rawoverexposed.c`:

1. **Display clipping:** after filmic/output, flag pixels whose output exceeds an upper
   threshold (default 99.99 %) or falls below a lower one (default −12.69 EV). Modes:
   any channel / luminance / saturation (gamut). Painted in a solid colour or zebra.
   This is a render option, not part of the recipe. It costs one compare per pixel in
   the fused pass.
2. **Sensor clipping:** the base stage already knows which photosites saturated (where
   we clip highlights). Keep that as a 1-bit mask in the base image, carried through
   geometry by nearest sampling, and paint it on top.

Toolbar toggle plus a shortcut. Both apply to drafts too.

### 2.5 Slider feel (M, independent)

> **Done** (`develop/ParamSlider.tsx`, `develop/slider.ts`). As built: `min`/`max` are the
> useful range and `hardMin`/`hardMax` what the module takes. Those are its clamp where it
> has one (filmic contrast 0–5, white 0.1–16, black −16 to −0.1); where it has none, a
> chosen limit (exposure ±10, black level ≤ 1, primaries brightness ±1, sharpen ≤ 5).
> Only typing (click or right-click the number, in display units via `scale`) and values
> set from elsewhere (auto-tune) go past the useful range. **Deviation:** the track then
> grows to contain the value instead of pinning it, both ways for bipolar sliders so
> neutral stays centred, with the extra part in yellow. It stays grown until the slider
> unmounts (the developer is keyed by version), so the layout doesn't jump and nudging
> can't lose a value. Drags and arrows take Shift ×10 and Ctrl ×0.1 but stay on the track;
> Ctrl's step stops at the digits the number shows (exposure 0.01). Modifier drags are
> relative to the pointer, so they start anywhere without a jump. **Deviation:** no wheel,
> so scrolling the panel can never change a value. Gradient tracks replace the filled
> range where they say something (white balance, exposure-like values, the primaries'
> three sliders). AgX bleach is a five-detent slider.

Rework `ParamSlider` into the one control used by every module:

- **Gradient tracks** that show what the value does: warmth blue → amber and tint
  green → magenta for white balance, hue/saturation ramps for the future colour
  primaries (3.2), grey ramps for exposure-like values.
- **Soft range:** the track covers the useful range, but the module accepts more, and
  today there is no way to reach it. For example filmic's contrast slider stops at 3
  while the module goes up to 5. Ways to get there (like Ansel's soft/hard limits):
  type a value (click or right-click on the number), and keep values
  outside the track. The track then pins at its end and the number shows the real
  value. Each slider declares its soft range and its hard range (the module's clamp).
- **Stepped sliders for enumerations:** filmic's AgX bleach (none → extra) becomes a
  slider with five detents instead of a select.
- Fine/coarse adjustment with modifiers (Shift ×10, Ctrl ×0.1) on drag, wheel and
  arrow keys. Double-click on the track keeps resetting to the default.

### 2.6 Keyboard-driven, stepped editing (exploration)

Needs brainstorming and prototyping before it's planned. The idea is a primarily
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
(2.2): one entry per step.

---

## M3 — Image quality modules

These ports read the Ansel sources directly (GPL-3.0, see Licensing). They need **golden-image
tests** first: small reference renders of a handful of RAWs, compared within a tolerance.

### 3.1 Lens correction, auto-applied to new images (L)

> **Partly done: Sony embedded data** (`lens.rs`). As built, following darktable's
> `lens.cc` (embedded metadata v2): the 16-knot distortion, R/B CA and vignetting
> arrays are read from the ARW and stored in `PhotoMetadata.lensCorrection` (`"sony"`)
> and `RawPhoto::lens`. A single-instance `lens` module (first in pipeline order) has
> three strengths (0–200 %). Vignetting is applied **in the geometry resample** at each
> sample's source position, not in the base stage, so the base cache and sensor-clip
> mask don't depend on the lens. The image is always zoomed to the largest frame with
> no empty borders. The correction comes from lookup tables over r², evaluated once per
> output pixel and shared by its subsamples. Cost (61 MP, 2400 px, native): +117 ms
> when geometry re-runs (TCA reads each channel separately), nothing on cached
> renders. `EditParams::default_for(metadata)` / TS `defaultRecipe` add the module
> when the file has data. The render worker uses it for versions with no history
> (new uploads, duplicates from original), and the queue records it as entry 1
> "Lens correction (auto)" without bumping the revision. The public developer starts
> with the same entry. Never-edited versions that existed before also get it when
> they're next rendered; edited ones are untouched. Still to do: lensfun, DNG
> opcodes, other makers' embedded data, a manual lens override.

- **Sources, in priority order:**
  1. The manufacturer correction profile embedded in the RAW. Sony ARW comes first
     (your camera): tags `0x7032` vignetting, `0x7035` CA and `0x7037` distortion,
     which rawler defines but doesn't decode yet. Then DNG opcodes
     (`WarpRectilinear`, `FixVignetteRadial`), Fujifilm, Olympus/OM and Panasonic.
  2. The [lensfun](https://lensfun.github.io) database: distortion (poly3, poly5, ptlens),
     TCA and vignetting (pa), interpolated by focal length/aperture/distance. Parsed in
     Rust, no C dependency, so it works in wasm. The server serves only the matching
     profile (`GET /api/lens-profile?…`); the public developer fetches a slimmed,
     static per-mount bundle.
- **Pipeline:** vignetting is a radial gain in the base stage. Distortion and TCA join
  the single geometry resample: TCA samples R/G/B at slightly different radii. The
  geometry pass moves from "affine, stepped" to "affine + radial polynomial", which is
  still one pass.
- **Auto-enable:** `default_recipe(metadata)` adds a lens instance when a profile
  matches, so new imports get it in their first history entry ("auto-applied: lens
  correction"). Existing images are untouched.
- **UI:** source (embedded / lensfun / off), detected lens with manual override, and
  strengths for distortion, TCA and vignetting.

### 3.2 Colour primaries (M–L, after 1.1)

> **Done** (`ops/primaries.rs`). As built: a faithful port, including the anchors from
> `colorequal_shared.c` and the HLG Rec.2020 table space. It runs in the point pass,
> after shadows/highlights and before filmic, and does nothing until a colour is moved.
> The 64³ table stores linear changes rather than HLG output (no decode per pixel; as
> accurate as Ansel's). The anchors sit at fixed colours, so their weight on every table
> node is cached (19 MB, ~100 ms to build, redone only for gamut coverage and smoothing)
> and moving a colour rebuilds the 64³ table in ~17 ms. A 33³ draft table was tried
> and was visibly off (up to 27 levels). Ansel's interpolation choice is left out (tetrahedral). UI:
> six swatches select a colour with three sliders; gamut and smoothing settings are
> folded away.

- Port Ansel's `colorprimaries.c`: six hue nodes (R, Y, G, C, B, M) × hue / saturation /
  brightness, plus gamut coverage, white level, smoothing (brightness, saturation, hue)
  and neutral protection, baked into a 3D colour LUT.
- This fits our architecture well. The CLUT is built only when its parameters change
  (cached like filmic's stage), then applied in the fused point pass with the
  tetrahedral `Lut3d` we already have. Slider drags stay cheap; only this module's own
  sliders rebuild the LUT.
- **UI:** a hue wheel with six draggable nodes, or six rows of three sliders as a first
  version.

### 3.3 Contrast equalizer (L)

> **Done** (`ops/equalizer.rs`, `CurveEditor.tsx`). As built: Ansel's five curves (luma,
> chroma, edges, luma/chroma denoise; six fixed nodes each, Catmull-Rom) and mix, with
> its band sizes and gain/threshold formulas. Colour is `(RGB − Y) / (Y + ε)`, which
> fades near black instead of amplifying shadow noise. The 5×5 edge-aware filter is
> separable (rows then columns), and luminance and colour are decomposed separately,
> skipping a neutral one. The bands are **not cached**: ~60 MB per megapixel was too
> much next to the other caches. A curve edit re-runs the module, ~75 ms per megapixel
> for luminance (native). wasm SIMD would be the next speed-up. The curve editor has
> fixed node positions (vertical drag, double-click reset, arrow keys).

- À-trous wavelet decomposition (B-spline, edge-aware option) into 6–8 frequency bands
  in full-resolution pixel units. A curve over frequency sets per-band detail boost,
  with a second curve for denoise thresholds. This is the same idea as Ansel's
  `atrous.c` (6 nodes × luma/chroma/edges).
- **Deviation from Ansel, for speed:** decompose **log₂ luminance** (plus chroma ratios)
  instead of Lab. Exposure is then an additive constant that only touches the coarsest
  band, so the module commutes with exposure. That lets it live in the cached spatial
  stage, before the fused point pass.
- **Caching:** cache the decomposition itself (bands for the current size). Curve edits
  then only re-weight and recompose the bands. Preview sizes skip bands finer than a
  pixel, as Ansel does.
- **UI:** a reusable SVG curve-editor component (frequency axis, draggable nodes,
  double-click to reset). The tone equalizer could reuse it later.

### 3.4 Colour calibration (M, optional but useful before M4)

> **Done** (`ops/calibration.rs`, recipe v6). As built: the Ansel model. The base stage
> applies the camera's reference (D65) multipliers, and a colour calibration instance
> with the "as shot" illuminant (CAT16) is part of every recipe; v1–v5 recipes get one
> on load, with their warmth/tint folded into its channel mix (the warmth/tint kind is
> gone). Highlights clip at the as-shot white, so they stay neutral. Illuminants: as
> shot, D65, daylight/black body temperature, A, E, F1–F12, LEDs, custom hue/chroma;
> adaptations CAT16, linear Bradford, XYZ, none (no non-linear Bradford); gamut
> compression; R/G/B mixing (also as Ansel's "primaries" and "white-preserving" mixer
> modes, which are UI pages over the same matrix), colourfulness, brightness, grey.
> Ansel's auto-detection
> (surfaces/edges) is a one-shot button; it's a rough guess on the golden RAWs. No colour
> checker or spot mode. The point pass now runs on 64-pixel chunks, a module at a time,
> and calibration's loop is branch-free so it vectorises: a default render costs about
> the same as before (+4 ns/pixel natively). Found on the way: rawler 0.8 leaves
> `xyz_to_cam` empty, so camera matrices had never been applied (camera RGB was read as
> Rec.709); they now come from `RawImage::color_matrix`.

Ansel's `channelmixerrgb` (CAT16 white balance with illuminant, gamut compression,
colourfulness/brightness/grey mixing). It replaces today's warmth/tint as the standard
white balance and is the most common target for masked instances.

---

## M4 — Creative control

### 4.1 Multiple instances of a module (S–M, after 1.1)

> **Done** (`ModulePanel.tsx`, `updateInstance` and friends in `params.ts`). As built: a
> menu in the module header, with a section per instance in list order. White balance can
> have instances too (until 3.4 replaces it). "New instance" starts from defaults rather
> than copying, and only the first exposure has the +0.7 EV push, so adding one doesn't
> change the image. Delete needs a second instance: the only one has reset and its switch. Reset with
> several instances gives that one default parameters and keeps its name. Unnamed
> siblings show as "Exposure 2". Structural changes (add, remove, rename, move) never
> coalesce in the history. Two primaries instances with different gamut or smoothing settings share
> one weights cache, so dragging one can rebuild the weights on each render (~100 ms).

- A module header menu with: duplicate instance, rename, delete, move up/down (within
  its kind). The data model already supports it after 1.1.
- **Allowed for:** exposure, colour calibration, colour primaries, colour (sat/vib),
  shadows/highlights, contrast equalizer, sharpen, blur.
- **Not allowed for:** lens, geometry, filmic, retouch.

### 4.2 Presets (M, after 1.1; better once M3 exists)

> **Partly done: module presets and styles** (`packages/pipeline/src/presets.ts`,
> `develop/presets.tsx`, `/api/presets`, migration `00005`). As built: presets and styles
> are applied on the client and give a plain recipe, so the pipeline never sees them. A
> module preset can hold part of a module: kinds with distinct parts declare
> `PRESET_GROUPS` (colour calibration: CAT / mixer / output; filmic: white and black
> exposure / look; primaries: colour edits / range and smoothing), the save dialog picks
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
  reference (see 4.3).

### 4.3 Shapes: one format for masks and retouch (M, after 1.1)

Masks (4.5) and retouch (4.4) both need drawn shapes, so shapes are defined once, at the
recipe level, and referenced by id. This is darktable's "forms" and mask manager.

```jsonc
{
  "version": 3,
  "shapes": {
    "s1": {
      "type": "ellipse",
      "center": [0.42, 0.31],
      "radii": [0.08, 0.05],
      "rotation": 0.3,
      "feather": 0.02,
      "opacity": 1,
    },
    "s2": { "type": "gradient", "anchor": [0.5, 0.4], "angle": 1.57, "width": 0.1 },
    "s3": { "type": "path", "points": [[0.1, 0.2 /* Bézier handles… */]], "feather": 0.01 },
    "s4": { "type": "brush", "points": [[0.3, 0.3, 0.004 /* radius */, 0.8 /* hardness */]] },
  },
  "modules": [/* masks and retouch spots reference "s1"… */],
}
```

- **Types:** ellipse (and circle), linear gradient, path (closed Bézier), brush stroke
  (points with radius and hardness). Each has feather and opacity.
- **Coordinate frame: normalised sensor coordinates** (after the raw crop, before lens
  correction, orientation, straighten and crop), as darktable does. Shapes then stay on
  the image content when the crop, rotation or lens correction changes. A dust spot is
  also fixed on the sensor, so retouch spots can be copied across a whole shoot.
- **Transforms:** the geometry stage exposes `forward(point)` and `inverse(point)`
  (lens distortion + affine). The UI overlay uses them to draw and edit shapes on the
  displayed image. Radii are transformed with the local Jacobian, which is accurate
  enough for small spots.
- **UI:** one canvas overlay editor shared by masks and retouch: create, move, resize,
  rotate, feather handles, delete; shapes listed per module.

**Storage.** Shapes and masks are part of the recipe JSON. A recipe has to stay
self-contained for duplicates, styles, copy/paste, compare and the history stack, and
the pipeline receives it as one document. Most shapes are small: an ellipse is
~100 bytes, a 50-node path ~2 KB, a simplified brush stroke 5–20 KB. Heavy skin
retouching (a few hundred spots) is ~20–50 KB. The real cost is that 1.2 stores a full
snapshot per history entry, so 200 entries of a 50 KB recipe would be 10 MB per
version. In order of effort:

1. Postgres already TOAST-compresses jsonb over ~2 KB, and repeated JSON compresses
   well (switch the column to `lz4`). Coalescing in 2.1 makes one brush stroke one
   entry, not one per mouse move.
2. Brush strokes are simplified on commit (Ramer–Douglas–Peucker within ~0.5 px) and
   points are stored at fixed precision.
3. If it's still too big: **content-addressed objects in the DB only.** On write, the
   server replaces each shape (or any subtree over a few KB) in the snapshot with
   `{ "$ref": "<sha256>" }` and stores it once in `recipe_objects(hash, json)`. It
   inflates the recipe on read. Unchanged shapes then cost nothing per history entry.
   Clients and the Rust pipeline still only see full recipes.
4. **Raster masks** (painted bitmaps, future AI segmentation) are never inline. They are
   stored as files (8-bit PNG at reduced resolution) referenced by hash from the recipe,
   fetched separately, and passed to wasm as a buffer next to the recipe.

### 4.4 Retouch: spot removal (L, after 4.3; heal benefits from 3.3)

For dust spots, sensor and lens marks, hot spots and skin blemishes. It follows Ansel's
`retouch.c`.

```jsonc
{
  "id": "m9",
  "kind": "retouch",
  "params": {
    "spots": [
      { "shape": "s5", "mode": "heal", "source": [0.03, -0.01], "opacity": 1 },
      { "shape": "s6", "mode": "clone", "source": [-0.02, 0.0], "opacity": 0.8 },
      { "shape": "s7", "mode": "fill", "color": [0.18, 0.18, 0.18] },
      { "shape": "s8", "mode": "blur", "radius": 6 },
    ],
    "scales": null /* or [2, 5]: only these wavelet scales */,
  },
}
```

- **Modes:** heal (copy the source, then match it to the target's surroundings), clone,
  fill (colour), blur. The source is an offset from the target, in sensor coordinates.
  The spot shape is any 4.3 shape (usually ellipse, path or brush).
- **Heal:** a membrane / Poisson blend solved on the spot's bounding box (a few
  multigrid iterations, or a convolution pyramid). Each spot only touches its bounding
  box, so hundreds of spots stay cheap.
- **Wavelet scales:** optionally apply the spots only to a range of à-trous scales,
  reusing the 3.3 decomposition. This removes a blemish (coarse scales) but keeps the
  skin texture (fine scales), as Ansel does.
- **Pipeline:** its own cached stage **between base and geometry** (sensor frame), keyed
  by the retouch params. Sources outside the final crop are usable, and lens correction
  applies after the retouch. Previews work at binned resolution because the coordinates
  are normalised; radii are scaled by the render scale like other spatial parameters.
- **Single instance** (the spot list is the multiplicity). Not maskable.
- **Tools:** auto source search (the nearby patch whose ring around the spot matches
  best); a "visualise spots" display (high-pass + threshold, to reveal dust in skies);
  copy spots to the selected photos in the library (meaningful because of the sensor
  frame).

### 4.5 Masks (XL, after 4.1 and 4.3)

A module's mask combines drawn shapes (4.3) with parametric ranges:

```jsonc
"mask": {
  "drawn": [{ "shape": "s1" }, { "shape": "s2", "op": "difference" }],   // union by default
  "parametric": { "luminance": [-6, -4, 0, 2] /* EV, feathered trapezoid */, "chroma": null, "hue": null },
  "combine": "intersection",       // drawn ∩ parametric
  "invert": false,
  "feather": { "radius": 8, "guided": true },   // full-resolution px, edge-aware
  "opacity": 1
}
```

- **Drawn:** shapes combined with union, intersection, difference or exclusion.
- **Parametric:** feathered ranges on luminance (EV), chroma and hue, measured on the
  module's input.
- Feather radius (guided filter, edge-aware), opacity, invert, and a mask preview overlay
  (yellow, like Ansel).
- **Evaluation:**
  - The drawn part is rasterised in the sensor frame and pushed through the same
    geometry resample as the image. It is cached, keyed by the shapes and the geometry.
  - The parametric part is a per-pixel function, so masked point modules stay in the
    fused pass, reading the cached drawn mask, at the cost of more work per pixel.
  - Edge-aware feathering needs the image, so the feathered mask is cached as well,
    keyed by the mask spec and the upstream stages.
  - Masked spatial modules (sharpen, contrast equalizer) blend after their stage.
- **Budget:** each masked instance costs roughly one extra point-module evaluation per
  pixel. Track it with `examples/bench.rs`.

---

## M5 — Compare (M–L, after 1.2)

- **Library:** select 2–4 versions → a compare view in a grid, with synchronised zoom and pan.
- **Developer:** compare the current state with an earlier history entry (snapshot) as a
  split view or side by side. The same `Developer` renders both recipes and shares the
  base cache; raise the cache slots from 2 to 4.
- **Geometry normalisation (my reading of the Ansel behaviour):** all compared images
  get the **reference image's** geometric modules (lens, rotation, straighten, crop,
  perspective). Only the tone and colour modules differ, so differences come from
  contrast and colour. This is exact for versions of the same photo. For different
  photos (a burst), the reference crop rectangle is applied in normalised coordinates.
- **Rendering:** library comparisons use live renders at screen size. They are server
  previews today; with M6 they come from the render service.

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
   there unless the user explicitly opts in.
6. **Operations.** Concurrency limits, per-user quotas, a memory budget per worker, and
   metrics (render time, queue time, frame size).

Prerequisite worth doing early: introduce `RenderBackend` while the developer is still
small, even with only the local implementation.

> **Done** (`develop/renderBackend.ts`). As built: the interface covers `render`,
> `exportJpeg`, `autoTuneFilmic` and `dispose`. Loading stays on `LocalRenderBackend`
> (`load(bytes)`), since a remote backend would open a session by version id instead.

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
- **P.2 wasm SIMD (S–M).** Build with `+simd128` and measure. The per-module loops in
  `PointOps::adjust_all` and the equalizer's separable filters may autovectorise; LUT
  lookups won't. Golden tests must pass unchanged.
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
- **Ansel parity:** for each port, record the upstream commit it follows (as
  `filmic.rs` does) and keep a short "deviations" list.
- **Licensing:** filmic, colour primaries, the contrast equalizer and lens correction
  are or would be ports of GPL-3.0-or-later code, so RAWtisserie should be
  GPL-3.0-or-later (or AGPL-3.0 if network use should also share changes — relevant
  once cloud processing exists). The lensfun database is CC-BY-SA 3.0 and needs
  attribution.

## Suggested order

1. M1.1 + M1.2: foundations, one PR each.
2. M2.4 clipping indicators (small, independent quick win) and the `RenderBackend`
   interface.
3. M2.1 → M2.2 → M2.3: autosave, history, duplicates.
   M2.5 sliders can go in at any time; M2.6 stays an exploration until it has a
   prototype.
4. M3.1 lens correction (embedded Sony first, then lensfun), then 3.2, then 3.3.
5. M4.1 → M4.5: instances, presets, shapes, retouch, masks. Retouch can move earlier
   (right after 4.3) if dust removal is a priority; it doesn't need masks.
6. M5 compare.
7. M6 cloud processing. Move it earlier if slow-hardware users are a near-term priority;
   step 1 (the native renderer) is useful on its own.
