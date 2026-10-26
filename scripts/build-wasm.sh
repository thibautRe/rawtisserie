#!/usr/bin/env bash
# Build the pixel pipeline to WebAssembly and generate JS bindings into
# packages/pipeline/wasm. The same module serves the browser and Node.
set -euo pipefail
cd "$(dirname "$0")/.."

profile="${1:-release}"
flag=$([ "$profile" = "release" ] && echo "--release" || echo "")

cargo build -p rawtisserie-pipeline-wasm --target wasm32-unknown-unknown $flag
wasm-bindgen --target web --out-dir packages/pipeline/wasm --out-name pipeline \
  "target/wasm32-unknown-unknown/$profile/rawtisserie_pipeline_wasm.wasm"

if command -v wasm-opt >/dev/null && [ "$profile" = "release" ]; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int \
    -o packages/pipeline/wasm/pipeline_bg.wasm packages/pipeline/wasm/pipeline_bg.wasm
fi
ls -lh packages/pipeline/wasm/pipeline_bg.wasm
