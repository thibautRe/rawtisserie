#!/usr/bin/env bash
# Download the raw denoise models (roadmap 3.5) the server hands out
# (`GET /api/denoise-models/:id`) into $1, or models/denoise, and check their
# checksums. They're ansel-denoise's (GPL-3.0), pinned here by hash: upstream replaced
# its "v1" files in place while it was in development, and a recipe that names a model
# must always get the same one. A retrained model is a new version (a new line here, a
# new id), never a new file under an old name. Files already present are only checked.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="${1:-models/denoise}"
mkdir -p "$dir"
repo=https://raw.githubusercontent.com/aurelienpierreeng/ansel-denoise

while read -r sha rev id; do
  if [ ! -f "$dir/$id.anselnn" ]; then
    echo "fetching $id"
    curl -fsSL --retry 3 -o "$dir/$id.anselnn.part" "$repo/$rev/models/$id.anselnn"
    mv "$dir/$id.anselnn.part" "$dir/$id.anselnn"
  fi
  echo "$sha  $dir/$id.anselnn" | sha256sum --quiet -c -
done <<'LIST'
75cf17a27165ee2b469dcced5ba142604f030e7e8d0cb889aa67a12a7f39cb49 c2b4034f8df17a1af171fa5dee5ef9d17a3afccf denoise-quarter-single-v1
e349aeb8b35a7fb24832ea65bb17db915d9d30f70a2f5975adb5794e37b3d17f c2b4034f8df17a1af171fa5dee5ef9d17a3afccf denoise-quarter-multi-v1
1650d827d72ad05990dfbe994c232a08b584770a52cd329d58c6993df03baa6d c2b4034f8df17a1af171fa5dee5ef9d17a3afccf denoise-half-single-v1
0d7bb189101d1c2f0dc0f1b14a5f8af9188f1cf079fa4308f536301332dd45ce c2b4034f8df17a1af171fa5dee5ef9d17a3afccf denoise-half-multi-v1
bc5ef61637a3d63902bee2d367995e8b1d1219d1062268458ea71d550a43ae35 c2b4034f8df17a1af171fa5dee5ef9d17a3afccf denoise-large-single-v1
a12925b6cf3d7f31fafcbd05d13fd99a13e64ce8bd09cf18d7abc7e3eda03ad1 c2b4034f8df17a1af171fa5dee5ef9d17a3afccf denoise-large-multi-v1
LIST
echo "denoise models ok ($dir)"
