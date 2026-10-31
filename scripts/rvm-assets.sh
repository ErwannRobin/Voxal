#!/bin/sh
#
# Stage the EXPERIMENTAL Robust Video Matting engine into src/assets/rvm/.
#
# For the matting evaluation only (docs/matting-evaluation.md). Nothing here is
# committed or bundled into a desktop/mobile app. The one place it is deployed
# is the web PREVIEW build (vercel-build.sh), so the engine can be evaluated
# on real devices; a production deploy only carries it with RVM_ASSETS=1:
#
#   * RVM (https://github.com/PeterL1n/RobustVideoMatting) is GPL-3.0, and its
#     weights come with no other licence. Voxal is MIT and ships store builds,
#     so the weights must never reach the repository or a release. The
#     directory is gitignored, `make cap-sync` strips it from the mobile apps
#     and the desktop build targets delete it (`make rvm-clean`).
#   * ONNX Runtime Web (MIT) runs the model. It is fetched here rather than
#     added to package.json: ~150 MB of npm package for an opt-in experiment is
#     not a dependency worth carrying.
#
# Every file is pinned by version AND sha256, so a re-tagged release or a CDN
# that serves something else fails loudly instead of benchmarking a stranger.
#
# Usage: sh scripts/rvm-assets.sh [--with-resnet]   (make rvm-assets)
#   --with-resnet  also the ResNet50 variants (+160 MB)

set -e

# macOS has shasum, a Linux build image may only have sha256sum.
if command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else sha() { sha256sum "$1" | cut -d' ' -f1; }; fi

DST="src/assets/rvm"
ORT_VERSION="1.30.0"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"
RVM_BASE="https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0"

ORT_FILES="
2e4a0eae53c3f246e26423aaca493d3bfc22ce524894f27519a9ec4a14e6397a ort.all.min.mjs
e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b ort-wasm-simd-threaded.mjs
3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2 ort-wasm-simd-threaded.wasm
3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28 ort-wasm-simd-threaded.asyncify.mjs
39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da ort-wasm-simd-threaded.asyncify.wasm
709853412fd1ffc34247af1e73569227b5b79629c5ca3f59cc39cf7e500e4947 ort-wasm-simd-threaded.jsep.mjs
3ad23231b5bd6d9dda55a7f84606315e0bf35b6750c28ee993c987c54cacab0f ort-wasm-simd-threaded.jsep.wasm
"
RVM_FILES="
88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828 rvm_mobilenetv3_fp32.onnx
6a0d5ce6cc17702613be548559879b4521ed424cfe14ddc48d1acaa44d616f64 rvm_mobilenetv3_fp16.onnx
"
RESNET_FILES="
25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c rvm_resnet50_fp32.onnx
a9266f5046411d604bbff38e18c54bf8c70d85d93bbc400564697590f5712738 rvm_resnet50_fp16.onnx
"
if [ "$1" = "--with-resnet" ]; then RVM_FILES="$RVM_FILES$RESNET_FILES"; fi

mkdir -p "$DST"

fetch() { # base sum name
  out="$DST/$3"
  if [ -f "$out" ] && [ "$(sha "$out")" = "$2" ]; then return 0; fi
  echo "  ↓ $3"
  curl -sfL --retry 3 -o "$out.part" "$1/$3"
  got="$(sha "$out.part")"
  if [ "$got" != "$2" ]; then
    rm -f "$out.part"
    echo "✗ $3: sha256 $got, expected $2" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}

echo "$ORT_FILES" | while read -r sum name; do if [ -n "$name" ]; then fetch "$ORT_BASE" "$sum" "$name"; fi; done
echo "$RVM_FILES" | while read -r sum name; do if [ -n "$name" ]; then fetch "$RVM_BASE" "$sum" "$name"; fi; done

echo "→ RVM (GPL-3.0, evaluation only) + ONNX Runtime Web $ORT_VERSION staged in $DST"
