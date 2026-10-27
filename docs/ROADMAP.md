# 🍗 RAWtisserie roadmap

Status: plan, nothing below is built yet. Written 2026-10-27.

Most of the requested features (history, duplicates, autosave, presets, masks, multiple
instances of a module) depend on the same thing: edits must stop being one fixed struct
and become **a list of module instances with a history**. So the plan starts with that
foundation, then builds features on top in milestones that each ship something usable.

```
M1 Foundations ──┬─▶ M2 Workflow (autosave, history, duplicates, clipping indicators)
                 ├─▶ M3 Image quality (lens correction, colour primaries, contrast equalizer)
                 ├─▶ M4 Creative control (module instances, masks, presets)
                 └─▶ M5 Compare
M6 Cloud processing ── independent; can start any time (native renderer first)
```

Sizes: S ≈ a day or two, M ≈ a week, L ≈ 2–3 weeks, XL ≈ a month or more.

---

## M1 — Foundations

### 1.1 Recipe v3: a list of module instances (L)

Today `EditParams` is a struct with one section per module. v3 becomes:

```jsonc
{
  "version": 3,
  "modules": [
    { "id": "m1", "kind": "exposure", "label": null, "enabled": true,
      "params": { "ev": 0.7, "black": 0 }, "mask": null, "opacity": 1 },
    { "id": "m2", "kind": "exposure", "label": "sky", "enabled": true,
      "params": { "ev": -0.5, "black": 0 }, "mask": { /* M4 */ }, "opacity": 1 },
    { "id": "m3", "kind": "filmic", "enabled": true, "params": { /* … */ } }
  ]
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

Split "the file" from "an edit of the file", like darktable duplicates:

| Table | Holds |
|---|---|
| `photos` | original file, sha256, EXIF/metadata (unchanged) |
| `versions` (new) | `photo_id`, `name`, `position`, rating, flag, colour label, title/description/tags, `history_end`, `revision`, render status/version |
| `history_entries` (new) | `version_id`, `seq`, `created_at`, `label` ("exposure +0.3 EV"), `recipe jsonb` (full snapshot) |

- Full recipe snapshots per entry keep reads trivial (a few KB each); compress later if needed.
- **Decision:** ratings, flags and labels move to versions, so variants can be culled
  separately. EXIF stays on photos.
- The library grid lists versions; versions of the same photo show a stack badge.
- Renders are keyed by version.
- Migration: one version per existing photo, one history entry from `edit_params`.

---

## M2 — Workflow

### 2.1 Autosave, no Save button (S, after 1.2)

- Each committed change (slider release, crop applied…) is sent, debounced ~750 ms,
  as `POST /api/versions/:id/history` with `{ recipe, label, baseRevision }`.
- **Coalescing:** if the previous entry is the same module instance, comes from the same
  session, and is less than 10 s old, replace it rather than append.
- **Conflicts:** `revision` gives optimistic concurrency. Another tab editing the same
  version gets a 409 → "This version changed elsewhere — reload".
- **Flush on leave:** `visibilitychange`/`pagehide` with `fetch(..., { keepalive: true })`.
- The header shows "Saving… / Saved". The `beforeunload` warning goes away.
- The public `/develop` page has no server, so it keeps undo/redo in memory.

### 2.2 History stack (M, after 1.2)

- A left panel in the developer (as in Ansel): entries newest-first with module icon and
  change summary, plus a "0 — original" entry at the bottom.
- Clicking an entry moves `history_end` there and renders that state. Editing from an
  earlier point **truncates** later entries (Ansel/darktable semantics), with an undo
  toast. Linear, not branching: duplicates cover branching.
- **Compress history:** collapse to one entry per module instance.
- Undo/redo shortcuts move `history_end` instead of the local stack.

### 2.3 Duplicates (S–M, after 1.2)

- Library and developer actions: **Duplicate** (copies the history) and **Duplicate
  from original** (starts from `default_recipe`).
- Rename, reorder and delete versions. Deleting the last version asks to delete the photo.
- Developer: a version switcher next to the file name.

### 2.4 Over/under-exposure indicators (S–M, independent)

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

---

## M3 — Image quality modules

These ports read the Ansel sources directly (GPL-3.0, see Licensing). They need **golden-image
tests** first: small reference renders of a handful of RAWs, compared within a tolerance.

### 3.1 Lens correction, auto-applied to new images (L)

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

Ansel's `channelmixerrgb` (CAT16 white balance with illuminant, gamut compression,
colourfulness/brightness/grey mixing). It replaces today's warmth/tint as the standard
white balance and is the most common target for masked instances.

---

## M4 — Creative control

### 4.1 Multiple instances of a module (S–M, after 1.1)

- A module header menu with: duplicate instance, rename, delete, move up/down (within
  its kind). The data model already supports it after 1.1.
- **Allowed for:** exposure, colour calibration, colour primaries, colour (sat/vib),
  shadows/highlights, contrast equalizer, sharpen, blur.
- **Not allowed for:** lens, geometry, filmic.

### 4.2 Masks (XL, after 4.1)

- **Drawn masks:** ellipse, linear gradient, then polygon/path, then brush. Coordinates
  are normalised to the **oriented, uncropped** frame, so re-cropping doesn't move them.
- **Parametric masks:** ranges with feathered edges on luminance (EV), chroma and hue,
  measured on the module's input.
- Combining (union, intersection, difference, invert), feather radius (guided filter,
  edge-aware), opacity, and a mask preview overlay (yellow, like Ansel).
- **Evaluation:**
  - Drawn and parametric masks are per-pixel functions, so masked point modules stay
    in the fused pass, at the cost of more work per pixel.
  - A feathered mask is spatial: cache its buffer, keyed by the mask spec and geometry.
  - Masked spatial modules (sharpen, contrast equalizer) blend after their stage.
- **Budget:** each masked instance costs roughly one extra point-module evaluation per
  pixel. Track it with `examples/bench.rs`.

### 4.3 Presets (M, after 1.1; better once M3 exists)

- **Module presets:** named parameters for one module kind ("Filmic — high contrast").
  Built-in plus per-user.
- **Styles:** a chosen subset of module instances from a recipe. Applying one either
  replaces instances of those kinds or appends new instances (user's choice).
- **Auto-apply rules** by camera, lens, ISO or format. This reuses the
  `default_recipe` hook from 1.1, and auto lens correction can simply be a built-in
  rule.
- Table: `presets(id, owner_id, name, kind: module|style, module_kind, payload jsonb,
  auto_apply jsonb, position)`.

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
   worker (today's `PipelineClient`) and remote. `DeveloperView` doesn't know which is
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

---

## Cross-cutting

- **Golden-image tests** (before M3): about five reference RAWs from different brands
  (raw.pixls.us is CC0), each with a recipe and a small expected PNG, compared with a
  ΔE tolerance. Port changes must explain any diff.
- **Performance budget:** extend `bench.rs` per module and record numbers in PRs.
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
4. M3.1 lens correction (embedded Sony first, then lensfun), then 3.2, then 3.3.
5. M4.1 → M4.3 → M4.2: instances, presets, masks.
6. M5 compare.
7. M6 cloud processing. Move it earlier if slow-hardware users are a near-term priority;
   step 1 (the native renderer) is useful on its own.
