#!/bin/sh

REPO="ErwannRobin/Voxel"

LOCAL_SHA=$(git rev-parse HEAD)
LOCAL_SHORT=$(git rev-parse --short HEAD)

REMOTE_SHA=$(gh api "repos/$REPO/branches/main" --jq '.commit.sha' 2>/dev/null)
REMOTE_SHORT=${REMOTE_SHA:0:7}

# Ahead/behind relative to remote main
AHEAD=$(git rev-list --count "origin/main..HEAD" 2>/dev/null || echo "?")
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo "?")

echo "=== local HEAD ($LOCAL_SHORT) ==="
gh api "repos/$REPO/commits/$LOCAL_SHA/status" --jq '.state' | cat

echo ""
echo "=== remote main ($REMOTE_SHORT) ==="
gh api "repos/$REPO/commits/$REMOTE_SHA/status" --jq '.state' | cat

echo ""
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "local == remote main"
else
  echo "local is $AHEAD ahead, $BEHIND behind remote main"
fi

# Watch remote main until success or timeout (5 min, poll every 15 s)
TIMEOUT=300
INTERVAL=15
ELAPSED=0

INITIAL_STATE=$(gh api "repos/$REPO/commits/$REMOTE_SHA/status" --jq '.state' | cat)
if [ "$INITIAL_STATE" = "success" ]; then
  exit 0
fi

echo ""
echo "Watching remote main ($REMOTE_SHORT) — timeout in ${TIMEOUT}s …"
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
  STATE=$(gh api "repos/$REPO/commits/$REMOTE_SHA/status" --jq '.state' | cat)
  printf "[%3ds] %s\n" "$ELAPSED" "$STATE"
  if [ "$STATE" = "success" ]; then
    echo "✓ remote main is deployed"
    exit 0
  fi
done

echo "✗ timed out after ${TIMEOUT}s — last state: $STATE"
exit 1

