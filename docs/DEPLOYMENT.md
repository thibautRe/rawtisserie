# Deployment

How RAWtisserie runs in production and how changes get there. Keep this file in step
with the code: a change to what runs, where it stores things or how it's built and
checked updates the diagram and the sections below.

## Today

One Node process serves the API and the built web app. There is no container image
and no deployment automation yet: `npm run build && npm run start -w @rawtisserie/server`
on the machine, behind a reverse proxy that terminates HTTPS.

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

To decide: the reverse proxy, how the server is packaged (container image or a
systemd service), how a release reaches the VPS, and Postgres backups.

## CI

GitHub Actions (`.github/workflows/ci.yml`), on every push to `main` and every pull
request. Two jobs run in parallel:

- **Rust:** `cargo test --workspace`, golden-image tests included. The golden RAWs are
  cached by `raws.txt`'s hash; when the golden test fails, its renders and ΔE heatmaps
  (`target/tmp/golden/`) are uploaded as an artifact.
- **TypeScript:** builds the wasm (`wasm-bindgen` pinned to the crate's version), then
  `format:check`, `typecheck`, the workspaces' tests and the production web build.

Not in CI yet: the browser checks (`test:sliders`, `test:library`, `test:ui`,
`test:perf`), which need Playwright's Chromium; `cargo fmt` and clippy.
