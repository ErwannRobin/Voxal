#!/bin/sh
#
# Download the EXPERIMENTAL P3M-Net engine's files into src/assets/p3m/ —
# the converted model and the ONNX Runtime Web build that runs it.
#
# This is how the web deploy gets them (vercel-build.sh), and the quick way to
# get them locally (make p3m-fetch). Nothing is committed: the model is 78 MB.
# scripts/p3m-assets.sh is the other way, which converts the official
# checkpoint itself (needs PyTorch); it produced the file published here.
#
#   * The model: p3m_r34_w16.onnx, P3M-Net ResNet-34 (MIT,
#     https://github.com/JizhiziLi/P3M) converted by scripts/p3m-export.py,
#     published once as an asset of the `p3m-model-v1` PRERELEASE of this
#     repository — a prerelease so the desktop updater's releases/latest
#     never sees it. See docs/p3m-evaluation.md.
#   * ONNX Runtime Web 1.30.0 (MIT) from jsDelivr: only the three files the
#     WebGPU path loads (the `all` bundle and its JSEP build, which the WASM
#     backend also uses).
#
# Every file is pinned by sha256; a mismatch deletes the download and fails.
#
# Usage: sh scripts/p3m-fetch.sh [--runtime-only]
#   --runtime-only  ONNX Runtime only (scripts/p3m-assets.sh, which converts the model itself)

set -e

# The BackgroundMattingV2 evaluation and the matting lab run on the same pinned
# ONNX Runtime and stage it through here: scripts/bgm-assets.sh and
# scripts/lab-assets.sh set FETCH_DST.
DST="${FETCH_DST:-src/assets/p3m}"
ORT_VERSION="1.30.0"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"
MODEL_BASE="https://github.com/ErwannRobin/Voxal/releases/download/p3m-model-v1"

ORT_FILES="
2e4a0eae53c3f246e26423aaca493d3bfc22ce524894f27519a9ec4a14e6397a ort.all.min.mjs
709853412fd1ffc34247af1e73569227b5b79629c5ca3f59cc39cf7e500e4947 ort-wasm-simd-threaded.jsep.mjs
3ad23231b5bd6d9dda55a7f84606315e0bf35b6750c28ee993c987c54cacab0f ort-wasm-simd-threaded.jsep.wasm
"
MODEL_FILES="
923323d1267ace68b2a2c58f54457c039c9206935537d4772effd67308e403e0 p3m_r34_w16.onnx
"

mkdir -p "$DST"

# shasum on macOS, sha256sum on the Linux build image.
if command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sum() { sha256sum "$1" | cut -d' ' -f1; }
fi

fetch() { # base sum name
  out="$DST/$3"
  if [ -f "$out" ] && [ "$(sum "$out")" = "$2" ]; then return 0; fi
  echo "  ↓ $3"
  curl -sfL --retry 3 -o "$out.part" "$1/$3"
  got="$(sum "$out.part")"
  if [ "$got" != "$2" ]; then
    rm -f "$out.part"
    echo "✗ $3: sha256 $got, expected $2" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}

echo "$ORT_FILES" | while read -r s name; do if [ -n "$name" ]; then fetch "$ORT_BASE" "$s" "$name"; fi; done
if [ "$1" != "--runtime-only" ]; then
  echo "$MODEL_FILES" | while read -r s name; do if [ -n "$name" ]; then fetch "$MODEL_BASE" "$s" "$name"; fi; done
fi

echo "→ P3M-Net (experimental) files in $DST"
