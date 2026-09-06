#!/usr/bin/env bash
# deploy.sh — copy the static dfmi.app site from the repo to where it is served.
#   site/www/*        → /var/www/html/dfmi.app/   (nginx: dfmi.app home, legal pages, layer pages, og images; needs sudo)
#   site/faucet.html  → /home/ubuntu/faucet/dfmi/ (served by the faucet process at faucet.dfmi.app)
# Backs up each replaced file to <name>.bak-<timestamp>; copies only files that changed; never deletes.
#   bash site/deploy.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WWW_DIR="${WWW_DIR:-/var/www/html/dfmi.app}"
FAUCET_DIR="${FAUCET_DIR:-/home/ubuntu/faucet/dfmi}"
ts=$(date +%Y%m%d-%H%M%S); changed=0
deploy() {  # deploy <src> <target-dir> [sudo]
  local src="$1" dir="$2" pre="${3:-}" name; name=$(basename "$src")
  [ -f "$src" ] || return 0
  [ -d "$dir" ] || { echo "skip $name: $dir not found"; return 0; }
  if [ -f "$dir/$name" ] && cmp -s "$src" "$dir/$name"; then echo "unchanged $name"; return 0; fi
  [ -f "$dir/$name" ] && $pre cp "$dir/$name" "$dir/$name.bak-$ts"
  $pre cp "$src" "$dir/$name"; echo "deployed  $name → $dir"; changed=$((changed+1))
}
for f in "$HERE"/www/*; do deploy "$f" "$WWW_DIR" sudo; done
deploy "$HERE/faucet.html" "$FAUCET_DIR"
echo "$changed file(s) deployed"
