# 🍗 RAWtisserie roadmap

Status: plan, written 2026-10-27. Done: 1.1 (recipe v3); 1.2 (versions and history);
2.1 (autosave); 2.2 (history stack); 2.3 (duplicates); 2.4 (clipping indicators); 2.5
(slider feel); the `RenderBackend` interface (M6 prerequisite); golden-image tests
(before M3); 3.1 with
Sony's embedded data (lensfun and other makers postponed); 3.2 (colour primaries);
3.3 (contrast equalizer); 3.4 (colour calibration); 4.1 (multiple instances); 4.2 module
presets and styles (auto-apply rules to do); 4.3 (shapes) and 4.4 (retouch), built
together; 4.5 (masks); full-size colour drags on a worker pool (see Performance);
8.1 (presets and styles on a selection); 4.6 (tone curve); 4.9 (frame, as an export
option); 8.5 (export options); 8.3 (culling loupe).
Added 2026-11-05: what 1.0 needs (3.5–3.8, 4.6–4.9, M8 library workflow, M9 branding);
4.10 (tone equalizer) added to it on 2026-11-06; see [1.0 release scope](#10-release-scope).
4.11 (blend modes, with LUT masks) done 2026-11-07; 4.12 (glow) and 8.3 (culling
loupe) done the same day. 4.7 (colour balance RGB) and 4.10 (tone equalizer, merged into
the tone curve, now shown as "Tones") done 2026-11-08.
Photoshoot feedback (2026-11-09): done the same day: burst order, "edited" ignoring the
automatic lens correction entry, primaries sliders stopping before a singular mix, wider
colour balance ranges and "Colorfulness: standard" in the default recipe, the library
view restored when leaving the developer, and a film roll under the developer. 8.8
(append or apply per module) done the same day. 8.6 (copy and paste) and 8.7
(auto-tune on apply) too.
Feedback (2026-11-10): done the same day: select all/none when copying settings or
creating a style, the crop aspect starting at "Original", Tones' auto-tune in its header
with A for every auto-tune, and a Tones strength. Added: 4.13 (mask UI redesign), and
8.4's decisions (in the browser, one ZIP, export from the library with it). Later that
day: tags moved up and a folded "Technical" group (camera, lens, ISO, focal length, aperture)
in the library's filters, tag completion (fuzzy, from the library's tags) and T to focus
it. Added: M9's design system, then started its `/ui` page (with the new fonts to try).
Then in the app: Barlow Semi Condensed with Lilex for values, modules as blocks of their
own with bolder titles and the switch on the right, no text selection in the developer's
side panels.
2026-11-11: a manager dialog to rename and delete the user's own LUTs, module presets and
styles ("Manage…" in their menus, replacing the delete submenus).
Later that day: 3.7 (diffuse or sharpen), a port of Ansel's with all its presets.
Feedback: Barlow Semi Condensed was too narrow for rows of similar sliders (colour
balance): Geologica instead (Asta Sans tried first: its ellipsis is centred, Korean
style), and Inter out of `/ui`. Uppercase tabs, dimmer colour balance group headers.
Then: a modified module's title is orange only when it's enabled; colour calibration's
adaptation moved into its fold. 8.4 (export from the library) done.
2026-11-12: library feedback (grid, info panel and filters in the developer's density,
flags filtered in any combination, a status bar with photos per row, a virtualised
grid). Added: 8.9 (focus areas). Deployment: CI, a container image, `deploy/` for a
single VPS with nightly database backups to a bucket (part of 7.3), then 7.1 (object
storage).
2026-11-13: Canon CR3 decoding in wasm fixed (rawler patched from our fork, upstream PR
dnglab/dnglab#960). Added: 3.9 (better demosaicing at full resolution). 7.5 (quotas)
done, with invitations and an admin page. The render queue records its figures per hour
(`render_stats`: peak pending, longest wait, renders and their durations), shown on the
admin overview for 24 hours and 7 days; a graph can read the same table later. 4.8 (3D
LUT) closed: what was left (uploading browser-only LUTs on "Add to library") can't
happen in the app as it is. 7.3's soft delete done, as a trash: deleted photos can be
restored for 30 days.

Most of the requested features (history, duplicates, autosave, presets, masks, multiple
instances of a module) depend on the same thing: edits must stop being one fixed struct
and become **a list of module instances with a history**. So the plan starts with that
foundation, then builds features on top in milestones that each ship something usable.

```
M1 Foundations ──┬─▶ M2 Workflow (autosave, history, duplicates, clipping indicators, sliders, guided editing)
                 ├─▶ M3 Image quality (lens correction, colour primaries, contrast equalizer,
                 │                     denoise, lensfun, diffuse & sharpen, perspective)
                 ├─▶ M4 Creative control (module instances, presets, shapes, retouch, masks,
                 │                        tone curve, colour balance RGB, 3D LUT, frame)
                 ├─▶ M5 Compare
                 └─▶ M8 Library workflow (batch presets, folder/SD import, culling, batch export)
M6 Cloud processing ── independent; can start any time (native renderer first)
M7 Hosted service ──── storage, quotas, history size, local originals; 7.1 before a public launch
M9 Branding ────────── independent; logo, typography, spinner, /develop page
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

- Full recipe snapshots per entry keep reads trivial (a few KB each); compress later if
  needed (see 7.7).
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
(2.2): one entry per step. Prototype it with 4.13's mask sidebar: both change how the
panels are laid out and navigated.

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
> for luminance (native). The wasm build uses SIMD (autovectorised loops). The curve editor has
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
  double-click to reset). The tone equalizer (4.10) could reuse it later.

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

### 3.5 Raw denoise (AI) (XL, before 1.0)

A port of Ansel's "RAW Denoise (AI)" module: `src/iop/rawdenoiseai.c`, the CPU executor
`src/common/nn_model.c`, and the design notes in `doc/rawdenoiseai.md` (last changed
upstream at `57c1f08d81`, 2026-10-02). The models are trained in
[ansel-denoise](https://github.com/aurelienpierreeng/ansel-denoise) (GPL-3.0).

**What upstream does:**

- **The network.** A small U-Net (3×3 convolutions with GELU; 4 levels down and up,
  with skip connections). It **subtracts** an estimated noise layer from the raw
  **CFA mosaic, before demosaic**, where the noise is still independent per photosite.
- **Five input planes:** the mosaic, three one-hot CFA planes (so one set of weights
  handles Bayer and X-Trans), and a σ map.
- **The σ map:** σ = √(a·y + b), where (a, b) come from the camera's noise profile at
  the photo's ISO, looked up in darktable/Ansel's `noiseprofiles.json`, with a generic
  fallback for cameras that have no profile.
- **Parameters:**
  - strength (default 0.85), an opacity: `in + strength·(denoised − in)`;
  - global correction (1.0);
  - per-channel corrections R 2.82 / G 3.94 / B 2.96, which carry the profiles'
    calibration (×2 for the Haar normalisation, times the demosaic attenuation);
  - model version (v1);
  - model size: large / half / quarter (default quarter);
  - variant: single-scale or multiscale (default multiscale; a coarse chroma net on
    the binned image guides the fine net).
- **Weights:** `.anselnn` files (a magic number, a JSON header, raw float32 tensors),
  from 1.9 MB (quarter single) to 38 MB (large multi). They are pinned by version: a
  retrained model is a new version, so old edits never change. The sizes are separate
  fits, not interchangeable. On X-Trans, quarter leaves a visible CFA pattern; prefer
  half or large there.

**What it means here:**

- **Placement:** a new kind before `Retouch`, single instance, inside the base stage.
  Today the base is demosaiced or **binned** from the mosaic (`demosaic::develop_base`).
  Denoising must run on the full-resolution mosaic, so it needs a cached denoised
  mosaic keyed by the denoise parameters, from which every base factor and region
  patch is developed.
- **Decision: previews.** Denoising the whole mosaic is the expensive part, and binning
  already averages noise away at small scales. Options:
  - always denoise the full mosaic (correct, slow first render);
  - denoise only for 1:1 regions and exports, using the receptive field as the
    region margin (fast, but previews differ from exports).

  `tests/regions.rs` will settle what has to match.

- **Executor:** port `nn_model.c` to Rust (convolutions, resampling, GELU), with no
  runtime dependency, so it runs in wasm and natively. Check it against upstream's
  parity fixtures (tolerance 2·10⁻⁴). Bench quarter, half and large at 24 and 61 MP.
  Expect seconds in single-threaded wasm, which makes this the strongest case for P.2
  explicit SIMD, P.5 wasm threads, WebGPU, and M6 (native, rayon). Determinism
  matters: same file, parameters and model version must give the same pixels (golden
  test).
- **Model and profile files:** serve the `.anselnn` files and a slimmed
  `noiseprofiles.json` as static, hash-verified assets, downloaded lazily the first
  time the module is enabled. The recipe stores version, size and variant, as
  upstream does. Metadata already has the ISO and camera model needed for the profile
  lookup.
- **Licensing:** code and weights are GPL-3.0, consistent with the other ports (see
  Licensing).
- **UI:** strength, model size (default by sensor type and device speed), variant, and
  the corrections under an "advanced" fold. Show a progress state while the denoised
  mosaic is computed.

### 3.6 Lens correction via lensfun (L, before 1.0)

The remaining part of 3.1: the lensfun database, then DNG opcodes and other makers'
embedded data, plus the manual lens override. See the source list in 3.1.

### 3.7 Diffuse and sharpen (L, before 1.0)

> **Done** 2026-11-11 (`ops/diffuse.rs`, the `diffuse` kind, "Diffuse or sharpen" in the
> UI). A port of Ansel's `diffuse.c` (not darktable's: Ansel measures edges on the
> detail-to-low-pass ratio, so they don't depend on exposure, and retuned the denoise
> presets), checked against its kernels and fast `exp` bit for bit. First of the spatial
> stage, maskable. Deviations: it runs before exposure, so the image is
> scaled by the default +0.7 EV for it (anisotropy and the inpainting threshold depend on
> the level); inpainting noise is seeded by frame position, so regions match. Its reach
> is iterations × 3·(2^bands − 1); region renders cap the margin at 1024 px as before,
> which wide presets (local contrast, dehaze) exceed when zoomed in. All 17 of Ansel's
> presets ship ("bloom" as "Soft diffusion"); the default is "sharpen demosaicing (AA
> filter)". Iterations: soft max 8 on the slider (Ansel's 500 can be typed or come from
> a preset). The 3×3 kernels are expanded into neighbour sums and run per channel in
> vectorised 64-pixel chunks, one loop per operator, none at speed 0 (~7 ns per pixel,
> channel and band natively). Measured in the browser (wasm, 1024×683 fitted render):
> AA filter 0.24 s, denoise fine 1.1 s, lens deblur medium 1.7 s, add local contrast
> 4.3 s; natively at 2400×1600 (`examples/bench.rs`, whole render, ~1 s without diffuse),
> lens deblur 7.9 s and local contrast 12.8 s. Left: the
> spatial stage is single-threaded (no "expensive" hint in the UI for now, decided
> 2026-11-11); copying padded rows and the ratio plane are ~20 % of a band and could go.
> The browser diffuses the three channels in parallel on the point pool (same day,
> ~2.5–2.8× faster: local contrast 4.3 → 1.5 s, see `docs/PERFORMANCE.md`). Region
> renders (zoomed in) take a margin of one iteration's reach × max(1, ½·√iterations)
> rather than the theoretical reach, and negligible coarse bands are skipped: lens
> deblur at 100 % 21 → 3.7 s natively; local contrast's wide bands still need the 1024 px
> cap. The blur and sharpen (unsharp mask) modules were removed the same day: diffuse
> replaces both. Their instances are dropped on load, unmigrated, and their saved
> presets deleted (migration 00011, which re-renders the previews that used them).

A port of `diffuse.c` (Ansel's, or darktable's if it has diverged usefully). It uses
multiscale anisotropic diffusion: sharpening, local contrast, deblurring, bloom and
inpainting presets. Its "bloom" diffuses the whole image; light spreading out of the
highlights is 4.12's (glow), so rename that preset (e.g. "soft diffusion").

- A spatial stage next to sharpen and the contrast equalizer, maskable. Iterations at
  large radii are expensive: bench them, and report the `reach` for regions, which
  can be large.
- Size-dependent choices use the whole frame, as in `equalizer::apply_in_frame`.
- Built-in presets matter more than the raw controls here (darktable ships ~20).

### 3.8 Perspective correction and vertical alignment (L, before 1.0)

> **Done** (`ops/perspective.rs`, `ops/lines.rs`, `develop/GuideOverlay.tsx`). As built:
> the correction is a camera rotation, not a free homography: the straighten angle is
> the roll, `vertical` and `horizontal` the tilt and pan (degrees), then a shear and an
> aspect stretch. The rotation keeps a corrected facade's proportions when the focal
> length is right; files don't record the sensor size, so the EXIF focal length is
> read as full frame (28 mm when unknown or under 8 mm) and `aspect` makes up for it.
> The geometry pass is a homography when there's a perspective or the auto-crop isn't
> the default; otherwise the old affine path runs unchanged (golden images didn't move).
> Auto-crop: the largest rectangle of the frame's aspect, or of any aspect (a linear
> program per aspect), or none (black borders, shown while guides are edited). Lines
> are detected LSD-style (region growing on gradient orientation, not a port), pieces
> merged when collinear, and those that agree on a plausible vanishing point (RANSAC)
> preselected. Fits are closed-form: vanishing points from the lines' interpretation
> planes, sent to infinity by the rotation; "both" aligns the verticals exactly and
> shears the horizontals level. Guides are transient (not in the recipe): the user
> toggles, draws, moves or removes them, and a fit runs again on each change; Apply
> commits one history entry. `examples/perspective.rs` shows detection and the fit on
> a photo.

For architecture and interiors, following darktable's `ashift.c` ("rotate and
perspective").

- **Model:** a homography in the geometry module (single instance), so the geometry
  pass becomes "projective + radial polynomial", still one resample. Crop and the
  sensor mapping must account for it; shapes stay in sensor coordinates and follow.
- **Auto:** detect line segments (ashift uses LSD), then fit vertical, horizontal or
  both. Manual: the user draws two or four guide lines (rectangle/lines tool, as in
  darktable's newer versions).
- **Auto-crop** to the largest frame without empty borders, like lens correction does.
  A `GeometryKey` change re-renders everything after it, so the cache key must include
  the new fields.

### 3.9 Better demosaicing at full resolution (M–L)

Added 2026-11-13. `demosaic.rs` is our own and has two paths: previews and anything
downscaled **bin** photosites per colour (no demosaicing, alias-free), and full
resolution (100 % zoom, loupe tiles, full-size exports, the golden `detail` recipe)
demosaics **bilinearly**, averaging the nearest photosites of each colour. Bilinear
softens fine detail, leaves zipper patterns and false colour on sharp edges, and is
weakest on X-Trans. Only the full-resolution path changes; binning stays.

- **Algorithms:** port Ansel's defaults (GPL-3.0, like the other ports): **RCD** for
  Bayer and **Markesteijn** (1 or 3 passes) for X-Trans, from its demosaic module
  (`src/iop/demosaic.c` and the algorithm sources it includes). Keep bilinear for odd
  CFAs and as a fallback. rawler has PPG and Markesteijn (`imgop::sensor`), but they
  time themselves with `Instant::now()`, which panics in wasm, and RCD is what Ansel
  uses for Bayer.
- **Regions:** both read further than bilinear's 2 photosites. The base patch of a
  zoomed region needs that margin (`develop_base_region`'s reach), or tiles stop
  matching whole renders: `tests/regions.rs` checks it. Size-dependent choices must use
  the whole frame, as elsewhere.
- **Cost:** measure with `examples/bench.rs` at full resolution, native and wasm, 24 and
  61 MP. It only runs when the base is developed at factor 1 (cached afterwards), so
  sliders aren't affected; the first 100 % view and full-size exports are.
- **Golden images:** the `detail` renders move; re-bless them in the same commit and
  say why. Consider a recipe or crop that shows edges (zipper, false colour).
- **Choice:** an option in the recipe (Ansel has one per image) or fixed? Fixed RCD /
  Markesteijn is simpler and enough to start with.

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
  shadows/highlights, contrast equalizer, sharpen, blur, retouch (each instance has its
  own spots; the overlay edits one instance at a time).
- **Not allowed for:** lens, geometry, filmic.

### 4.2 Presets (M, after 1.1; better once M3 exists)

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

### 4.3 Shapes: one format for masks and retouch (M, after 1.1)

> **Done**, with 4.4 as its first user (`shapes.rs` ↔ `packages/pipeline/src/shapes.ts`,
> `develop/ShapeOverlay.tsx`). As built: `shapes` is left out of the JSON when empty, so
> no version bump. `normalize` drops spots whose shape is missing and shapes that nothing
> uses (`shape_refs`), in both languages. New ids are `s1`, `s2`… Lengths (radii,
> feather, brush radius) are fractions of the sensor's shorter side, so circles stay
> round; angles are radians, clockwise. Ellipse, gradient and path have `feather` (for
> the gradient it is the transition width, `width` below). Brush points carry their own
> hardness instead. Path nodes are `[x, y, inX, inY, outX, outY]` with absolute control
> points. The transforms are `geometry::SensorMapping` (`Developer::sensor_mapping`, wasm
> `sensorMapping`): the pipeline worker sends it with every frame (cached by the lens
> and geometry instances), and TS mirrors it (`toSensor`/`fromSensor`). Lens distortion
> is inverted by fixed-point iteration on its radial table. Rather than transforming radii
> with a Jacobian, outlines are sampled densely in the sensor frame and every point is
> mapped. The overlay is an SVG in the zoomed stage. It has tools for circle, ellipse,
> path (click nodes, drag for curves, close on the first node or Enter) and brush; handles
> for the radii (a circle stays one unless Alt is held), rotation, feather, and path nodes
> and control points; drag a shape to move it, drag its dashed source. Gradients
> rasterise, draw and edit, but there is no tool to create one yet (masks will need
> it). Storage: brush strokes are simplified on release (RDP, 0.5 px) and coordinates
> rounded to 1e-6. The `lz4` column and content-addressed objects aren't done. Styles
> carry the shapes their spots use, renamed if the recipe already has those ids.

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

> **Done** (`ops/retouch.rs`, the retouch section of `ModulePanel.tsx`). As built: heal,
> clone, fill and blur, with opacity per spot. Fill takes a linear Rec.2020 colour (picked
> as sRGB). Blur is a Gaussian in full-resolution pixels. Source offsets are rounded to
> whole base pixels, as in Ansel, and a source outside the image reads its edge. Heal is
> Ansel's: a Laplace solve on square roots, by red/black SOR. Here it starts from a
> coarse-to-fine estimate and stops on the mean change per pixel: a 180 px radius
> heal at full size takes ~35 ms instead of ~550 ms (native), within 0.4 of an 8-bit
> level of the converged result. Pipeline: the base (or region patch) is retouched in
> place, and each spot keeps the pixels it overwrote, so changing the spots restores those
> and reapplies. `GeometryKey::retouch` is the spots' hash. A region's patch covers what
> the spots touching it read, transitively (`retouch::needed`; `tests/regions.rs`). Module
> presets of retouch carry their shapes and replace the instance's spots: meant for
> sensor dust on photos from one camera (spots are in sensor coordinates). Several instances are
> allowed: their spots apply in list order, and removing or resetting one drops the
> shapes only it used. Golden recipe `retouch.json`. Not done yet: wavelet scales, automatic source search (a new spot's
> source goes beside it), the "visualise spots" view, and copying spots to other photos.

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
- ~~Single instance (the spot list is the multiplicity).~~ Several instances, applied in
  list order (e.g. dust, then skin). Not maskable.
- **Tools:** auto source search (the nearby patch whose ring around the spot matches
  best); a "visualise spots" display (high-pass + threshold, to reveal dust in skies);
  copy spots to the selected photos in the library (meaningful because of the sensor
  frame).

### 4.5 Masks (XL, after 4.1 and 4.3)

> **Done** (`ops/mask.rs`, `params::Mask` ↔ `Mask` in `params.ts`, `develop/MaskEditor.tsx`).
> As built: an instance's `mask` is left out of the JSON when absent (no version bump),
> and only the spatial and point kinds before filmic keep one (`ModuleKind::maskable`).
> The format is flat: `{ enabled, drawn: [{ shape, op }], luminance, saturation, hue, red, green, blue,
feather, edgeAware, invert, opacity }`; there's no `combine`, drawn and parametric
> always multiply, and the first shape's op is ignored. A mask switched off applies
> everywhere. Saturation and hue are measured in CIE 1976 u′v′ (exposure-invariant, no
> `pow`): saturation is CIELUV's s_uv (skin ≈ 0.6, sky ≈ 1), hue its angle around white
> (red ≈ 12°, green ≈ 128°, blue ≈ 266°), and hues fade out for greys. Red, green and blue are the working space's channels, in EV from middle grey like luminance. Ranges are
> smoothstep trapezoids; hue ranges wrap. The feather (guided filter on log luminance,
> or a Gaussian) applies to the whole mask. Without ranges, only the drawn part needs
> it, guided by the geometry stage, and ranges (none), invert and opacity stay in the
> fused pass and the pool. With ranges and a feather (`Mask::feathers_whole`), the whole
> mask is computed with the spatial stages on the module's input (for a point module,
> the spatial image through the point modules before it), guided by it and cached by
> those modules: its ranges, and edits before it, then re-render like spatial edits
> (~200 ms at 2400 px native, the draft while dragging); invert and opacity stay per
> pixel. Drawn parts are rasterised in the sensor frame at the render's scale (whole
> and region renders get the same pixels), over the shapes' bounds, then resampled
> through the geometry (exact positions on a 16 px grid, interpolated) and cached per
> slot, keyed by their resolved shapes; a plane whose shapes didn't change is reused.
> The pool gets the planes' strips with the image's. Masked spatial steps blend after
> their stage, measured on their input. Costs at 2400×1600 (native): a masked point
> slider +4 % over unmasked; moving a mask's shape ~50 ms; a 40 px edge-aware feather on
> a full-frame gradient ~150 ms once. The yellow overlay (`Overlays::mask`) shows the
> mask as the instance applies it, or one of its ranges alone, or the values a range
> measures on the instance's input (luminance, saturation, hue, a channel) in the colours of its
> slider's track (`Overlays::mask_view`). The editor: a mask button in each maskable module's
> header (solid while a mask is on), a switch for the mask, the shape tools (now with a
> gradient tool, for retouch too), an op per shape, range sliders with four handles (held past an end of the track, it widens under the pointer), feather/edge-aware, opacity and
> invert. Module presets can include the mask ("Include the mask", off by default);
> styles carry masks and their shapes. Golden recipe `masks.json`. Not done yet:
> picking a range from the image (eyedropper), raster masks (painted bitmaps, AI
> segmentation), and mask presets on their own.

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

### New modules for 1.0

Each needs the usual steps for a new kind:

- an entry in the `modules!` macro and in the TS `ModuleParams`, `MODULE_KINDS` and
  `defaultModuleParams`;
- a pipeline stage;
- a golden recipe;
- `PRESET_GROUPS` if it has distinct parts.

A kind that's absent is off, so adding one needs no recipe version bump.

### 4.11 Blend modes (M, after 4.5)

> **Done** (`ops/blend.rs`, `params::BlendMode` ↔ `BLEND_MODES`, the Blend menu in
> `MaskEditor.tsx`). A mask says how the instance's output `b` combines with its input
> `a` (`mask.blend`, `mask.blendFulcrum`, absent = normal, no version bump); the mask,
> opacity included, then mixes the result in linearly. Modes: normal, lighten, darken,
> multiply, divide, addition, subtraction, difference, average, geometric and harmonic
> mean, screen, overlay, soft light, hard light, chroma, luminance, red, green, blue.
> Each kind blends in its space: before filmic scene-referred (linear Rec.2020), after
> it (LUTs) on encoded sRGB with W3C's formulas. Scene-referred, the fulcrum (EV from
> middle grey) is the value a mode leaves unchanged, not Ansel's gain on `b`: multiply
> `a·b/f`, divide `a·f/b`, and screen/overlay/soft/hard light run the display formulas
> on `x / (x + f)` (0 … ∞ onto 0 … 1, `f` at 50 %); the arithmetic modes otherwise
> follow Ansel's `blendif_rgb_jzczhz.c`. A mask with only a blend mode is active. LUTs
> are maskable: their ranges are measured on filmic's input (so EV and hue mean the
> same), and the leading LUTs whose mask is uniform (opacity, invert, blend: no shapes
> or ranges) stay baked into filmic's table; from the first one with shapes or ranges
> on, they run per pixel (~+190 ms at 2400 px native, like the exact LUT path). A
> spatial module's blend is part of its detail key; a point module's isn't spatial. Cost
> at 2400 px: a soft-light masked exposure +8 % over a normal one. Golden recipe
> `blend.json`. Not done: a swap of input and output (Ansel's "reverse"), hue/colour
> modes keeping lightness, and linear/vivid/pin light.

### 4.12 Glow: bloom and halation (M, after 4.11)

> **Done** (`ops/glow.rs`, `params::Glow` ↔ `glow`, the Glow section of
> `ModulePanel.tsx`, built-in presets bloom, halation, mist and black mist). As
> planned below, plus: the Gaussians are computed on reduced copies of the bright pass
> (2×2 averages, as long as they stay 1.5 px wide there; sigma corrected for what the
> averaging and interpolation add), aligned on the whole frame so regions match
> (`GlowOp::apply` takes the image's origin), and only around the pixels above the
> threshold. Clipped highlights are only +2.6 to +3.4 EV over grey before exposure, so
> the light above a threshold is small: defaults are threshold +1.5 EV, strength 1.5
> (0 … 5, typing up to 20). Cost at 2400 px: ~90 ms (~25 ms at the draft size), on top
> of the other spatial stages, which re-run with it. Golden recipe `glow.json`, a
> region case, `bench.rs` cases. A falloff (-1 … 1) weighs the four Gaussians, from a
> tight halo (the narrowest 64× the widest) to a long tail; 0 weighs them equally. The
> threshold's soft knee is labelled "Threshold softness": it's about which pixels glow,
> not the glow's shape. Not done: the later items below.

Light spreading out of the brightest parts of the image: bloom around lamps, windows
and specular highlights, film halation (a red to orange fringe), diffusion filters
(Pro-Mist, Black Pro-Mist) and haze around lights in fog or rain. It also makes a
clipped highlight read as a light source rather than a flat white patch.

None of the existing tools do it. A blur blended with lighten or addition spreads the
whole image (the "Orton" diffusion look), and a mask can only choose where the blurred
result lands, not which pixels give off light: the blur still reads everything.

- **Algorithm** (`ops/glow.rs`): a bright pass keeps what is above a threshold (EV over
  middle grey, on the brightest channel so saturated lights glow too) with a soft knee,
  keeping each pixel's colour; a long-tailed kernel (the sum of four Gaussians, one
  octave apart, up to the radius) spreads it; the result, tinted and scaled by the
  strength, is added to the image as light, in linear Rec.2020. The tint (hue,
  saturation) is normalised to luminance 1, so it changes the colour and not the
  amount.
- **Pipeline:** a spatial stage after the contrast equalizer, maskable (the mask says
  where the glow lands), with its `reach` for regions. Spatial stages run before
  exposure, so the threshold is measured before exposure: raising exposure doesn't
  make more of the image glow (the same as mask ranges on spatial modules). Moving it
  after the point modules would need a spatial stage after the point pass, which the
  worker pool can't do.
- **Overlap with 3.7 (diffuse and sharpen):** none in practice. Its "bloom" preset has
  no threshold and diffuses the whole image (a softening, like blur + lighten), its
  luminance threshold limits which pixels get diffused (for inpainting highlights),
  and it replaces the image rather than adding light. When it's ported, its preset
  should be called something like "soft diffusion", so there aren't two blooms.
- **Presets:** bloom, halation, mist, black mist.
- Later: other kernel shapes (anamorphic streaks, starbursts), energy conservation (take
  the light that glows away from its source).

### 4.6 Tone curve (M, before 1.0)

> **Done** (`ops/tone_curve.rs`, the tone curve section of `ModulePanel.tsx`). As built:
> Ansel's `rgbcurve.c` model (RGB linked or independent; linked either per channel or
> scaling the pixel by `curve(norm) / norm`, with Ansel's norms), drawn like its tone
> equalizer: each curve is an exposure offset (±2 EV, flat at 0 by default) at 9 input
> exposures evenly spread over the instance's `range` (−9 to +3 EV around middle grey
> by default), so raising a node brightens those tones. The wand fits the range to the
> module's input (`Developer::tone_curve_input`: all but the darkest and brightest
> 0.5 % of what the curve reads, on the whole-frame preview), as the tone equalizer's
> mask compensations do; it's stored, not measured per render, so regions and exports
> match. The editor shows that input's histogram behind the curve, measured again
> 500 ms after commits that change what comes before the instance (not during drags:
> the worker is serial); refitting is left to the user so nodes don't move under an
> edit. Independent channels get a histogram each (on a common scale; the fit is
> shared). A "show on the image" toggle (`Overlays::tone_curve`) paints what the curve
> reads in grey, black at the first node and white at the last, and tints the tones
> the selected node controls like a mask. It's the contrast equalizer's Catmull-Rom (`equalizer::curve`
> ↔ `curveAt`), so `CurveEditor.tsx` draws exactly what renders; past the end nodes the
> offset stays the end node's. Unlike the tone equalizer it's global (no guided
> filter), and a steep falling curve can invert tones. Norms are scaled so that a
> grey's is its value: "sum" became "average" and is left out, "norm" is ÷ √3. Each
> curve is baked into a gain table over the float bits (`BitsLut`, 256 per stop); it
> runs last before filmic, in the fixed chain, and is maskable. Cost: ~+3 % on a full
> point render at 2400 px (native). Built-in presets: "Contrast: low / medium / high",
> "Lift shadows" (they don't set the range). Golden recipe `tone_curve.json`. A
> strength (0 … 200 %, 2026-11-10) scales the offsets in EV, baked into the tables. Not
> done: a histogram before the instance has been created (the wand creates it), picking
> a node from the image, and a local (edge-preserving) variant like the tone
> equalizer's (see 4.10).

Based on Ansel's or darktable's `rgbcurve.c` (or the older `tonecurve.c`). A point module
before filmic, in scene-referred linear (curve on log-encoded values, like the
equalizer's curves), with RGB / luminance-preserving modes. It's baked into a lookup
table in `PointOps::new`, and the editor reuses `CurveEditor.tsx`. Maskable.

### 4.7 Colour balance RGB (L, before 1.0)

> **Done** (2026-11-08), merged with Ansel's split-toning rgb into one `colorBalance`
> module replacing colour (saturation/vibrance) and shadows/highlights (v7 recipes):
> master tab (hue shift, vibrance, chroma/saturation/brilliance globally and per range),
> a CAT16 temperature and channel mix per range (calibration's mixer views), and ranges
> as two logistic steps whose weights add up to 1, with a graph and an overlay. Left out
> on purpose: the 4 ways (the mixers tint) and contrast (the tone curve). Left: the
> perceptual path's speed (`docs/PERFORMANCE.md`), a white fulcrum picker.

A port of `colorbalancergb.c`:

- lift/gamma/gain and offset/power/slope wheels;
- chroma, saturation and vibrance per luminance range;
- contrast around a fulcrum;
- perceptual saturation in its UCS space.

A point module before filmic, and maskable. The per-pixel maths has powers and colour
space conversions, so it needs LUTs or a fitted approximation to respect the point-op
budget. Tabs (master / 4 ways / masks) become `PRESET_GROUPS`, and colour wheels are a
new UI control.

### 4.8 3D LUT (M, before 1.0)

> **Done** 2026-11-13. The pipeline side (`ops/clut.rs`, the `lut` kind in
> `params.rs` ↔ `params.ts`, the stage after filmic in `ops/point.rs`, baked into
> filmic's interactive table, wasm `parseLut`/`loadLut`). Measured at 2400 px: the
> table bakes in at no extra cost per render; the exact path (filmic drags, final
> renders, exports) adds ~85 ms per 3.8 MP single-threaded (tetrahedral; branch-bound,
> not memory-bound: a 2³ LUT costs the same). Server: `luts`/`user_luts` (migration
> 00007), `/api/luts` (list, upload of the packed form, rename, hide) and
> `/api/luts/:lutId/data` (public for built-ins), renders load the recipe's LUTs the
> owner may use. Five built-ins in `packages/pipeline/luts/`. Web: the LUT section's
> picker previews the highlighted LUT (`useRecipePreview`, shared with module presets
> and now styles), adds files (decoded in the pipeline worker, uploaded packed, or kept
> in IndexedDB without an account) and removes them; the backend sends each table once
> and the pipeline worker keeps the LUTs of recent recipes loaded (in its pool too).
> Each LUT's thumbnail in the picker: done. Renaming: done 2026-11-11, in a manager
> dialog ("Manage LUTs…" in the picker; `develop/ManagerDialog.tsx`, also used by the
> preset and style menus). Masks, opacity and blend modes: done with 4.11. LUTs added
> without an account stay in that browser: the developer only offers "Add to library"
> when signed in, and then picks from the account's LUTs, so a recipe never refers to a
> browser-only LUT there (they aren't moved to the account on sign-in either). Storage
> quotas (7.5) count original files only, not LUTs.

Following darktable's `lut3d.c`: `.cube` (3D) and Hald CLUT PNG/TIFF (8/16-bit), with a
choice of interpolation (tetrahedral, trilinear, pyramid).

- **Pipeline:** display-referred sRGB LUTs only for now, after filmic, several instances
  allowed. Filmic's display-linear output → LUT input space (sRGB) → LUT → output space,
  so P3/Rec.2020 exports stay right (colours beyond sRGB clip before the LUT). Interactive
  renders can fold the chain of LUTs into filmic's 65³ table; exports use the exact path.
  Log-input `.cube` (S-Log3, LogC…) later: the LUT record stores its `input_space` from
  the start.
- **No strength parameter:** opacity and blend modes come from the planned mask/blend
  feature, which then has to cover kinds after filmic too.
- **Recipe:** `{ lut: { id: <sha256>, name }, interpolation }`. A missing LUT renders as
  disabled, with a warning naming it.
- **Storage:** parse in Rust (browser and server), decode to a canonical form (grid size,
  bit depth, domain, input space, table at its own depth) and hash _that_, so re-encoded
  files deduplicate. Global `luts (sha256, …, storage_key)` blobs, gzipped, and per-user
  `user_luts (owner_id, lut_sha256, name, hidden_at)`. Access: built-in, or a
  `user_luts` row. Always upload and deduplicate server-side (no "already known" shortcut,
  which would reveal other users' files); quota counts the full size per user. Deleting
  hides the row (history still refers to the hash); a job removes unreferenced blobs.
- **Built-ins:** a manifest of hashes served as static assets (so `/develop` has them).
  Same hash space as user LUTs: adding a built-in that users already uploaded changes
  nothing for them. Built-ins are never removed from the manifest, only retired from the
  picker, and never re-encoded in a way that changes the table.
- **Public developer:** custom LUTs stay in IndexedDB, keyed by the same hash.
- **Initial built-ins:** a few from the RawTherapee Film Simulation collection (CC BY-SA
  4.0, credits needed; Hald level 12, sRGB), named by feel rather than brand. They add
  15–37 % midtone contrast on top of filmic, so they're looks to pick, not defaults.

### 4.9 Frame (S–M, before 1.0)

> **Done** as an export option rather than a module (`crates/pipeline/src/frame.rs` ↔
> `packages/pipeline/src/frame.ts`, `ExportDialog.tsx`). A frame isn't part of the look
> and nobody needs it while developing, so it stays out of the recipe: it's applied
> to the encoded sRGB render, and previews, regions, overlays and shapes don't know
> about it. As built: a border (fraction of the photo's shorter side), an optional
> aspect ratio of the framed image (the crop tool's list: XPan, A-series paper and custom,
> which accepts paper sizes such as A4 and starts from the current ratio;
> the image's orientation or forced portrait/landscape) with the photo's position in
> the extra space, a colour (white,
> grey, black or any), and an optional line around the photo (width, gap, colour).
> The framed image fits the export size: `frame::fit` searches for the widest photo
> that fits (`tests/frame.rs`). The export menu became a dialog with a preview drawn
> from the developer's canvas; the settings are remembered (`localStorage`), so a
> series gets the same frame, and 8.4 batch export can reuse them. Not done: picking
> the colour from the image, and per-photo frames (styles can't carry it). A "show
> frame" view while developing could come with editor layout options, next to the
> Ctrl/⌘+B assessment mode, if it turns out to be wanted.

Borders for export, like darktable's `borders.c` ("framing"):

- border size as a fraction of the shorter side, or a target aspect ratio;
- position of the image within the frame;
- colour (with an image picker);
- an optional thin inner line.

The last stage, display-referred, and not maskable. It changes the output size, so
check region renders, clipping indicators, overlays and shapes (they map to the image
inside the frame). It could be shown only on export and in a "show frame" preview.

### 4.10 Tone equalizer (L, after 4.6, before 1.0)

> **Done** (2026-11-08) as a mode of the tone curve rather than a new kind: the two
> overlapped almost entirely (same nodes, editor, histogram, wand and overlay), so the
> module is shown as "Tones" (the kind stays `toneCurve`) and gets a "Preserve detail"
> switch (`preserveDetail`, with `smoothing` and `edgeRefinement`). Off, it's the global
> curve as before (all RGB modes; golden images unchanged). On, the curve is linked and
> reads Ansel's EIGF-smoothed mask of a norm (`ops/tone_curve.rs`, `Local`), whose
> histogram and overlay the editor then shows. The global curve stays for contrast
> (a local curve moves areas and keeps their texture) and per-channel looks.
> Pipeline: the mask's statistics (smoothed local mean and variance of the norm) are
> computed with the point masks (`PointMask::Tones` in `PointMasksKey`, so
> `is_spatial_cached` covers them), from samples of the module's input every 4 px,
> jittered by a hash so regular textures don't alias, in cells aligned on the frame
> (regions match, `Local::reach` pads them). They travel as two planes
> (`tone_curve::plane_ids`) to the point pass, which blends them with the pixel's norm
> (EIGF's last step), so the pool works unchanged. Measured at 2400 px (native, single
> thread): node drags +3 % over a global curve; edits before it (exposure…) +10 % for
> the statistics, where computing the whole input would have doubled the frame. The
> input of masks and tone curves is now built with the cached colour primaries tables
> (`PointOpsCache::input_ops`). Golden recipe `tones_local.json`; built-in presets "Lift
> shadows" (now preserving detail), "Compress highlights", "Compress dynamic range"; the
> contrast presets turn it off. Not done: Ansel's quantization, iterations, averaged
> (geometric mean) filters and mask contrast compensation (the node range and the wand
> do its job); picking a node from the image.

A port of Ansel's `toneequal.c`: exposure corrections by tone, like the tone curve, but
read from a smoothed luminance mask instead of each pixel's own value. Lifting the
shadows then moves a whole shadow area by about the same number of stops and keeps
the texture inside it (the tone curve flattens or stretches it). That makes it the tool
for compressing dynamic range, and it replaces the README's "shadows/highlights is
global" gap.

- **Mask:** luminance (one of Ansel's norms) blurred by a guided filter on log
  luminance, edge-aware, with Ansel's controls: smoothing radius, edge refinement,
  mask exposure and contrast compensation (the wand already fits these for the tone
  curve, see 4.6). Masks' feather has a guided filter on log luminance to start from.
- **Pipeline:** the mask is spatial, so it's computed with the spatial stages on the
  module's input (the point modules before it, as `Mask::feathers_whole` does) and
  cached by its own key, which must go into `is_spatial_cached` so the pool doesn't
  render a stale one. The correction itself (mask → gain) is a point op with a lookup
  table, and must stay in the fused pass and the pool. Regions need the filter's
  `reach`, and the radius is a fraction of the frame, not the region.
- **UI:** the tone curve's editor (`CurveEditor.tsx`, nodes as EV offsets over a range,
  histogram behind, "show on the image" toggle), with the histogram of the mask rather
  than of the pixels, and a mask preview. Picking a node from the image is more useful
  here than on the curve.
- Maskable, a golden recipe, `bench.rs` cases (the filter at 2400 px and full size).
- Alternative: a "local" mode of the tone curve rather than a new kind. A separate kind
  is simpler to explain and keeps the tone curve's RGB modes out of it.

### 4.13 Mask UI redesign (M–L, before 1.0, needs a prototype)

The mask editor (4.5) is confusing and clutters the panel: a mask button in each
maskable module's header opens, inside the module, a switch, the shape tools, an op per
shape, up to seven range sliders with four handles, feather, opacity and invert. It
needs redoing for 1.0 so that it makes sense and stays out of the way.

- **Idea to prototype:** masks in a secondary sidebar next to the modules, showing the
  mask of the module being edited (or a list of the recipe's masks), so the module
  panel keeps only a mask indicator.
- Prototype it with 2.6 (keyboard-driven editing): both change how the panels are laid
  out and navigated.
- To work out with the prototype: which controls are shown by default (drawn shapes and
  a luminance range cover most uses) and which are behind an "advanced" disclosure; how
  the overlay modes (the mask, one range alone, what a range measures) are reached; and
  where mask presets (4.5's "not done yet") would fit.
- Format and pipeline stay as they are: it's a UI change.

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

### 7.1 Object storage backend (M)

> **Done** 2026-11-12 (`apps/server/src/storage/`, see `docs/DEPLOYMENT.md`). As built:
> an `ObjectStore` with a local-disk and an S3 implementation (`@aws-sdk/client-s3`,
> checksums only where required, for S3-compatible servers), chosen by `S3_BUCKET`.
> Keys are the old paths, so moving is `rclone copy`. Uploads still go to a local temp
> file first (hashing, duplicates never stored). Render and zoom workers read and write
> through the store; LUT files moved to `luts/files.ts` (no database import, for the
> workers). **Deviation:** no redirects to presigned URLs: bytes go through the server,
> so everything stays same-origin for cross-origin isolation (P.5). Tested by a
> contract test on both stores (CI runs S3 against `rclone serve s3`) and by hand
> end to end; not yet against OVH itself.

`photos/storage.ts` writes to local disk (`STORAGE_DIR`). Put it behind an interface
with two implementations: local disk (development and self-hosting) and S3-compatible
object storage.

- Same keys as today: originals by `storage_key`, renders by version id.
- Uploads stream to object storage while hashing, as they stream to a temp file today.
- `GET /api/photos/:id/original` and render URLs can redirect to short-lived presigned
  URLs instead of proxying the bytes through the server.
- Thumbnails and previews stay in the standard (hot) class: small and read constantly.

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

### 7.3 Backups and soft delete (S–M, after 7.1)

> **Soft delete done** 2026-11-13, as a trash (`photos/trash.ts`, `/settings/trash`): deleting from
> the library moves versions to the user's trash (`versions.trashed_at`), with an Undo in
> the toast and no confirmation. From the trash they can be restored, or deleted for good
> (a selection, or "Empty trash", confirmed). After 30 days the server deletes them (an
> hourly purge); a photo goes with its original once none of its versions is left. The
> trash counts towards the quota until then. Uploading a file that's only in the trash
> adds a new version to it. Postgres backups: nightly dumps, 30 days, to a bucket (done
> 2026-11-12). Left: a copy of originals with a second provider, and testing restores.
> Feedback the same day: the trash is the library's grid, selection, side panel (with
> when each item goes) and loupe (read-only), reached from a new settings page
> (`/settings`: storage split between the library and the trash, password change), and
> the toast links to it.

Multi-zone storage protects against losing a data centre, not against bugs, mistakes or
losing the account.

- Copy originals to a second provider (e.g. Scaleway Glacier or a Hetzner Storage Box).
  If the archive class works per bucket, use one bucket per month of imports.
- Soft delete: deleted originals are kept ~30 days before being removed (also in the
  backup), so an accidental delete or a bug can be undone.
- Postgres backups follow the same rule: in another provider or region, with restores
  tested.

### 7.4 Lazy re-renders (S–M)

Breaking look changes set `render_status = 'pending'` on every version (migrations
`00002`, `00004`), so the server reads every original again. With 7.2 that becomes a
bill for each migration and a slow queue.

- Re-render recently opened versions right away; mark the others stale and re-render
  them when they're shown in the grid or opened (a priority queue: visible first).
- Update the note in `CLAUDE.md` about migrations when this lands.

### 7.5 Quotas and usage (M, after 7.1)

> **Done** 2026-11-13, with invitations and admins (`apps/server/src/accounts/`,
> `pages/AdminPage.tsx`, migration 00012). As built: `users.storage_quota` in bytes,
> NULL unlimited (existing accounts). **Deviations:** only originals count (renders and
> LUTs don't; decided with the user), and usage is summed per request with an index
> (`photos_owner_size_idx`) rather than kept in a counter: cheap at this scale, and
> never out of step. Uploads over quota are refused before the file is stored and again
> under the user's row lock (concurrent uploads); the client skips files that can't
> fit before sending them. Lowering a quota deletes nothing. The app menu shows usage
> (red from 90 %, no separate warnings yet). Sign-up needs an invitation unless
> `ALLOW_SIGNUP=true` (`DEFAULT_STORAGE_QUOTA_GB` for those accounts): an invitation
> creates up to N accounts with its quota, can expire and be revoked. `/admin`
> (`users.is_admin`) is an overview of the instance, with tabs for `/admin/users`
> (quotas and admin rights) and `/admin/invitations`; the CLI makes the first admin
> (`user:invite`, `user:admin`). Billing and tiers come later
> (7.9) and will set quotas. Not done: the photo-count limit (7.8) and removing
> inactive free libraries.

- Count bytes per user (originals + renders), kept up to date on upload and delete
  rather than computed by summing on each request.
- Refuse uploads over quota with a clear message; show usage in the app, warn at 80 %
  and 100 %.
- A photo-count limit for libraries whose originals stay local (7.8).
- Free libraries that stay inactive for a long time are removed after notice.

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

## M8 — Library workflow (L overall, before 1.0)

### 8.1 Apply a preset or style to a selection (S–M)

> **Done.** As built: the library panel's palette button (one photo) or "Apply a preset or
> style to N" (several) lists styles (Apply or Append, once for the whole selection) and
> module presets by module; a module preset goes to the first instance of its kind.
> `POST /api/versions/recipes` gives the current recipes, and `POST /api/versions/history`
> applies history ops to many versions in one transaction (the per-version endpoint's
> logic, `applyHistoryChange`). Versions changed since they were read come back as
> conflicts and are read again (3 tries). Uploads not read yet are held back: their
> starting recipe (lens correction) isn't known. Chunks of 25 give the progress; the
> toast's Undo steps each version back (versions edited since are left alone). Recipes
> it wouldn't change get no entry.
>
> With one photo selected, hovering a style or preset previews it in the panel
> (`library/useEditPreview.ts`): opening the menu loads the original in the in-browser
> pipeline (~1.3 s for a 43 MB ARW, from cache or the local server; the download is most
> of it on a slow link), then each hover renders in ~150–200 ms (instant when seen
> before). Previews for a whole selection need small linear proxies per photo (stored
> with the renders): opening 30 originals would mean >1 GB of downloads. Proxies would
> also make the one-photo preview open at once; `openForPreview` is where they'd go.

Presets and styles are applied on the client and give a plain recipe. For a selection,
the client fetches each version's current recipe and applies the preset or style. It
then appends a history entry per version through a batch endpoint, in one transaction
that bumps `revision`. The render queue re-renders the previews.

- Undo per version through the history.
- A shared default when applying a style to a mixed selection: append or replace.
- Progress for large selections.

### 8.2 Folder, recursive and SD card import, skipping known files (M)

- **Browser first:** `<input webkitdirectory>` and drag and drop of folders are already
  recursive. Filter to supported RAW extensions.
- **Skip what's already uploaded before sending it:** the server only dedups by
  `sha256` after the upload (`photos/routes.ts`), which wastes bandwidth on 25–120 MB
  files. Add a "which of these hashes do I have?" endpoint, hashing on the client in a
  worker. A quick prefilter (name + size + capture date) avoids hashing a whole card
  each time.
- **SD cards:** a card is just a folder in the browser. Remember imported card volumes
  (DCIM path + file list) so a re-inserted card only shows new photos.
- **Local client** (only if needed): auto-import on card insertion or watched folders
  need a small desktop helper (Tauri, or a CLI). It shares the code with 7.8 (local
  originals).
- Resumable uploads, a queue that survives a reload, and a summary at the end
  (imported / skipped / failed).

### 8.3 Fullscreen preview for culling (M)

> **Done** (`library/Loupe.tsx`, `library/loupe.ts`, `render/zoom.ts` on the server). As
> built: a full-window overlay rather than the Fullscreen API, opened with Space/E or the
> Cull button. It walks the photos listed when it opened (plus later pages): a photo
> rated out of the library's filters stays until it closes. Ratings and flags move on
> with auto-advance (on by default, `A`, remembered); labels don't. The 2048 px
> preview shows at fit; a click or `Z` zooms to 100 % (the developer's `useZoom`, with
> a left click toggling), and the view stays from one photo to the next. Zoomed in, the
> server renders 512 px tiles of the current recipe (`GET /api/versions/:id/zoom` for
> the levels, then `/zoom/:level/:col/:row`), at 100 % or half sizes down to the
> preview's, on one worker that keeps the last RAW decoded and stops when idle: ~0.4 s
> for the first tile of a photo, ~65 ms each after that at 24 MP. Tiles out of view are
> aborted and dropped before they're rendered; the rest are cached under the recipe's
> revision. Not done: two-up (M5), browser-side tiles for the public developer.

A fullscreen loupe from the grid (Fullscreen API):

- arrow keys to move;
- shortcuts for rating, flag/reject and colour label, then auto-advance;
- zoom to 100 % on a key;
- a minimal overlay (filename, EXIF, rating).

Preload the neighbours' previews. Previews may need a larger size than the grid uses
(check the stored preview size, or decode the embedded JPEG from the RAW). This fits
with M5's compare (two-up culling of a burst).

### 8.4 Export from the library: one photo or a selection (M–L)

> **Done** 2026-11-11 (`export/bulkExport.ts`, `export/LibraryExportDialog.tsx`,
> `export/ExportProgress.tsx`, `lib/zip.ts`). As built: "Export N photos" in the info
> panel (an icon button for one photo) and Ctrl+E, in the library and the developer.
> The dialog is the developer's, with the focused photo's preview in the frame preview,
> no size estimate (it depends on each photo's crop), the first two file names, and a
> warning when names repeat (they get -2, -3…; it suggests `{version}`). The runner is
> a module-level store, so it keeps going across pages. An export is single-threaded,
> so it runs lanes (`export/lanes.ts`: a lane per four hardware threads, at most three,
> fewer for large photos so they stay within 4 GB together: one at 61 MP),
> each a pipeline worker without a pool (replaced after a failure, in case it's left
> without memory) that downloads its next original while one exports. Consecutive
> versions of a file go to one lane, which decodes the original once for them. Each
> lane holds a decoded photo and its full-size render (natively, a 24 MP JPEG export
> peaks at 0.9 GB, 7.3 s single-threaded). Each version's recipe comes from
> `/api/versions/recipes` (the recipe for the file when the server hasn't read it yet),
> with pending auto-tunes resolved. File names are given in the photos' order; ZIP
> entries are in the order they finish. One photo downloads as its file; several as a
> stored ZIP (ZIP64 when needed), written to a file in the origin private file system
> as each photo finishes (`export/spool.ts`; in memory where OPFS can't be written) and
> downloaded from there, so exported files (24 MP: JPEG 12 MB, 16-bit TIFF 129 MB, PNG
> 142 MB) don't pile up in memory. Firefox gives a site ~10 GiB of storage, so a large
> export is saved in parts of up to 2 GiB (`export/archive.ts`, `…-part1.zip`…), each
> downloaded when full; saving a part deletes the one before, so at most two are
> stored. Each export starts by removing what earlier ones left, except archives from
> the last 2 minutes (a download may still be copying them). If a write fails (disk full), the archive keeps what was written and
> the remaining photos fail, to be retried. `test:library` passes in Firefox too
> (`BROWSER=firefox`).
> The progress panel (bottom left, every page) shows n of N and the photos being
> exported, with Cancel; failures are listed when it ends, with Retry: the same
> settings and names, into a ZIP of its own (`…-retry.zip`). A download that fails with
> a network or server error is tried twice more first. Leaving the app while it
> runs asks first. `test:library` exports with a golden RAW. Fixed on the way:
> `/api/versions/recipes` gave a version undone to the original the auto-applied recipe
> rather than the plain default. Not measured yet: a large selection of 60 MP files
> (memory). Not done: the grid has no context menu to add it to.

Decided 2026-11-10: **in the browser, delivered as one ZIP**, with single-photo export
from the library built as part of it (not before). Server-side jobs wait for M6 (cloud
compute is planned as a paid option, and with 7.8's local originals the server doesn't
have the RAW).

- **Entry points:** "Export…" in the library's selection actions (and its context
  menu), with a shortcut (the developer has none yet: give both the same, e.g. Ctrl+E).
  One photo selected behaves like the developer's export: the file itself, no ZIP.
- **Dialog:** 8.5's `ExportDialog`, same settings, presets and last settings. With
  several photos: "Export N photos" as the title; sizes that depend on the photo are
  described rather than computed ("long edge 2048 px"); the file name pattern must give
  unique names, so collisions (versions of one file, `{name}` alone) get `-2`, `-3`… (or
  the dialog suggests adding `{version}`).
- **Rendering:** a runner outside the library page (so moving to the developer and back
  doesn't stop it) going through the photos one at a time in a pipeline worker: fetch
  the original as the developer does, decode, load the recipe's LUTs, resolve pending
  auto-tunes (8.7: `resolveAutoTunes` at `AUTO_TUNE_SIZE`, the values the server's
  previews use), export with the photo's metadata and the library's corrections
  (`photoExportInfo`), release the cache. Fetching the next original while one exports
  hides the download. One worker at a time to start with (a 60 MP decode is large);
  measure before trying two.
- **ZIP:** stored (JPEG/PNG/TIFF don't compress further), written as each file
  finishes into a `Blob` of parts so the browser can keep it out of memory, ZIP64 past
  4 GB, saved at the end. A small writer of our own (local headers, CRC-32, central
  directory) rather than a dependency.
- **Progress:** a progress panel in the app shell (n of N, the current photo, cancel);
  leaving the page warns (`beforeunload`). A photo that fails is skipped and listed at
  the end; the ZIP holds the others.
- **Later:** server-side jobs (the earlier plan: a `jobs` table, results in storage
  (7.1) behind a short-lived link, an in-app notification centre, email once the server
  sends any) for cloud-compute users, after M6 step 1; AVIF/JPEG XL.

### 8.6 Copy and paste edits (S–M, after 8.1)

> **Done** (2026-11-09, `develop/editClipboard.ts`). As built: a copy is a `StylePayload`
> with its source's name in `sessionStorage`. Ctrl+Shift+C (or "Copy settings…" in the
> Styles menu, or the library's palette menu) opens `CopyEditsDialog`, the style dialog's
> `StylePicker`; Ctrl+C copies what was picked last time (kept by instance id in
> `localStorage`; instances it never saw get the default, which leaves out geometry,
> retouch and lens). In the library the dialog lists the source's instances too (its
> recipe is fetched), not only kinds. Ctrl+V pastes (Ctrl+Shift+V: all appended), in the
> developer as one entry and on the library's selection through `runBatchEdit`;
> "Paste from …" in both menus is previewed. Ctrl+C is left to the browser while text is
> selected. Browsers bind Ctrl+Shift+C to their inspector: if one keeps it, the menu items
> are the fallback.

Copy part of a recipe from one photo and paste it onto others, in the developer and in
the library. It's a style that isn't saved: build it on 4.2's code rather than next to it.

- **Copy in the developer:** like "Create a style" (`CreateStyleDialog`): pick module
  instances (and, for kinds with `PRESET_GROUPS`, parts of them, like a module preset)
  — Ctrl+Shift+C opens the picker, Ctrl+C copies what was picked last time. Geometry,
  retouch and lens correction off by default (they belong to one image), as Lightroom
  and darktable do.
- **Copy in the library:** one photo's recipe, by module kind only (the grid shows no
  instances): the style picker's kinds. Ctrl+C on the focused photo.
- **Paste:** Ctrl+V in the developer (one history entry, "Paste from DSC01234") and
  on the library's selection, through 8.1's batch path (`runBatchEdit`, Undo toast).
  Hovering "Paste" previews it like a style (`useEditPreview`).
- **Where the clipboard lives:** the client, in `sessionStorage` (a `Style` payload and
  the source's name), so it survives going between the library and the developer.
  Carries the shapes it uses, renamed on paste (`styleFromRecipe`/`applyStyle` already
  do).
- Append vs replace: today's style submenu, until 8.8 settles it per module.

### 8.7 Auto-tune when applying a preset or style (M)

> **Done** (2026-11-09, `packages/pipeline/src/autoTune.ts`). As built, simpler than
> planned below: applying a module preset or style that asks for it marks the instance
> `autoTune: true` (filmic, tone curve: `AUTO_TUNE_KINDS`; in Rust too, which renders
> without looking at it). Whoever renders it next resolves it at a fixed size
> (`AUTO_TUNE_SIZE`, 2048 px, the library preview's) and clears the mark: the developer
> before committing (one entry), or on opening a photo still pending ("Auto-tune"); the
> server's render worker while rendering the preview, writing the values into the
> history entry it rendered (if still current and unchanged; no revision bump, like the
> lens-correction entry), and the loupe's zoom worker for its tiles until then. No values
> are stored next to the renders. Measured on 8 photos: white exposure and the tone
> curve's range are within 0.02 EV / 0.1 between 2048 px and full size, filmic's black
> exposure up to 0.5 EV (full size is darker: noise), and within 0.03 EV between 2048
> and 2400 px. The manual auto-tune and fit buttons measure at the same fixed size now.
> Resolving costs ~1.6 s per photo on the server. The save dialogs (module preset,
> style, copy) have a checkbox per tunable instance; "Lift shadows", "Compress
> highlights" and "Compress dynamic range" fit their range. Left: hover previews (library
> and developer) show the preset before its auto-tune.

A preset or style can ask for its modules' auto-tunes to run once applied: filmic's
white/black exposure, and the tone curve's "fit the nodes to the image" wand (which
would make "Lift shadows" lift the right tones on every photo). Stored in the payload
(`autoTune: ModuleKind[]`, normalised like the rest), with a checkbox per tunable module
in the save dialogs.

- **Developer:** apply, then run the auto-tunes on the result (they already run on the
  worker: `autoTuneFilmic`, `onFitToneCurve`), as one history entry. The auto-tunes must
  be pure functions of (recipe, image) so the result doesn't depend on the zoom or the
  preview size: measure on the same fitted preview each time.
- **Library (8.1): on the server, lazily** (decided 2026-11-09). A recipe can hold an
  auto-tune that isn't resolved yet (`autoTune: pending` on the instance, normalised in
  both languages and ignored by `normalize`'s equality), whose values the server's
  preview render computes on its reduced pipeline (the binned base it already renders
  previews from) and stores next to the renders, keyed by the recipe's revision. The
  library's previews, the loupe's 100 % tiles and exports reuse those values, so no
  full-size pass is needed. The developer resolves it exactly once the original is
  loaded, on the full-size preview, and writes the result as a history entry (or folds
  it into the next one): that's when the slider values become known.
  To check before building it: how far the reduced-pipeline values are from the
  full-size ones (filmic's white/black exposure should be close; the wand's node range
  depends on the extremes, which binning softens); what an export started from the
  library uses (the stored values, so it matches the preview); what a style applied on
  top of a pending auto-tune does (re-tune, since the input changed); and what undo
  shows for an entry whose values were filled in later.
- Later, the same flag on 4.2's auto-apply rules, so new uploads can start auto-tuned.

### 8.8 Append or apply per module in styles (S–M)

> **Done** (2026-11-09). As built: each `StyleInstance` has a `mode` (missing in older
> styles: `replace`); the k-th `replace` instance of a kind takes the place of the
> target's k-th instance (keeping its id), or is added. The style dialog (`StylePicker`,
> shared with 8.6's copy) sets the mode per instance and, for kinds with `PRESET_GROUPS`,
> which parts to take: a partial instance always replaces and is applied onto the
> target's instance like a module preset (its mask stays). Shift while selecting a style
> (`useShiftKey`, in both menus, also for the preview) appends everything that can be
> appended.

Today a style is applied with "Apply" (replace the instances of its kinds) or "Append"
(add them), chosen in a submenu each time. Instead, each instance in a style would
carry its own mode, set when the style (or the copy, 8.6) is made: a masked exposure
vignette always appends, a filmic look always replaces. The menus lose their submenu,
and paste becomes one action.

- **Default:** "append" for an instance that isn't its kind's first in the source
  recipe, "apply" otherwise; editable per instance in the save dialog.
- **Format:** `mode: 'replace' | 'append'` per style module, normalised (missing =
  today's behaviour of the menu entry used, i.e. replace); single-instance kinds always
  replace. Rust doesn't see styles, so TS only (`normalizeStyle`, `applyStyle`).
- **Decided (2026-11-09):** "apply" replaces only the target's _first_ instance of the
  kind (today's "Apply" removes them all: `applyStyle`), the others stay; a style with
  two instances of a kind replaces the first two. A hidden power-user modifier
  (Shift+click, or Shift+Enter) appends everything.

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

---

### 8.5 Export options (M, before 1.0) — done

The export dialog has, on top of 4.9's frame and the size:

- **Formats:** JPEG, and PNG and TIFF (deflate, predictor) in 8 or 16 bits.
- **Output colour space:** sRGB, Display P3, Adobe RGB, Rec.2020 (`output::ColorSpace`).
  Filmic's gamut mapping targets the chosen primaries (as Ansel does with the export
  profile), and the file embeds a generated v2 ICC profile (`export::icc`), sRGB's too.
  Previews and golden tests stay sRGB.
- **Metadata:** EXIF (camera, lens, exposure, date and offset, GPS) from the file's
  metadata with the library's corrections, and XMP (title, description, rating, label,
  keywords, creator, rights). All, all but location, copyright only, or none.
- **Size:** full, long edge, short edge, width × height, megapixels; the frame is
  included. **Output sharpening** (low, standard, high) at the export size.
- **File names:** a pattern (`{name}`, `{version}`, `{date}`, `{time}`, `{title}`,
  `{camera}`, `{lens}`, `{iso}`, `{rating}`), in `exportFilename`.
- **Export presets** and the last export's settings are per user, on the server
  (`export_presets`, `users.export_settings`); without an account, the last settings
  stay in `localStorage`.

Left for 8.4: AVIF/JPEG XL, and running these settings over a selection.

## M9 — Branding (M, before 1.0)

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
  code from before retouch too. Find what the main thread does in those drags (likely
  their sections' restyling) or revisit the budget.
- **Ansel parity:** for each port, record the upstream commit it follows (as
  `filmic.rs` does) and keep a short "deviations" list.
- **Licensing:** filmic, colour primaries, the contrast equalizer and lens correction
  are or would be ports of GPL-3.0-or-later code, so RAWtisserie should be
  GPL-3.0-or-later (or AGPL-3.0 if network use should also share changes — relevant
  once cloud processing exists). The lensfun database is CC-BY-SA 3.0 and needs
  attribution.

## 1.0 release scope

Required before 1.0, on top of what's done:

- **Modules:** 3.5 raw denoise (AI), 3.6 lensfun, 3.7 diffuse and sharpen, 3.8 perspective /
  vertical alignment, 4.6 tone curve, 4.7 colour balance RGB, 4.8 3D LUT, 4.9 frame, 4.10 tone equalizer (guided mask).
- **Library:** 8.1 presets on a selection, 8.2 folder/SD import skipping known files,
  8.3 fullscreen culling, 8.4 export from the library (in the browser, a ZIP), 8.5
  export options (colour space/ICC at least).
- **UI:** 4.13 mask UI redesign.
- **Branding:** M9.
- Not yet decided for 1.0: M5 compare, M6 cloud processing, the M7 hosted-service items
  (7.1 is needed for a public hosted launch anyway), 4.2 auto-apply rules.

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
6. 1.0 work, quick wins first: ~~8.1 presets on a selection, 4.6 tone curve, 4.9 frame, 8.5 export options,
   8.3 culling~~. Then ~~4.7 colour balance RGB~~, ~~4.8 3D LUT~~, ~~4.10 tone equalizer~~, ~~3.8 perspective~~, 3.6 lensfun,
   ~~3.7 diffuse and sharpen~~, 8.2 folder/SD import, ~~8.4 export from the library (in the
   browser)~~ (server-side jobs after M6 step 1). 4.13 mask UI redesign once prototyped,
   with 2.6. 3.5 denoise starts with a spike (port the executor,
   bench it in wasm, decide previews) and can run in parallel. M9 branding can be done any time before launch.
7. M5 compare.
8. M6 cloud processing. Move it earlier if slow-hardware users are a near-term priority;
   step 1 (the native renderer) is useful on its own (and helps 8.4 and 3.5).
9. M7 hosted service, before opening sign-ups: 7.1 → 7.3 → 7.4 → 7.5 (and 7.6 with it),
   then 7.9. 7.2 and 7.7 once storage and database costs are worth the complexity; 7.8
   can start any time (it doesn't need 7.1); 7.10 only at a few hundred TB.
