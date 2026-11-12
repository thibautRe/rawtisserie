# Deployment

How RAWtisserie runs in production and how changes get there. Keep this file in step
with the code: a change to what runs, where it stores things or how it's built and
checked updates the diagram and the sections below.

## Today

One Node process serves the API and the built web app, behind a reverse proxy that
terminates HTTPS. It ships as a [container image](#container-image), run on a VPS with
[`deploy/`](#on-a-vps-deploy).
`npm run build && npm run start -w @rawtisserie/server` on a machine works too.

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

## On a VPS: `deploy/`

Decided 2026-11-12: one VPS at OVH runs everything below with Docker Compose
(`deploy/compose.yaml`); originals and renders move to OVH Object Storage once 7.1
(object storage backend) is done. Postgres moves to a managed instance later, when
failover is worth the cost.

```
   browser ──HTTPS──▶ VPS ┌───────────────────────────────────────────────────┐
                          │ caddy        :80 → :443, certificates, zstd/gzip  │
                          │   └▶ app     the server image (:4000, internal)   │
                          │        │       volume app-data → /data            │
                          │        ▼                                          │
                          │ db           Postgres 18, volume db-data          │
                          │   ▲                                               │
                          │ backup       nightly pg_dump → BACKUP_DIR and the │
                          │              bucket, 30 days kept in each ────────┼──┐
                          └───────────────────────┬───────────────────────────┘  │
                                                  │ S3, same region, after 7.1   │
                          ┌───────────────────────▼───────────────────────────┐  │
                          │ OVH Object Storage: originals, renders, LUTs      │  │
                          │ (a separate bucket) database dumps ◀──────────────┼──┘
                          └───────────────────────────────────────────────────┘
```

Everything is in the repo except `deploy/.env` (from `deploy/.env.example`): the
domain, the Postgres password, the image tag, sign-up, render concurrency and the
backup settings. Only Caddy's ports are published; the app and Postgres are reachable
from the compose network only.

**Setting up** (Docker with the compose plugin, the domain's DNS pointing at the
machine, ports 80 and 443 open):

```sh
git clone https://github.com/thibautRe/rawtisserie.git && cd rawtisserie/deploy
cp .env.example .env    # fill it in
docker compose up -d
```

**Updating:** `docker compose pull app && docker compose up -d app` (set
`RAWTISSERIE_IMAGE` to a tag to pin a build). Migrations run when the app starts. A
change to `deploy/` itself needs a `git pull` first.

**Proxy:** `deploy/Caddyfile`. Caddy sets `X-Forwarded-*`, which the server reads, and
has no request body limit: the server enforces its own (400 MB per upload). A proxy
with a default limit (nginx: 1 MB) would break uploads.

**Backups** (`deploy/backup/`, the `backup` service: Postgres's image with rclone): once
a day from `BACKUP_HOUR` (UTC), `pg_dump --format=custom` to
`BACKUP_DIR/rawtisserie-YYYY-MM-DD.dump`, then dumps older than `BACKUP_KEEP_DAYS` (30)
are deleted. A day missed while the machine was down is caught up when it starts. With
`BACKUP_S3_BUCKET` set, each dump is also copied to that bucket, where dumps older than
`BACKUP_KEEP_DAYS` are deleted too (only `rawtisserie-*.dump`: anything else in the
bucket is left alone). A failed upload is retried every 10 minutes, and the service
uploads on start, so a configuration mistake shows in `docker compose logs backup` at
once. Use a bucket of its own and an S3 user limited to it. Those credentials sit on
the VPS and can delete dumps: if that's a concern, turn on versioning or object lock on
the bucket. The dumps are not encrypted by us. They cover the database only; the
originals are another matter (7.1, 7.3).

To restore one:

```sh
docker compose stop app
docker compose exec -T db pg_restore -U rawtisserie -d rawtisserie --clean --if-exists \
  < backups/rawtisserie-YYYY-MM-DD.dump
docker compose start app
```

Not done yet: publishing the image to a registry (`ghcr.io/thibautre/rawtisserie`, the
default `RAWTISSERIE_IMAGE`) and deploying from CI.

## CI

GitHub Actions (`.github/workflows/ci.yml`), on every push to `main` and every pull
request. Four jobs run in parallel:

- **Rust:** `cargo test --workspace`, golden-image tests included. The golden RAWs are
  cached by `raws.txt`'s hash; when the golden test fails, its renders and ΔE heatmaps
  (`target/tmp/golden/`) are uploaded as an artifact.
- **TypeScript:** builds the wasm (`wasm-bindgen` pinned to the crate's version), then
  `format:check`, `typecheck`, the workspaces' tests and the production web build.
- **Container image:** builds the `Dockerfile` (not pushed anywhere yet), with Buildx's
  GitHub Actions cache.
- **Deploy configuration:** `docker compose config` on `deploy/compose.yaml`,
  `caddy validate` on the Caddyfile, `shellcheck` on the backup script and a build of
  its image.

Not in CI yet: the browser checks (`test:sliders`, `test:library`, `test:ui`,
`test:perf`), which need Playwright's Chromium; `cargo fmt` and clippy.
