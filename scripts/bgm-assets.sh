#!/bin/sh
#
# Stage the EXPERIMENTAL BackgroundMattingV2 engine into src/assets/bgm/.
#
# For the BackgroundMattingV2 evaluation (docs/bgm-evaluation.md). Nothing here
# is committed or shipped yet: code and weights are MIT
# (https://github.com/PeterL1n/BackgroundMattingV2), and so is ONNX Runtime
# Web, so the files COULD ship; they are kept out until the evaluation says
# they are worth a download.
#
#   * The official checkpoint (MobileNetV2, pytorch_mobilenetv2.pth, 20 MB) is
#     an asset of the repository's v1.0.0 release, pinned by sha256. It is
#     converted here to ONNX by scripts/bgm-export.py, which needs PyTorch: a
#     private venv under .cache/bgm/ is made with `uv` (or python3 -m venv).
#     The release's own ONNX files are NOT used: they select patches with
#     TopK / NonZero / RoiAlign / ScatterElements, which ONNX Runtime Web's
#     WebGPU backend cannot run (see the export script).
#   * The browser loads bgm_mnv2_s<NN>_w16.onnx (10 MB: weights stored as half
#     floats, computed in float32) or the _fp32 file (20 MB), NN = the
#     backbone's scale x 100 (25 or 50), with ONNX Runtime Web 1.30.0 — the
#     same pinned files as P3M-Net (scripts/p3m-fetch.sh --runtime-only).
#
# Inputs are pinned (checkpoint by sha256, code by commit). The export checks
# itself against the original module and prints the difference; with the
# matting footage built (make matting-footage) it checks on a real frame.
#
# Usage: sh scripts/bgm-assets.sh   (make bgm-assets)

set -e

DST="src/assets/bgm"
WORK=".cache/bgm"
REPO="https://github.com/PeterL1n/BackgroundMattingV2.git"
COMMIT="a8e82df9f594578edf287dbb2b289ebcc50fbf00"
CKPT_URL="https://github.com/PeterL1n/BackgroundMattingV2/releases/download/v1.0.0/pytorch_mobilenetv2.pth"
CKPT_SUM="bd7d8d72f31cb77c2216d0b35afd3d19f203b48e6fb7187850fc6e5a5db57256"

mkdir -p "$DST" "$WORK"

if command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sum() { sha256sum "$1" | cut -d' ' -f1; }
fi

# ONNX Runtime Web: the same pinned files P3M-Net uses.
FETCH_DST="$DST" sh scripts/p3m-fetch.sh --runtime-only

# --- the official code and checkpoint ---------------------------------------
if [ ! -d "$WORK/BackgroundMattingV2/.git" ]; then
  echo "  ↓ BackgroundMattingV2 code @ ${COMMIT%"${COMMIT#???????}"}"
  git clone -q "$REPO" "$WORK/BackgroundMattingV2"
fi
git -C "$WORK/BackgroundMattingV2" -c advice.detachedHead=false checkout -q "$COMMIT"

CKPT="$WORK/pytorch_mobilenetv2.pth"
if [ ! -f "$CKPT" ] || [ "$(sum "$CKPT")" != "$CKPT_SUM" ]; then
  echo "  ↓ BackgroundMattingV2 MobileNetV2 checkpoint (20 MB)"
  curl -sfL --retry 3 -o "$CKPT.part" "$CKPT_URL"
  got="$(sum "$CKPT.part")"
  if [ "$got" != "$CKPT_SUM" ]; then
    rm -f "$CKPT.part"
    echo "✗ checkpoint: sha256 $got, expected $CKPT_SUM" >&2
    exit 1
  fi
  mv "$CKPT.part" "$CKPT"
fi

# --- a venv with PyTorch, for the conversion only ---------------------------
VENV="$WORK/venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "  … Python venv for the conversion (PyTorch, ~1 GB, once)"
  if command -v uv >/dev/null 2>&1; then uv venv -q -p 3.12 "$VENV"; else python3 -m venv "$VENV"; fi
fi
PIP="$VENV/bin/python -m pip install -q"
if command -v uv >/dev/null 2>&1; then PIP="uv pip install -q -p $VENV/bin/python"; fi
$PIP torch torchvision onnx onnxruntime pillow numpy

# --- convert ------------------------------------------------------------------
if [ ! -f "$DST/bgm_mnv2_s25_w16.onnx" ] || [ ! -f "$DST/bgm_mnv2_s50_w16.onnx" ]; then
  FOOT="bench-results/matting/footage/living"
  VERIFY=""
  if [ -f "$FOOT/0150.jpg" ] && [ -f "$FOOT/plate.png" ]; then
    VERIFY="--verify-src $FOOT/0150.jpg --verify-bgr $FOOT/plate.png"
  fi
  # shellcheck disable=SC2086
  "$VENV/bin/python" -I scripts/bgm-export.py --repo "$WORK/BackgroundMattingV2" --ckpt "$CKPT" \
    --out "$DST" $VERIFY
fi

echo "→ BackgroundMattingV2 (MIT, evaluation only) + ONNX Runtime Web staged in $DST"
