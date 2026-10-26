# 🍗 RAWtisserie

**From raw to well done.**

RAWtisserie is a web-based photo library and RAW developer, inspired by
[Ansel](https://ansel.photos) and [darktable](https://www.darktable.org).

- **Library**: every photo you own, filterable by EXIF metadata (camera, lens, ISO,
  focal length, aperture, date), tags, rating, flags and colour labels. Cull with the
  keyboard (rate, pick/reject, label, delete) and correct metadata. Originals are never
  modified; edits live in the database.
- **Developer**: exposure, white balance, sigmoid tone mapping with shadows/highlights,
  saturation and vibrance, sharpening, blur, rotation/flip, straightening and cropping.
  It runs **in your browser** on a WebAssembly build of the pixel pipeline.
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
RAW ─▶ decode ─▶ demosaic/bin ─▶ white balance ─▶ camera → Rec.2020   cached: base (per binning factor)
    ─▶ geometry (orientation, straighten, crop, resample)               cached: per output size
    ─▶ blur ─▶ sharpen                                                  cached: per output size
    ─▶ exposure ─▶ warmth/tint ─▶ saturation/vibrance ─▶ shadows/highlights
    ─▶ Rec.709 ─▶ sigmoid tone mapping + sRGB encoding                  one fused pass, always re-run
```

Each cached stage is keyed by the parameters it depends on, so a slider only re-runs
the stages after it. Exposure, white balance, colour and tone sliders only re-run the
fused per-pixel pass. Its curves are baked into lookup tables indexed by the top bits
of the `f32` value (log-spaced, no `log`/`pow` per pixel), and the tone curve and sRGB
encoding share a single table. Blur and sharpen come before the per-pixel stages:
exposure, white balance and saturation are linear, so the order doesn't change the
result. Two output sizes are cached, because while a slider is being dragged the UI
renders a ~1 MP draft and renders full size on release.

Previews bin photosites ("superpixel") down to roughly the output size instead of
demosaicing at full resolution. Spatial parameters (blur and sharpen radii) are
expressed in full-resolution pixels, so previews match full-size exports.

`cargo run --release --example bench -- photo.ARW 2400` prints timings for typical
interactions.

Edit parameters are a versioned JSON recipe (`crates/pipeline/src/params.rs`, mirrored
in `packages/pipeline/src/params.ts`). Every field has a default, so older recipes
keep working.

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

| Command                                           | What it does                                                    |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `npm run build:wasm`                              | Rebuild the WebAssembly pipeline (`packages/pipeline/wasm`)     |
| `npm run build`                                   | wasm + production web build (served by the API server)          |
| `npm test`                                        | Rust tests + TS tests                                           |
| `npm run typecheck`                               | TypeScript in every workspace                                   |
| `npm run db:schema -w @rawtisserie/server`        | Regenerate DB types into `apps/server/src/__generated__`        |
| `cargo run --release --example develop -- in.ARW out.jpg 2048 [params.json]` | Develop a file from the CLI |

`RAWTISSERIE_SAMPLE=/path/to/file.ARW npm test -w @rawtisserie/pipeline` also runs a
real decode-and-render through the wasm module.

### Production

`npm run build && npm run start -w @rawtisserie/server` serves both the API and the
built web app from port 4000. Set `COOKIE_SECURE=true` behind HTTPS, and
`ALLOW_SIGNUP=false` once your accounts exist. Originals and renders are stored
under `STORAGE_DIR`.

## Keyboard shortcuts

**Library**: `0`–`5` rate · `P` pick · `X` reject · `U` unflag · `6`–`9` colour labels ·
arrows move · Shift+arrows/click extend the selection · Ctrl/⌘+click toggles ·
Ctrl/⌘+A selects all · `D`/Enter develops · Delete deletes · Esc clears.

**Developer**: Ctrl/⌘+Z undo · Ctrl/⌘+Shift+Z redo · Ctrl/⌘+S save · hold `\` to
compare with the unedited image · `C` crop (Enter applies, Esc cancels) ·
double-click a slider to reset it.

## Known limitations and next steps

- Demosaicing is bilinear at full resolution (fine for previews, soft at 100%).
  RCD/PPG and Markesteijn (X-Trans) would be better.
- Full-resolution export of very large files (60 MP+) needs a few GB of wasm memory.
  Tiled processing would fix this.
- The wasm build is single-threaded. wasm threads (SharedArrayBuffer + COOP/COEP) or a
  native N-API build for the server would speed up cold renders and geometry changes.
- The fused per-pixel pass is a natural WebGL/WebGPU fragment shader. Rust would still
  build the gains and lookup tables, and the GPU would only apply them.
- Shadows/highlights is global; a guided-filter tone equalizer would preserve local contrast.
- No histogram, lens correction, denoise, masks or XMP sidecar import/export yet.
- Storage is local disk; the storage module is small enough to swap for S3-compatible storage.
