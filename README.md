# 🍗 RAWtisserie

**From raw to well done.**

RAWtisserie is a web-based photo library and RAW developer, inspired by
[Ansel](https://ansel.photos) and [darktable](https://www.darktable.org).

- **Library**: every photo you own, filterable by EXIF metadata (camera, lens, ISO,
  focal length, aperture, date), tags, rating, flags and colour labels. Cull with the
  keyboard (rate, pick/reject, label, delete) and correct metadata. Originals are never
  modified; edits live in the database. Each photo has one or more _versions_ (like
  darktable duplicates), each with its own rating, labels and edit history.
- **Developer**: lens correction from the camera's embedded data (Sony, auto-applied to
  new imports), exposure, colour calibration (white balance by chromatic adaptation and
  channel mixing), saturation and vibrance, shadows/highlights, colour primaries and a
  contrast equalizer (ports of Ansel's), filmic tone mapping (a port of Ansel's filmic
  rgb with its AgX colour science), sharpening, blur,
  rotation/flip, straightening and cropping. The image sits on a
  neutral grey surround, with an ISO 12646 colour-assessment frame on Ctrl/⌘+B, and
  display (O) and sensor (Shift+O) clipping indicators. Zoom with the mouse wheel or a
  touchpad pinch (fit to 800 %), middle click for 100 % at the pointer (again for fit),
  and drag to pan. Module presets (built-in and
  your own, optionally limited to part of a module, e.g. colour calibration's mixer) and
  styles (a set of modules to apply to other photos) are in each module's header and
  the toolbar, and can be applied to a whole selection from the library.
  JPEG export at full resolution or a chosen long edge, at a chosen quality, optionally in a frame (border,
  aspect ratio, line around the photo). It runs **in your browser** on a WebAssembly
  build of the pixel pipeline.
- **Headless rendering**: the same WebAssembly module runs on the server (in worker
  threads) to render thumbnails and previews from your saved edits.
- **Public developer**: `/develop` works without an account. Files are processed
  locally and nothing is uploaded.

## Architecture

```
crates/
  pipeline/        Rust: RAW decoding (rawler), demosaic, scene-referred pipeline, JPEG encoding
  pipeline-wasm/   wasm-bindgen bindings (one .wasm for the browser and Node)
packages/
  pipeline/        @rawtisserie/pipeline: TS types (EditParams, PhotoMetadata) + wasm loaders
apps/
  server/          @rawtisserie/server: Fastify + Postgres (@databases), auth, uploads, render queue
  web/             @rawtisserie/web: Vite + React + Chakra UI v3 (library + developer)
```

### The pixel pipeline

The pipeline is scene-referred: pixels stay linear, unbounded floats in a linear
Rec.2020 working space, and are only compressed to display range by the tone mapper
at the end.

```
RAW ─▶ decode ─▶ demosaic/bin ─▶ D65 white balance ─▶ camera → Rec.2020   cached: base (per binning factor)
    ─▶ retouch spots (heal, clone, fill, blur), in place on the base        cached: with the base
    ─▶ geometry (lens, orientation, straighten, crop, resample)             cached: per output size
       └ drawn parts of masks, through the same geometry, feathered          cached: per output size
    ─▶ blur ─▶ sharpen ─▶ contrast equalizer                                cached: per output size
    ─▶ exposure ─▶ colour calibration ─▶ saturation/vibrance ─▶ shadows/highlights
    ─▶ colour primaries ─▶ filmic (AgX) ─▶ sRGB                             one fused pass, always re-run
```

Each cached stage is keyed by the parameters it depends on, so a slider only re-runs
the stages after it. Exposure, white balance, colour and tone sliders only re-run the
fused per-pixel pass. It works on 64-pixel chunks, one module at a time, so that the CPU
overlaps pixels and branch-free modules (colour calibration) vectorise. Its curves are baked into lookup tables indexed by the top bits
of the `f32` value (log-spaced, no `log`/`pow` per pixel). For interactive renders,
filmic's whole colour transform is also baked into a 65³ 3D table over log-encoded RGB,
built once the filmic settings stop changing. It stays within 1 level (8-bit) of the
exact computation for 99.9 % of pixels. Exports and thumbnails always use the exact path.
Colour primaries uses a 64³ table too. Moving a colour rebuilds it from cached anchor
weights, and only the nodes the changed anchors reach (~9 ms native); gamut coverage and
smoothing rebuild the weights (~100 ms, 19 MB). Blur and sharpen come before the per-pixel stages:
exposure, white balance and saturation are linear, so the order doesn't change the
result. The contrast equalizer works on log luminance, so exposure doesn't affect it either. Two output sizes are cached: a ~0.5 MP draft and the full preview size.

While a slider is being dragged, the UI asks for a draft. If the full-size spatial
stages are already cached (any colour or tone slider), the pipeline worker renders full
size instead and splits the per-pixel stages across a pool of workers
(`develop/pointPool.ts`), each holding a strip of the cached image. Only spatial edits
(geometry, blur, sharpen, equalizer curves) fall back to the draft. See
[docs/PERFORMANCE.md](docs/PERFORMANCE.md) for measurements and what didn't work.

Zoomed in, the developer renders only the visible region at the zoom level (at most
100 %). Only the photosites under it are developed, in a cached "patch" of the base
image, and the spatial stages get a margin around it so that its pixels match a render of
the whole image. Meanwhile the fitted render is enlarged with a CSS transform, so the wheel
and panning respond at once; the region follows 150 ms after the view stops moving.

Previews bin photosites ("superpixel") down to roughly the output size instead of
demosaicing at full resolution. Spatial parameters (blur and sharpen radii) are
expressed in full-resolution pixels, so previews match full-size exports.

`cargo run --release --example bench -- photo.ARW 2400` prints timings for typical
interactions. `npm run test:perf -w @rawtisserie/web` measures slider drags in a real
browser on the production build (UI frame rate, main-thread load, input latency, image
updates per second) and fails over budget. It needs `npm run build:wasm`,
`./scripts/fetch-golden-raws.sh` and `npx playwright install chromium`.

Edit parameters are a versioned JSON recipe (`crates/pipeline/src/params.rs`, mirrored
in `packages/pipeline/src/params.ts`): a list of module instances
(`{ id, label, enabled, kind, params, mask? }`). The pipeline order is fixed by module kind, and
instances of the same kind run in list order. Every field has a default, and older
recipes (one section per module) are migrated when they're read. Drawn shapes (ellipses,
gradients, Bézier paths, brush strokes) sit next to the modules in `shapes`, by id, and
retouch spots and masks refer to them (`crates/pipeline/src/shapes.rs` ↔
`packages/pipeline/src/shapes.ts`).

## Getting started

Prerequisites: Node ≥ 24, Rust (stable) with the `wasm32-unknown-unknown` target,
`wasm-bindgen-cli` **0.2.129** (it must match the crate version), and podman or docker.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked

cp .env.example .env
npm install
npm run db:up        # Postgres on localhost:5433 (podman/docker)
npm run dev          # builds the wasm, then runs the API (:4000) and Vite (:5173)
```

Open http://localhost:5173 and create an account. Migrations run automatically on
server start; `npm run db:migrate` runs them by hand.

### Useful commands

| Command                                                                      | What it does                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run build:wasm`                                                         | Rebuild the WebAssembly pipeline (`packages/pipeline/wasm`) |
| `npm run build`                                                              | wasm + production web build (served by the API server)      |
| `npm test`                                                                   | Rust tests + TS tests                                       |
| `npm run typecheck`                                                          | TypeScript in every workspace                               |
| `npm run db:schema -w @rawtisserie/server`                                   | Regenerate DB types into `apps/server/src/__generated__`    |
| `cargo run --release --example develop -- in.ARW out.jpg 2048 [params.json]` | Develop a file from the CLI                                 |

`RAWTISSERIE_SAMPLE=/path/to/file.ARW npm test -w @rawtisserie/pipeline` also runs a
real decode-and-render through the wasm module.

The Rust tests include **golden-image tests** (`crates/pipeline/tests/golden.rs`): six
reference RAWs from different brands ([raw.pixls.us](https://raw.pixls.us), CC0) are
rendered with each recipe in `tests/golden/recipes` and compared with the PNGs in
`tests/golden/expected` (CIEDE2000; mean ≤ 0.15 and 99.9th percentile ≤ 1). Run
`./scripts/fetch-golden-raws.sh` once to download the RAWs (~140 MB, gitignored). When a
change is meant to alter the look, re-bless the references with
`GOLDEN_UPDATE=1 cargo test --release -p rawtisserie-pipeline --test golden`, then
check the new PNGs in the diff. On failure, the actual render and a ΔE heatmap are
written to `target/tmp/golden/`.

### Production

`npm run build && npm run start -w @rawtisserie/server` serves both the API and the
built web app from port 4000. Set `COOKIE_SECURE=true` behind HTTPS, and
`ALLOW_SIGNUP=false` once your accounts exist. Originals and renders are stored
under `STORAGE_DIR`.

### Filmic

`crates/pipeline/src/ops/filmic.rs` ports Ansel's `filmicrgb`, limited to what Ansel ships
by default: the v3 spline with "perceptual" sigmoid toe and shoulder, auto hardness,
and colour science v8 "AgX" with all five bleach variants. Highlight reconstruction,
deprecated in Ansel, is left out. Defaults match Ansel's for RAW files (white +3.15 EV,
black −8.85 EV, contrast 1.18, latitude 10 %, medium bleach) together with the +0.7 EV
exposure default. One deviation in the controls: Ansel's latitude and shadows/highlights
balance are replaced by independent **toe** and **shoulder** settings (the linear share of
each side of middle grey; higher means more contrast); toe = shoulder = 10 % is Ansel's
latitude 10 %, balance 0.

**Auto-tune** follows Ansel's `autoset`. It measures filmic's input over the image as
displayed (after crop): white relative exposure from the brightest max(R, G, B), black
from the darkest luminance, both scaled by _dynamic range scaling_. The one deviation
is that the extreme 0.01 % at each end is ignored, so a few noisy or hot pixels can't
decide the range.

### Colour calibration

`ops/calibration.rs` ports Ansel's `channelmixerrgb` ("color calibration"), the way Ansel
does white balance: the base image is balanced with the camera's _reference_
multipliers, which make D65 light neutral, and colour calibration adapts the scene's
light to D65 with CAT16 (or linear Bradford, XYZ, or none). Every recipe starts with an
instance set to the **as-shot** light, which follows the file; the illuminant can also be
daylight or black body at a temperature, a CIE standard (A, E, F1–F12, LEDs), a custom
hue/chroma, or detected from the image (Ansel's "surfaces" and "edges", which are rough
guesses). It also does gamut compression and mixing in the adaptation's space: channel
mixer, colourfulness, brightness and grey (monochrome). The channel mixer can also be
edited as primaries, as in Ansel (`packages/pipeline/src/mixer.ts`): each input
channel's hue and purity plus the white's hue, purity and gain, or a white-preserving
rotation and saturation per channel. These views read and write the same 3×3 matrix; a
mix that shifts the white can be reduced to its white-preserving part. Blown highlights are clipped at
the as-shot white in the base stage, so they stay neutral. Deviations from Ansel, mainly
from the D65 working space, are listed in the module. Recipes from before v6 had
warmth/tint instead; it is folded into the channel mixer when they're read.

### Colour primaries and contrast equalizer

`ops/primaries.rs` ports Ansel's `colorprimaries` (and the parts of `colorequal_shared`
it uses): six control colours edited in dt UCS hue/saturation/brightness, spread over
all colours by a local field around the grey axis of HLG-encoded Rec.2020, baked into
a 3D table. The one deviation: the table stores each colour's linear change, which
skips the HLG decode per pixel and leaves colours outside the edits' reach untouched.
It is as close to the exact field as Ansel's table.

`ops/equalizer.rs` follows Ansel's `atrous` (contrast equalizer): an edge-aware à-trous
wavelet decomposition with per-band gain and denoise curves over detail size, from 5 px
to a fifth of the image. It deviates for speed: it decomposes log₂ luminance and colour
relative to luminance instead of Lab, so exposure only shifts the residual, and each
5×5 edge-aware filter is applied as a row pass then a column pass. Luminance and colour
are decomposed separately, and a neutral one is skipped. Thresholds and edge weights
are converted from Lab units at about 12 L* per EV and 50 a*b* per unit of colour.

### Retouch

`ops/retouch.rs` follows Ansel's `retouch` and `heal`: spots heal (copy the source, then
blend it into the target's surroundings with a Laplace solve on square roots), clone,
fill with a colour, or blur. They work on the base image, in the sensor frame, so they
stay put when the crop, rotation or lens correction changes. The base is retouched in
place, and each spot keeps the pixels it overwrote, so moving a spot only redoes the
spots, not the demosaic. A zoomed-in region develops a patch that also covers what the
spots touching it read. The heal solve starts from a coarse-to-fine estimate and stops on
the mean change per pixel rather than Ansel's total; deviations are listed in the module.
In the developer, the spots are drawn over the image (`develop/ShapeOverlay.tsx`) through
the frame's sensor mapping, which the pipeline worker sends with each render.

### Masks

Any module before filmic (except retouch, lens and geometry) can have a mask
(`ops/mask.rs`): drawn shapes combined with union, intersection, difference or
exclusion, times smooth ranges of luminance, saturation, hue and each RGB channel measured on the
module's input, feathered (a guided filter that follows the image's edges, or a blur),
then inverted and scaled by an opacity. The drawn part only depends on the shapes and
the geometry, so it is rasterised in the sensor frame, resampled with the image and
cached with the spatial stages; the pool workers get it with their strip. Without a
feather, the ranges are evaluated per pixel in the fused pass, so a masked colour slider
costs about as much as an unmasked one. A feathered mask with ranges is computed whole
with the spatial stages instead, on the module's input: edits before it then re-render
like spatial edits. Spatial modules blend their output through the mask.
The editor shows a mask (or one of its ranges alone) in yellow over the image, and can
paint the module's input as luminance, saturation, hue or one channel in the colours of the range
sliders' tracks, to see how the image is laid out along each. It edits a mask's shapes
with the same overlay as retouch.

## Keyboard shortcuts

**Library**: `0`–`5` rate · `P` pick · `X` reject · `U` unflag · `6`–`9` colour labels ·
arrows move · Shift+arrows/click extend the selection · Ctrl/⌘+click toggles ·
Ctrl/⌘+A selects all · `D`/Enter develops · Ctrl/⌘+D duplicates (Ctrl/⌘+Shift+D from
the original) · Delete deletes · Esc clears.

**Developer**: Ctrl/⌘+Z undo · Ctrl/⌘+Shift+Z redo · Ctrl/⌘+S save · Ctrl/⌘+B
colour-assessment frame · hold `\` to compare with the unedited image · `C` crop
(Enter applies, Esc cancels) · retouch and masks: Delete removes the selected spot or
shape, Enter closes a path, Esc cancels a path, then leaves the tool, the selection and the shapes' overlay ·
Esc closes an open menu, otherwise goes back to the library · double-click a slider to reset it · click its number to type a value · typed
values can go past a slider's usual range · drags and arrows take Shift ×10 and Ctrl/⌘ ×0.1.

## Known limitations and next steps

The feature roadmap is in [docs/ROADMAP.md](docs/ROADMAP.md).

- Demosaicing is bilinear at full resolution (fine for previews, soft at 100%).
  RCD/PPG and Markesteijn (X-Trans) would be better.
- Full-resolution export of very large files (60 MP+) needs a few GB of wasm memory.
  Tiled processing would fix this.
- The wasm build is single-threaded. wasm threads (SharedArrayBuffer + COOP/COEP) or a
  native N-API build for the server would speed up cold renders and geometry changes.
- The fused per-pixel pass is a natural WebGL/WebGPU fragment shader. Rust would still
  build the gains and lookup tables, and the GPU would only apply them.
- Shadows/highlights is global; a guided-filter tone equalizer would preserve local contrast.
- Filmic is the costliest per-pixel stage (~45 ns/pixel interactively, ~80 ns exact).
- The contrast equalizer is the costliest spatial stage: ~75 ms per megapixel when only
  luminance is edited, about twice that with colour. It re-runs on curve edits; caching
  the bands would make those cheap but costs ~60 MB per megapixel. Zoomed in at 100 %,
  its margin makes the first render of a view take about a second in the browser.
- Lens correction only reads Sony's embedded data (no lensfun yet). No histogram, denoise or XMP sidecar import/export yet.
- Retouch has no wavelet scales, automatic source search or "visualise spots" view yet.
- Masks can't pick their ranges from the image yet, and there are no raster (painted or
  AI) masks.
- Storage is local disk; the storage module is small enough to swap for S3-compatible storage.

## Credits

The filmic, colour calibration, colour primaries, contrast equalizer and retouch modules are
ports of [Ansel](https://ansel.photos)'s `filmicrgb`, `channelmixerrgb`, `colorprimaries`,
`atrous` and `retouch`/`heal` by Aurélien Pierre and contributors, licensed GPL-3.0-or-later. Lens correction from
embedded data follows darktable's `lens.cc` (GPL-3.0-or-later). RAW decoding uses
[rawler](https://github.com/dnglab/dnglab) (LGPL-2.1). The test RAWs come from
[raw.pixls.us](https://raw.pixls.us) (CC0).

## License

RAWtisserie is licensed under the [GNU Affero General Public License v3.0 or
later](LICENSE) (AGPL-3.0-or-later). If you run a modified version as a network
service, you must offer its source to the users of that service. The Ansel- and
darktable-derived modules keep their GPL-3.0-or-later terms, which allow combining
them with AGPL-3.0 code (GPLv3 §13).
