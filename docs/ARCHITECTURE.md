# Architecture

How RAWtisserie is put together. For running it, see the [README](../README.md); for
what each image module does and how it differs from Ansel, [MODULES.md](MODULES.md).

```
crates/
  pipeline/        Rust: RAW decoding (rawler), demosaic, scene-referred pipeline, export encoding
  pipeline-wasm/   wasm-bindgen bindings (one .wasm for the browser and Node)
packages/
  api/             @rawtisserie/api: the JSON the server sends and the web app reads (Photo, Target…)
  pipeline/        @rawtisserie/pipeline: TS types (EditParams, PhotoMetadata) + wasm loaders
apps/
  server/          @rawtisserie/server: Fastify + Postgres (@databases), auth, uploads, render queue
  web/             @rawtisserie/web: Vite + React + Chakra UI v3 (library + developer)
```

## The pixel pipeline

The pipeline is scene-referred: pixels stay linear, unbounded floats in a linear
Rec.2020 working space, and are only compressed to display range by the tone mapper
at the end.

```
RAW ─▶ decode ─▶ demosaic/bin ─▶ D65 white balance ─▶ camera → Rec.2020   cached: base (per binning factor)
    ─▶ multiple exposure: another photo's base blended in                  cached: with the base
    ─▶ retouch spots (heal, clone, fill, blur), in place on the base        cached: with the base
    ─▶ geometry (lens, orientation, straighten, perspective, crop, resample) cached: per output size
       └ drawn parts of masks, through the same geometry, feathered          cached: per output size
    ─▶ diffuse ─▶ contrast equalizer ─▶ glow                                cached: per output size
    ─▶ exposure ─▶ colour calibration ─▶ colour balance
    ─▶ colour primaries ─▶ filmic (AgX) ─▶ creative LUTs ─▶ sRGB            one fused pass, always re-run
```

Images that aren't RAW files (JPEG, PNG, TIFF, WebP: `bitmap.rs`) take the same path as
a plain RGB "sensor": their samples are linearised through their ICC profile (sRGB without
one) and converted to Rec.2020, with nothing to white balance. They have no filmic or lens
correction and start with an empty recipe, so an unedited image comes out as it went in.

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
smoothing rebuild the weights (~100 ms, 19 MB). The detail stages come before the per-pixel ones, so
exposure, white balance and saturation never re-run them; diffuse works at a fixed
reference level (as Ansel's does after its default exposure). The contrast equalizer works on log luminance, so exposure doesn't affect it either. Two output sizes are cached: a ~0.5 MP draft and the full preview size.

While a slider is being dragged, the UI asks for a draft. If the full-size spatial
stages are already cached (any colour or tone slider), the pipeline worker renders full
size instead and splits the per-pixel stages across a pool of workers
(`develop/pointPool.ts`), each holding a strip of the cached image. Only spatial edits
(geometry, diffuse, equalizer curves, glow) fall back to the draft. See
[PERFORMANCE.md](PERFORMANCE.md) for measurements and what didn't work.

Zoomed in, the developer renders only the visible region at the zoom level (at most
100 %). Only the photosites under it are developed, in a cached "patch" of the base
image, and the spatial stages get a margin around it so that its pixels match a render of
the whole image. Diffuse or sharpen's margin is much less than how far it could reach
in theory (a pixel's influence fades with distance; `DiffuseOp::reach`), or many
iterations at 100 % would develop several times the visible region. Meanwhile the fitted render is enlarged with a CSS transform, so the wheel
and panning respond at once; the region follows 150 ms after the view stops moving.

The library's culling loupe zooms without the RAW: the server renders 512 px tiles of the
version at 100 % (and at half size, down to the stored 2048 px preview) on demand, in one
worker thread that keeps the last file decoded (`render/zoom.ts`): ~0.4 s for the first
tile of a photo, ~65 ms each after that. Tiles the loupe moved away from are dropped
before they're rendered, and the browser caches the rest under the recipe's revision.

Previews bin photosites ("superpixel") down to roughly the output size instead of
demosaicing at full resolution. Spatial parameters (diffuse and glow radii) are
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

## Tests

`npm install` also sets up a pre-commit hook (`.githooks/pre-commit`, through
`core.hooksPath`) that runs Prettier on the files being committed: it formats and
stages them again, or stops the commit if one also has unstaged changes.

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

## Known limitations and next steps

The feature roadmap is in [ROADMAP.md](ROADMAP.md).

- Demosaicing is bilinear at full resolution (fine for previews, soft at 100%).
  RCD/PPG and Markesteijn (X-Trans) would be better.
- Full-resolution export of very large files (60 MP+) needs a few GB of wasm memory.
  Tiled processing would fix this.
- The wasm build is single-threaded. wasm threads (SharedArrayBuffer + COOP/COEP) or a
  native N-API build for the server would speed up cold renders and geometry changes.
- The fused per-pixel pass is a natural WebGL/WebGPU fragment shader. Rust would still
  build the gains and lookup tables, and the GPU would only apply them.
- Colour balance's ranges are by luminance alone; a guided-filter tone equalizer would
  preserve local contrast. Its perceptual grading costs ~80 ns/pixel native (see
  `docs/PERFORMANCE.md`); its mixers alone ~4 ns.
- Filmic is the costliest per-pixel stage (~45 ns/pixel interactively, ~80 ns exact).
- The contrast equalizer is the costliest spatial stage: ~75 ms per megapixel when only
  luminance is edited, about twice that with colour. It re-runs on curve edits; caching
  the bands would make those cheap but costs ~60 MB per megapixel. Zoomed in at 100 %,
  its margin makes the first render of a view take about a second in the browser.
- Lens correction reads Sony's embedded data and lensfun's database, not yet DNG opcodes or
  other makers' embedded data. No histogram, denoise or XMP sidecar import/export yet.
- Retouch has no wavelet scales, automatic source search or "visualise spots" view yet.
- Masks can't pick their ranges from the image yet, and there are no raster (painted or
  AI) masks.
- Storage is local disk; the storage module is small enough to swap for S3-compatible storage.
