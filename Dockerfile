# The production image: the API server, serving the built web app. See docs/DEPLOYMENT.md.
#
#   podman build -t rawtisserie .
#   podman run -p 4000:4000 -v rawtisserie-data:/data -e DATABASE_URL=… rawtisserie

ARG NODE_VERSION=26

# The pixel pipeline as WebAssembly (packages/pipeline/wasm). Its output doesn't depend
# on the platform, so it's built on the build machine's.
FROM --platform=$BUILDPLATFORM docker.io/library/rust:1-slim AS wasm
# Must match the wasm-bindgen crate version in Cargo.toml.
ARG WASM_BINDGEN_VERSION=0.2.129
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
  && dir="wasm-bindgen-$WASM_BINDGEN_VERSION-$(uname -m)-unknown-linux-musl" \
  && curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$WASM_BINDGEN_VERSION/$dir.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin "$dir/wasm-bindgen"
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
COPY scripts/build-wasm.sh scripts/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/src/target \
  ./scripts/build-wasm.sh

# Raw denoise models (models/denoise), pinned by hash: ~100 MB, fetched once per change
# of the script.
FROM --platform=$BUILDPLATFORM docker.io/library/debian:stable-slim AS denoise-models
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/fetch-denoise-models.sh scripts/
RUN ./scripts/fetch-denoise-models.sh models/denoise

# The web app (apps/web/dist).
FROM --platform=$BUILDPLATFORM docker.io/library/node:${NODE_VERSION}-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/pipeline/package.json packages/pipeline/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.base.json ./
COPY packages/pipeline packages/pipeline
COPY --from=wasm /src/packages/pipeline/wasm packages/pipeline/wasm
COPY apps/web apps/web
RUN npm run build -w @rawtisserie/web

# The server: TypeScript run directly by Node, with production dependencies only.
FROM docker.io/library/node:${NODE_VERSION}-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 STORAGE_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/pipeline/package.json packages/pipeline/
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev -w @rawtisserie/server
COPY packages/pipeline/src packages/pipeline/src
COPY packages/pipeline/luts packages/pipeline/luts
COPY --from=wasm /src/packages/pipeline/wasm packages/pipeline/wasm
COPY apps/server/migrations apps/server/migrations
COPY apps/server/src apps/server/src
COPY --from=web /src/apps/web/dist apps/web/dist
COPY --from=denoise-models /src/models/denoise models/denoise
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
CMD ["node", "apps/server/src/index.ts"]
