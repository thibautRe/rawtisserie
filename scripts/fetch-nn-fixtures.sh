#!/usr/bin/env bash
# Download ansel-denoise's parity fixtures for the denoising executor
# (crates/pipeline/tests/nn_parity.rs) into crates/pipeline/tests/nn, and check their
# checksums. The first model is the one the single-scale fixture was made with (it was
# replaced in ansel-denoise since); quarter-single v1 is the smallest published one, for
# tests/denoise.rs. Files already present are only checked.
# Then: cargo test --release -p rawtisserie-pipeline --test nn_parity
set -euo pipefail
cd "$(dirname "$0")/../crates/pipeline/tests"
mkdir -p nn/fixtures/ms
repo=https://raw.githubusercontent.com/aurelienpierreeng/ansel-denoise

while read -r sha rev path name; do
  if [ ! -f "nn/$name" ]; then
    echo "fetching $name"
    curl -fL --retry 3 -o "nn/$name.part" "$repo/$rev/$path"
    mv "nn/$name.part" "nn/$name"
  fi
  echo "$sha  nn/$name" | sha256sum --quiet -c -
done <<'LIST'
412d0086b9e989f64cef310823bf5c2305bf19a8b575a2d8a0be92aa5ca3a310 c586a4781be090898a79ed252c85974fa97bd389 models/rawdenoiseai-v1-full.anselnn rawdenoiseai-v1-full.anselnn
55b56c4fcd9e555739cc37bee61d37de9868122647f058c3ed66e206c1a70dd3 c2b4034f8df17a1af171fa5dee5ef9d17a3afccf fixtures/fixture-input.f32 fixtures/fixture-input.f32
adcb546c361bc9693678137013796af103074a9fe58db6a9f2393fc353762c8e c2b4034f8df17a1af171fa5dee5ef9d17a3afccf fixtures/fixture-expected.f32 fixtures/fixture-expected.f32
4cadaf1109bf44e549830b8aec2247e04fafe2a4c42eba71eb50087c9f539a7b c2b4034f8df17a1af171fa5dee5ef9d17a3afccf fixtures/ms/fixture-base-planes.f32 fixtures/ms/fixture-base-planes.f32
a961fad5a8d70b7e9f0b534e2f2f09d67e108135f7da8e888135692e58320f70 c2b4034f8df17a1af171fa5dee5ef9d17a3afccf fixtures/ms/fixture-coarse-input.f32 fixtures/ms/fixture-coarse-input.f32
75cf17a27165ee2b469dcced5ba142604f030e7e8d0cb889aa67a12a7f39cb49 c2b4034f8df17a1af171fa5dee5ef9d17a3afccf models/denoise-quarter-single-v1.anselnn denoise-quarter-single-v1.anselnn
LIST
echo "nn fixtures ok"
