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
#     1.30.0, fetched by scripts/p3m-fetch.sh --runtime-only.
#   * The web deploy does not run this: it downloads the w16 file this script
#     produced, published as a release asset (scripts/p3m-fetch.sh).
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
P3M_REPO="https://github.com/JizhiziLi/P3M.git"
P3M_COMMIT="9f9390f2bc8e93173a9bb8e46102bf32a3c2b825"
CKPT_ID="1smX2YQGIpzKbfwDYHAwete00a_YMwoG1"   # README: "Pretrained P3M-NET on P3M-10k"
CKPT_SUM="55ee038cecb9349cd17e81bddaccbf5c92ebd1700b9e70a47125d914ac6d25bf"

mkdir -p "$DST" "$WORK"

if command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sum() { sha256sum "$1" | cut -d' ' -f1; }
fi

# ONNX Runtime Web: the same pinned files the web deploy downloads.
sh scripts/p3m-fetch.sh --runtime-only

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

echo "→ P3M-Net (MIT, evaluation only) + ONNX Runtime Web staged in $DST"
