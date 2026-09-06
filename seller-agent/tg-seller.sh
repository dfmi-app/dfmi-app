#!/usr/bin/env bash
# tg-seller.sh — ask the seller agent something from a chat channel (OpenClaw exec). Secrets from ./.env, never from the chat.
#   bash tg-seller.sh "Has inv_9f308d442800 been paid?"
#   bash tg-seller.sh "List open invoices and draft a polite reminder for each."
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a     # SELLER_ADDRESS, CLAUDE_CODE_OAUTH_TOKEN or LLM_API_KEY
: "${SELLER_ADDRESS:?seller-agent/.env must set SELLER_ADDRESS}"
RUNNER="${SELLER_RUNNER:-seller.mjs}"                             # seller.mjs (Claude) or seller-ollama.mjs
cd "$HERE" && exec node "$RUNNER" "$*" 2>&1
