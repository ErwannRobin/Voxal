#!/bin/sh
#
# Stage the EXPERIMENTAL P3M-Net matting engine into src/assets/p3m/.
#
# For the P3M-Net evaluation (docs/p3m-evaluation.md). Nothing here is committed
# or shipped, but for size, not licence: P3M-Net's code and weights are MIT
# (https://github.com/JizhiziLi/P3M), and so is ONNX Runtime Web.
#
#   * The official checkpoint (ResNet-34, trained on P3M-10k) is a 158 MB
#     PyTorch file on Google Drive. It is converted here, once, to ONNX by
#     scripts/p3m-export.py, which needs PyTorch: a private venv under
#     .cache/p3m/ is made with `uv` (or python3 -m venv).
#   * The browser loads p3m_r34_w16.onnx (78 MB: weights stored as half floats,
#     computed in float32) or p3m_r34_fp32.onnx (156 MB) with ONNX Runtime Web
#     1.30.0, fetched from jsDelivr like scripts/rvm-assets.sh does.
#
# The inputs are pinned (ORT files and checkpoint by sha256, the code by commit);
# the converted file depends on the PyTorch version, so instead of a hash the
# export checks itself against the original module on the repository's sample
# portraits and prints the difference.
#
# Usage: sh scripts/p3m-assets.sh [--fp16]   (make p3m-assets)
#   --fp16  also the half-float COMPUTE variant (timing only: its alpha drifts)

set -e

DST="src/assets/p3m"
WORK=".cache/p3m"
ORT_VERSION="1.30.0"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"
P3M_REPO="https://github.com/JizhiziLi/P3M.git"
P3M_COMMIT="9f9390f2bc8e93173a9bb8e46102bf32a3c2b825"
CKPT_ID="1smX2YQGIpzKbfwDYHAwete00a_YMwoG1"   # README: "Pretrained P3M-NET on P3M-10k"
CKPT_SUM="55ee038cecb9349cd17e81bddaccbf5c92ebd1700b9e70a47125d914ac6d25bf"

ORT_FILES="
2e4a0eae53c3f246e26423aaca493d3bfc22ce524894f27519a9ec4a14e6397a ort.all.min.mjs
e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b ort-wasm-simd-threaded.mjs
3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2 ort-wasm-simd-threaded.wasm
3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28 ort-wasm-simd-threaded.asyncify.mjs
39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da ort-wasm-simd-threaded.asyncify.wasm
709853412fd1ffc34247af1e73569227b5b79629c5ca3f59cc39cf7e500e4947 ort-wasm-simd-threaded.jsep.mjs
3ad23231b5bd6d9dda55a7f84606315e0bf35b6750c28ee993c987c54cacab0f ort-wasm-simd-threaded.jsep.wasm
"

mkdir -p "$DST" "$WORK"

sum() { shasum -a 256 "$1" | cut -d' ' -f1; }

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

# --- the official code and checkpoint ---------------------------------------
if [ ! -d "$WORK/P3M/.git" ]; then
  echo "  ↓ P3M code @ ${P3M_COMMIT%"${P3M_COMMIT#???????}"}"
  git clone -q "$P3M_REPO" "$WORK/P3M"
fi
git -C "$WORK/P3M" -c advice.detachedHead=false checkout -q "$P3M_COMMIT"

# --- a venv with PyTorch, for the conversion only ---------------------------
VENV="$WORK/venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "  … Python venv for the conversion (PyTorch, ~1 GB, once)"
  if command -v uv >/dev/null 2>&1; then uv venv -q -p 3.12 "$VENV"; else python3 -m venv "$VENV"; fi
fi
PIP="$VENV/bin/python -m pip install -q"
if command -v uv >/dev/null 2>&1; then PIP="uv pip install -q -p $VENV/bin/python"; fi
$PIP torch torchvision onnx onnxruntime onnxconverter-common gdown pillow numpy opencv-python-headless

CKPT="$WORK/p3mnet_pretrained_on_p3m10k.pth"
if [ ! -f "$CKPT" ] || [ "$(sum "$CKPT")" != "$CKPT_SUM" ]; then
  echo "  ↓ P3M-Net ResNet-34 checkpoint (158 MB, Google Drive)"
  "$VENV/bin/gdown" -q "$CKPT_ID" -O "$CKPT.part"
  got="$(sum "$CKPT.part")"
  if [ "$got" != "$CKPT_SUM" ]; then
    rm -f "$CKPT.part"
    echo "✗ checkpoint: sha256 $got, expected $CKPT_SUM" >&2
    exit 1
  fi
  mv "$CKPT.part" "$CKPT"
fi

# --- convert ------------------------------------------------------------------
need=0
[ -f "$DST/p3m_r34_w16.onnx" ] || need=1
if [ "$1" = "--fp16" ] && [ ! -f "$DST/p3m_r34_fp16.onnx" ]; then need=1; fi
if [ "$need" = 1 ]; then
  "$VENV/bin/python" -I scripts/p3m-export.py --core "$WORK/P3M/core" --ckpt "$CKPT" \
    --out "$DST" --verify "$WORK/P3M/samples/original" $1
fi

echo "→ P3M-Net (MIT, evaluation only) + ONNX Runtime Web $ORT_VERSION staged in $DST"
