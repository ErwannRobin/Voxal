#!/bin/sh
# Run the E2E spec files you have edited (the `unit` Playwright project) —
# what `make test-e2e-changed` runs. It is the manual counterpart of what the
# pre-push hook used to run on its own: the hook only reminds you now, because a
# spec file with software-GPU tests can take minutes.
#
# "Edited" = changed on this branch since it forked from main (committed), plus
# anything modified, staged or untracked in the working tree. Mesh and benchmark
# specs are left out (their own make targets); the helpers in tests/e2e are not
# specs. BASE=<ref> overrides where "since" starts.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

base="${BASE:-$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo HEAD)}"

specs=$({
  git diff --name-only "$base" HEAD
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | grep -E '^tests/e2e/[^/]+\.(spec|test)\.js$' | grep -Ev '/(mesh|bench)[^/]*$' | sort -u |
  while read -r f; do [ -f "$f" ] && echo "$f"; done)

if [ -z "$specs" ]; then
  echo "No E2E spec file edited since ${base%${base#????????}} — nothing to run (make test-e2e runs the whole unit suite)."
  exit 0
fi

echo "E2E specs edited since ${base%${base#????????}}:"
printf '  %s\n' $specs
# shellcheck disable=SC2086
NODE_OPTIONS=--disable-warning=DEP0205 exec npx playwright test --project=unit $specs
