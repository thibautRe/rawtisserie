# Deployment

How RAWtisserie runs in production and how changes get there. Keep this file in step
with the code: a change to what runs, where it stores things or how it's built and
checked updates the diagram and the sections below.

## Today

One Node process serves the API and the built web app, behind a reverse proxy that
terminates HTTPS. It ships as a container image (see [Container image](#container-image));
`npm run build && npm run start -w @rawtisserie/server` on the machine works too. There
is no deployment automation yet.

```
                         browser
   ┌────────────────────────────────────────────────────┐
   │ web app (library + developer)                      │
   │ pipeline worker (wasm) + point pool (≤ 4 workers)  │  every interactive render
   │                                                    │  and every export
   └──────────────────────────┬─────────────────────────┘
                              │ HTTPS
   ┌──────────────────────────▼─────────────────────────┐
   │ reverse proxy (TLS)                                │
   └──────────────────────────┬─────────────────────────┘
                              │ HTTP :4000 (PORT)
   ┌──────────────────────────▼─────────────────────────┐
   │ Node ≥ 24, TypeScript run directly (no build step) │
   │  Fastify: /api/… and apps/web/dist                 │
   │  on start: migrations (MIGRATE_ON_START),          │
   │            collectLuts                             │
   │  render queue ─▶ RENDER_CONCURRENCY worker threads │  thumbnails, previews,
   │                  (wasm)                            │  auto-tune write-back
   │  zoom worker ─▶ 1 thread, last RAW kept decoded    │  loupe tiles at 100 %
   └─────────────┬──────────────────────┬───────────────┘
                 │ DATABASE_URL         │ STORAGE_DIR
   ┌─────────────▼─────────┐  ┌─────────▼───────────────────────────┐
   │ Postgres 18           │  │ local disk                          │
   │ users, photos,        │  │ originals (by storage_key),         │
   │ versions, history,    │  │ renders (by version id),            │
   │ presets, LUT rows     │  │ LUT tables (.clut)                  │
   └───────────────────────┘  └─────────────────────────────────────┘
```

Configuration is environment variables (`.env.example`): `DATABASE_URL`, `STORAGE_DIR`,
`PORT`, `ALLOW_SIGNUP`, `COOKIE_SECURE` (true behind HTTPS), `RENDER_CONCURRENCY`,
`MIGRATE_ON_START`.

## Container image

`Dockerfile` at the root, in three stages:

1. **wasm** (`rust:1-slim`): `scripts/build-wasm.sh`, with the prebuilt `wasm-bindgen`
   matching the crate's version (`WASM_BINDGEN_VERSION`, keep it in step with
   `Cargo.toml`).
2. **web** (`node:26-slim`): `npm ci`, then the Vite build.
3. **runtime** (`node:26-slim`): the server's production dependencies only
   (`npm ci --omit=dev -w @rawtisserie/server`), `packages/pipeline` (sources, built-in
   LUTs, wasm), the server's sources and migrations, and `apps/web/dist`. Runs as `node`.

Anything the server imports at run time must be in its `dependencies`, not
`devDependencies`, or the image fails to start.

```sh
podman build -t rawtisserie .
podman run -p 4000:4000 -v rawtisserie-data:/data \
  -e DATABASE_URL=postgres://… -e COOKIE_SECURE=true rawtisserie
```

The image sets `HOST=0.0.0.0`, `PORT=4000` and `STORAGE_DIR=/data` (a volume: originals,
renders, LUT tables). The rest of the configuration comes from the environment as
above. Migrations run on start, and SIGTERM closes the server and the database pool. About 360 MB.

## Target: a single VPS (planned)

Decided 2026-11-12: one VPS at OVH runs the server and Postgres; originals and renders
move to OVH Object Storage once 7.1 (object storage backend) is done. Postgres moves to
a managed instance later, when backups and failover are worth the cost.

```
   browser ──HTTPS──▶ VPS ┌─────────────────────────────────────┐
                          │ reverse proxy (TLS)                 │
                          │   └▶ RAWtisserie server (:4000)     │
                          │ Postgres 18 (local, backed up)      │
                          └───────────────┬─────────────────────┘
                                          │ S3 API (same region)
                          ┌───────────────▼─────────────────────┐
                          │ OVH Object Storage                  │
                          │ originals, renders, LUT tables      │
                          └─────────────────────────────────────┘
```

The server runs as the container image. To decide: the reverse proxy, how a release
reaches the VPS, and Postgres backups.

## CI

GitHub Actions (`.github/workflows/ci.yml`), on every push to `main` and every pull
request. Three jobs run in parallel:

- **Rust:** `cargo test --workspace`, golden-image tests included. The golden RAWs are
  cached by `raws.txt`'s hash; when the golden test fails, its renders and ΔE heatmaps
  (`target/tmp/golden/`) are uploaded as an artifact.
- **TypeScript:** builds the wasm (`wasm-bindgen` pinned to the crate's version), then
  `format:check`, `typecheck`, the workspaces' tests and the production web build.
- **Container image:** builds the `Dockerfile` (not pushed anywhere yet), with Buildx's
  GitHub Actions cache.

Not in CI yet: the browser checks (`test:sliders`, `test:library`, `test:ui`,
`test:perf`), which need Playwright's Chromium; `cargo fmt` and clippy.
