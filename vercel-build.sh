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
# Whether this is such a preview: PREVIEW_ENGINES=1, or no setting at all for
# a branch named `preview-engines/*` (or `feature/preview-all-engines`), so a
# branch opened to evaluate the engines gets them without touching Vercel.
# VERCEL_GIT_COMMIT_REF is a Vercel system variable (the branch being built).
ENGINES_PREVIEW=0
if [ "${VERCEL_ENV:-}" = "preview" ]; then
  case "${PREVIEW_ENGINES:-}|${VERCEL_GIT_COMMIT_REF:-}" in
    1\|*|*\|preview-engines/*|*\|feature/preview-all-engines) ENGINES_PREVIEW=1 ;;
  esac
fi
if [ "$ENGINES_PREVIEW" = "1" ]; then
  echo "→ Preview with every experimental matting engine (branch ${VERCEL_GIT_COMMIT_REF:-?})"
fi

# RVM: the weights are GPL-3.0 (never shipped from production). ~100 MB of ONNX
# Runtime Web + the MobileNetV3 models.
if [ "$ENGINES_PREVIEW" = "1" ] || [ "${RVM_ASSETS:-}" = "1" ]; then
  sh scripts/rvm-assets.sh
else
  rm -rf src/assets/rvm
fi

# P3M-Net (MIT): the model (78 MB) and ONNX Runtime Web (29 MB), downloaded and
# sha256-checked. Served same-origin and fetched by a browser only when someone
# picks P3M-Net. Never fatal: without the files P3M-Net falls back to MediaPipe,
# and an experiment must not be able to break a deploy.
if [ "$ENGINES_PREVIEW" = "1" ] || [ "${P3M_ASSETS:-}" = "1" ]; then
  if ! sh scripts/p3m-fetch.sh; then
    rm -rf src/assets/p3m
    echo "⚠ P3M-Net files unavailable; deploying without them (it falls back to MediaPipe)"
  fi
else
  rm -rf src/assets/p3m
fi

# BackgroundMattingV2 (MIT, docs/bgm-evaluation.md) and the matting lab's
# candidates (src/lab-engine.js, docs/matting-candidates.md): converted once and
# published as the `matting-models-v1` prerelease, sha256-pinned in
# scripts/matting-models-fetch.sh. Those previews only (ENGINES_PREVIEW above)
# (~660 MB on top of RVM/P3M): never production, because one lab candidate
# (RMBG-1.4) is non-commercial and the rest are measurement, not product.
# Never fatal: without the files each engine falls back to MediaPipe.
if [ "$ENGINES_PREVIEW" = "1" ]; then
  if ! sh scripts/matting-models-fetch.sh; then
    rm -rf src/assets/bgm src/assets/lab
    echo "⚠ matting model files unavailable; deploying without them (BGMv2 / the lab fall back to MediaPipe)"
  fi
else
  rm -rf src/assets/bgm src/assets/lab
fi

# Stamp the commit and build time for the about panel. Mirrors the Makefile's
# gen-build-info target, but reads Vercel's env var — the deploy is built from a
# shallow checkout where `git rev-parse` is not dependable.
COMMIT=$(echo "${VERCEL_GIT_COMMIT_SHA:-unknown}" | cut -c1-7)
BUILD_DATE=$(date -u +%FT%TZ)
echo "window.VOXAL_COMMIT='$COMMIT';window.VOXAL_WEB_BUILD_DATE='$BUILD_DATE';" \
  > src/build-info.js

echo "→ Build info stamped: $COMMIT at $BUILD_DATE"
