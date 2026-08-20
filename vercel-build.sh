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

# Stamp the commit and build time for the about panel. Mirrors the Makefile's
# gen-build-info target, but reads Vercel's env var — the deploy is built from a
# shallow checkout where `git rev-parse` is not dependable.
COMMIT=$(echo "${VERCEL_GIT_COMMIT_SHA:-unknown}" | cut -c1-7)
BUILD_DATE=$(date -u +%FT%TZ)
echo "window.VOXAL_COMMIT='$COMMIT';window.VOXAL_WEB_BUILD_DATE='$BUILD_DATE';" \
  > src/build-info.js

echo "→ Build info stamped: $COMMIT at $BUILD_DATE"
