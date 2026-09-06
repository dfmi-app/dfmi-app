#!/usr/bin/env bash
# deploy.sh — copy the static dfmi.app pages from the repo into the directory the faucet process serves.
#   bash site/deploy.sh                 # target defaults to /home/ubuntu/faucet/dfmi
#   bash site/deploy.sh /some/other/dir
# Backs up each replaced file to <name>.bak-<timestamp>; only copies files that actually changed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-/home/ubuntu/faucet/dfmi}"
[ -d "$TARGET" ] || { echo "target $TARGET not found"; exit 1; }
ts=$(date +%Y%m%d-%H%M%S); changed=0
for f in "$HERE"/*.html; do
  name=$(basename "$f")
  if [ -f "$TARGET/$name" ] && cmp -s "$f" "$TARGET/$name"; then echo "unchanged $name"; continue; fi
  [ -f "$TARGET/$name" ] && cp "$TARGET/$name" "$TARGET/$name.bak-$ts"
  cp "$f" "$TARGET/$name"; echo "deployed  $name"; changed=$((changed+1))
done
echo "$changed file(s) deployed to $TARGET"
