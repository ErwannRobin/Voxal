#!/bin/sh
#
# Download and convert the matting CANDIDATES the lab engine runs
# (src/lab-engine.js, docs/matting-candidates.md) into src/assets/lab/.
#
# Measurement only: nothing here is committed, shipped or bundled. The same
# files are published in the `matting-models-v1` prerelease for preview deploys
# (scripts/matting-models-fetch.sh, PREVIEW_ENGINES=1).
# Some candidates carry licences Voxal could not ship (RMBG-1.4: BRIA
# non-commercial); the Makefile deletes src/assets/lab before every desktop
# build and strips it from every other build; vercel-build.sh deletes it
# outside a PREVIEW_ENGINES=1 preview.
#
#   * MODNet photographic (Apache-2.0): Xenova/modnet's ONNX export, as is.
#   * MODNet webcam (Apache-2.0): the official checkpoint (Google Drive),
#     exported by scripts/lab-export-torch.py.
#   * SGHM ResNet-50 (MIT): the official checkpoint (Google Drive), exported
#     by scripts/lab-export-torch.py with its alpha fusion in the graph.
#   * PP-HumanSegV2 Lite / Mobile and PP-MattingV2 (Apache-2.0, PaddleSeg's
#     inference models): converted by scripts/lab-export-paddle.py at a fixed
#     size, each checked against Paddle's own predictor.
#   * BiRefNet lite (MIT): onnx-community's 1024x1024 ONNX export, as is
#     (its deformable convolutions do not re-export on current PyTorch).
#   * RMBG-1.4 (BRIA non-commercial): briaai's own ONNX export, as is.
#   * MediaPipe selfie multiclass (Apache-2.0): Google's .tflite, run by the
#     MediaPipe runtime already staged by seg-assets.sh.
#   * ONNX Runtime Web 1.30.0: the same three files P3M-Net uses.
#
# Needs uv (two Python venvs under .cache/lab: PyTorch, and PaddlePaddle).
# Usage: sh scripts/lab-assets.sh

set -e

DST="src/assets/lab"
WORK=".cache/lab"
HF="https://huggingface.co"
PD="https://paddleseg.bj.bcebos.com"
mkdir -p "$DST" "$WORK"

command -v uv >/dev/null 2>&1 || { echo "✗ lab-assets needs uv (https://docs.astral.sh/uv/)" >&2; exit 1; }

get() { # url out
  [ -s "$2" ] && return 0
  echo "  ↓ $(basename "$2")"
  curl -sfL --retry 3 -o "$2.part" "$1"
  mv "$2.part" "$2"
}

FETCH_DST="$DST" sh scripts/p3m-fetch.sh --runtime-only

# --- as published ------------------------------------------------------------
get "$HF/Xenova/modnet/resolve/main/onnx/model.onnx" "$DST/modnet_fp32.onnx"
get "$HF/Xenova/modnet/resolve/main/onnx/model_fp16.onnx" "$DST/modnet_fp16.onnx"
get "$HF/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx" "$DST/birefnet_lite_fp16.onnx"
get "$HF/briaai/RMBG-1.4/resolve/main/onnx/model_fp16.onnx" "$DST/rmbg14_fp16.onnx"
get "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite" \
  "$DST/selfie_multiclass_256x256.tflite"

# --- PaddleSeg ---------------------------------------------------------------
PV="$WORK/paddle"
if [ ! -x "$PV/bin/python" ]; then
  echo "  … Python venv for PaddlePaddle (once)"
  uv venv -q -p 3.11 "$PV"
  uv pip install -q -p "$PV/bin/python" paddlepaddle paddle2onnx onnx onnxruntime numpy setuptools
fi
paddle() { # zip-url dir-in-zip out.onnx h w
  [ -s "$DST/$3" ] && return 0
  z="$WORK/$(basename "$1")"
  get "$1" "$z"
  [ -d "$WORK/$2" ] || unzip -oq "$z" -d "$WORK"
  FLAGS_enable_pir_api=0 "$PV/bin/python" -I scripts/lab-export-paddle.py "$WORK/$2" "$DST/$3" "$4" "$5"
}
paddle "$PD/dygraph/pp_humanseg_v2/portrait_pp_humansegv2_lite_256x144_smaller/portrait_pp_humansegv2_lite_256x144_inference_model_with_softmax.zip" \
  portrait_pp_humansegv2_lite_256x144_inference_model_with_softmax pphs_v2_lite_256x144.onnx 144 256
paddle "$PD/dygraph/pp_humanseg_v2/human_pp_humansegv2_mobile_192x192_inference_model_with_softmax.zip" \
  human_pp_humansegv2_mobile_192x192_inference_model_with_softmax pphs_v2_mobile_192.onnx 192 192
paddle "$PD/matting/models/deploy/ppmattingv2-stdc1-human_512.zip" \
  ppmattingv2-stdc1-human_512 ppmattingv2_512x512.onnx 512 512

# --- PyTorch -----------------------------------------------------------------
TV="$WORK/torch"
if [ ! -x "$TV/bin/python" ]; then
  echo "  … Python venv for PyTorch (~1 GB, once)"
  uv venv -q -p 3.11 "$TV"
  uv pip install -q -p "$TV/bin/python" torch torchvision onnx onnxruntime gdown numpy pillow opencv-python-headless
fi
[ -d "$WORK/MODNet/.git" ] || git clone -q --depth 1 https://github.com/ZHKKKe/MODNet.git "$WORK/MODNet"
[ -d "$WORK/SGHM/.git" ] || git clone -q --depth 1 https://github.com/cxgincsu/SemanticGuidedHumanMatting.git "$WORK/SGHM"
if [ ! -s "$DST/modnet_webcam_fp32.onnx" ]; then
  # MODNet's README: "pretrained" folder on Google Drive.
  [ -s "$WORK/modnet_ckpt/modnet_webcam_portrait_matting.ckpt" ] ||
    "$TV/bin/python" -m gdown -q --folder 1umYmlCulvIFNaqPjwod1SayFmSRHziyR -O "$WORK/modnet_ckpt"
  "$TV/bin/python" scripts/lab-export-torch.py modnet-webcam --repo "$WORK/MODNet" \
    --ckpt "$WORK/modnet_ckpt/modnet_webcam_portrait_matting.ckpt" --out "$DST/modnet_webcam_fp32.onnx"
fi
if [ ! -s "$DST/sghm_r50_fp32.onnx" ]; then
  # SGHM's README: "pretrained weights" folder on Google Drive.
  [ -s "$WORK/sghm_ckpt/SGHM-ResNet50.pth" ] ||
    "$TV/bin/python" -m gdown -q --folder 15mGzPJQFEchaZHt9vgbmyOy46XxWtEOZ -O "$WORK/sghm_ckpt"
  "$TV/bin/python" scripts/lab-export-torch.py sghm --repo "$WORK/SGHM" \
    --ckpt "$WORK/sghm_ckpt/SGHM-ResNet50.pth" --out "$DST/sghm_r50_fp32.onnx"
fi

echo "→ matting candidates (local measurement only) staged in $DST"
