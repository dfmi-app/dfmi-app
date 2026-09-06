#!/usr/bin/env bash
# tg-buy.sh — run the buyer agent from a chat channel (OpenClaw exec). Loads secrets from ./.env, never from the chat.
#   bash tg-buy.sh "Buy the market report from the seller at http://192.168.2.71:4444."
#   bash tg-buy.sh "What is my budget?"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a     # SESSION_WALLET, SESSION_KEY, BUYER_MAX, SELLER_URL, CLAUDE_CODE_OAUTH_TOKEN or LLM_API_KEY
: "${SESSION_WALLET:?buyer-agent/.env must set SESSION_WALLET}"; : "${SESSION_KEY:?buyer-agent/.env must set SESSION_KEY}"
RUNNER="${BUYER_RUNNER:-buyer.mjs}"                              # buyer.mjs (Claude) or buyer-ollama.mjs
# Tool-call trace (↳ lines) goes to stderr; chat channels get only the agent's words unless BUYER_TRACE=1.
cd "$HERE"
if [ "${BUYER_TRACE:-0}" = "1" ]; then exec node "$RUNNER" "$*" 2>&1; else exec node "$RUNNER" "$*" 2>/dev/null; fi
