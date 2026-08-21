#!/bin/sh
#
# Stage the MediaPipe vision runtime into src/assets/seg/.
#
# Roughly 12 MB of WASM, which is why it is neither committed nor bundled into
# the mobile apps: it is copied out of node_modules at build time, served from
# our own origin, and fetched lazily by video-effects.js the first time somebody
# turns a background on. See docs/video-effects.md.
#
# This script is the ONE definition of that copy. `make seg-assets` calls it and
# so does vercel-build.sh, because Vercel caps `buildCommand` at 256 characters
# and because three cp paths written out twice would drift the moment MediaPipe
# renames a file.

set -e

SRC="node_modules/@mediapipe/tasks-vision"
DST="src/assets/seg"

if [ ! -d "$SRC" ]; then
  echo "→ @mediapipe/tasks-vision not installed; run: npm install" >&2
  exit 1
fi

mkdir -p "$DST"
cp "$SRC/vision_bundle.mjs"                "$DST/"
cp "$SRC/wasm/vision_wasm_internal.js"     "$DST/"
cp "$SRC/wasm/vision_wasm_internal.wasm"   "$DST/"

echo "→ Background-effects runtime staged in $DST"
