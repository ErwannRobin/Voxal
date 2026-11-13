#!/bin/sh
#
# Download the EXPERIMENTAL BackgroundMattingV2 engine (src/assets/bgm/) and
# the matting lab's candidate models (src/assets/lab/), each with the pinned
# ONNX Runtime Web build that runs it.
#
# This is how a Vercel PREVIEW deploy built with PREVIEW_ENGINES=1 gets them
# (vercel-build.sh), and the quick way to get them locally
# (make matting-models-fetch) without PyTorch or uv. Nothing is committed.
# scripts/bgm-assets.sh and scripts/lab-assets.sh are the other way: they
# convert the upstream checkpoints themselves, and produced the files
# published here.
#
#   * The models: assets of the `matting-models-v1` PRERELEASE of this
#     repository (a prerelease, so the desktop updater's releases/latest never
#     sees it). Each keeps its upstream licence, listed in the release notes
#     and docs/matting-candidates.md. RMBG-1.4 is BRIA's NON-COMMERCIAL
#     licence: evaluation only, never in a production deploy or an app build.
#   * ONNX Runtime Web: scripts/p3m-fetch.sh --runtime-only, into each folder.
#
# Every file is pinned by sha256; a mismatch deletes the download and fails.
#
# Usage: sh scripts/matting-models-fetch.sh [bgm] [lab]   (no argument = both)

set -e

MODEL_BASE="https://github.com/ErwannRobin/Voxal/releases/download/matting-models-v1"

BGM_FILES="
af549c103cd20adfaeb1f26b7e051e6c17495c7cef50dc6705ef52130f638590 bgm_mnv2_s25_w16.onnx
0658675bf70bb6bee6234199db3e09ca160383a9d70d75400378659015b06ae3 bgm_mnv2_s50_w16.onnx
eb44db629063061406fe7892c62aeddecd40a0119ec86c6b52f10a22cc144fb3 bgm_mnv2_s25_fp32.onnx
a59945b0a492f4a3a81849eca9a8c954411eeeb37be947ef4f8bd2c109c07511 bgm_mnv2_s50_fp32.onnx
"
LAB_FILES="
07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9 modnet_fp32.onnx
25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6 modnet_fp16.onnx
84dc65dd9c4d9c6de2be74db8ab176c8a2941e25d4fbca72dc8c0e03188e7fe0 modnet_webcam_fp32.onnx
df38e1ed66981adb3107e54fba56a5f9d54e35264617feaf259ae42771a1fc4c pphs_v2_lite_256x144.onnx
c2dfde21a8df9bc4114b992e525daef515f1389c580026a9d12faa206b885bd8 pphs_v2_mobile_192.onnx
6db44f1fc3dd6c7e410f46269e39be33b3787b11bfdce14ab2db4335bb3ba8d7 ppmattingv2_512x512.onnx
a29c35271e80e9aeaa6a2872ad2111580784ad210b6e3766ec1cf39724a8fbd4 sghm_r50_fp32.onnx
d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402 birefnet_lite_fp16.onnx
9fdfdb41866d872e0acf4a010c35c1a8547bf0eebe0d1544406bbf1c824cb59d rmbg14_fp16.onnx
c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0 selfie_multiclass_256x256.tflite
"

# shasum on macOS, sha256sum on the Linux build image.
if command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sum() { sha256sum "$1" | cut -d' ' -f1; }
fi

fetch() { # dst sum name
  out="$1/$3"
  if [ -f "$out" ] && [ "$(sum "$out")" = "$2" ]; then return 0; fi
  echo "  ↓ $3"
  curl -sfL --retry 3 -o "$out.part" "$MODEL_BASE/$3"
  got="$(sum "$out.part")"
  if [ "$got" != "$2" ]; then
    rm -f "$out.part"
    echo "✗ $3: sha256 $got, expected $2" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}

stage() { # name files
  dst="src/assets/$1"
  mkdir -p "$dst"
  FETCH_DST="$dst" sh scripts/p3m-fetch.sh --runtime-only >/dev/null
  echo "$2" | while read -r s name; do if [ -n "$name" ]; then fetch "$dst" "$s" "$name"; fi; done
  echo "→ $1 (experimental) files in $dst"
}

want="${*:-bgm lab}"
for w in $want; do
  case "$w" in
    bgm) stage bgm "$BGM_FILES" ;;
    lab) stage lab "$LAB_FILES" ;;
    *) echo "unknown set: $w (bgm, lab)" >&2; exit 2 ;;
  esac
done
