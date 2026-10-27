#!/usr/bin/env bash
# Download the reference RAWs for the golden-image tests (crates/pipeline/tests/golden.rs)
# into crates/pipeline/tests/golden/raws, and check their checksums. Files already
# present are only checked.
set -euo pipefail
cd "$(dirname "$0")/../crates/pipeline/tests/golden"
mkdir -p raws

grep -v '^#' raws.txt | while read -r sha name url; do
  [ -n "$sha" ] || continue
  if [ ! -f "raws/$name" ]; then
    echo "fetching $name"
    curl -fL --retry 3 -o "raws/$name.part" "$url"
    mv "raws/$name.part" "raws/$name"
  fi
  echo "$sha  raws/$name" | sha256sum --quiet -c -
done
echo "golden RAWs ok"
