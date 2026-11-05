#!/bin/sh
#
# What Vercel runs to build the web deploy (vercel.json's `buildCommand`).
#
# It lives here rather than inline in vercel.json because Vercel caps
# `buildCommand` at 256 characters — and because shell wedged into a JSON string
# is unreadable and unreviewable. Keep the JSON side a bare `sh vercel-build.sh`
# and add steps here.

set -e

# The ~12 MB segmentation runtime, copied out of node_modules (Vercel installs
# devDependencies before running this).
sh seg-assets.sh

# The experimental matting engines (docs/matting-evaluation.md, docs/p3m-evaluation.md),
# staged for EVALUATION so the diagnostic panel's "compare every engine live" can
# run on a real device. They weigh ~355 MB, and every deployment is stored by
# Vercel, so a preview carries them ONLY when PREVIEW_ENGINES=1 is set (project
# env var scoped to Preview, or the Git branch you are evaluating). A production
# deploy carries neither unless RVM_ASSETS=1 / P3M_ASSETS=1 is set on purpose.
#
# RVM: the weights are GPL-3.0 (never shipped from production). ~100 MB of ONNX
# Runtime Web + the MobileNetV3 models.
if { [ "${VERCEL_ENV:-}" = "preview" ] && [ "${PREVIEW_ENGINES:-}" = "1" ]; } || [ "${RVM_ASSETS:-}" = "1" ]; then
  sh scripts/rvm-assets.sh
else
  rm -rf src/assets/rvm
fi

# P3M-Net (MIT): the model (78 MB) and ONNX Runtime Web (29 MB), downloaded and
# sha256-checked. Served same-origin and fetched by a browser only when someone
# picks P3M-Net. Never fatal: without the files P3M-Net falls back to MediaPipe,
# and an experiment must not be able to break a deploy.
if { [ "${VERCEL_ENV:-}" = "preview" ] && [ "${PREVIEW_ENGINES:-}" = "1" ]; } || [ "${P3M_ASSETS:-}" = "1" ]; then
  if ! sh scripts/p3m-fetch.sh; then
    rm -rf src/assets/p3m
    echo "⚠ P3M-Net files unavailable; deploying without them (it falls back to MediaPipe)"
  fi
else
  rm -rf src/assets/p3m
fi

# Stamp the commit and build time for the about panel. Mirrors the Makefile's
# gen-build-info target, but reads Vercel's env var — the deploy is built from a
# shallow checkout where `git rev-parse` is not dependable.
COMMIT=$(echo "${VERCEL_GIT_COMMIT_SHA:-unknown}" | cut -c1-7)
BUILD_DATE=$(date -u +%FT%TZ)
echo "window.VOXAL_COMMIT='$COMMIT';window.VOXAL_WEB_BUILD_DATE='$BUILD_DATE';" \
  > src/build-info.js

echo "→ Build info stamped: $COMMIT at $BUILD_DATE"
