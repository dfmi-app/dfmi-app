#!/usr/bin/env bash
# codex-setup.sh — run the buyer on a ChatGPT subscription via Codex CLI.
#
# Registers buykit's MCP server in ~/.codex/config.toml (appends; idempotent) with the session wallet and key,
# and writes AGENTS.md here with the buyer rules so Codex picks them up when run from this directory.
#
#   export SESSION_WALLET=0x…  SESSION_KEY=0x…  [BUYER_MAX=0.05]
#   bash codex-setup.sh
#   codex login                       # once (headless: codex login --device-auth)
#   codex exec --approve-for-me "Pay invoice inv_…: 0.020287 dUSD to 0x<seller> on eip155:112172."
#
# --approve-for-me is needed: `codex exec` defaults to approval=never, and MCP tool calls require approval.
# Note: this writes SESSION_KEY into ~/.codex/config.toml (mode 600). It is a bounded session key, not the owner's key.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CFG="$HOME/.codex/config.toml"
: "${SESSION_WALLET:?set SESSION_WALLET=0x<session wallet address>}"
: "${SESSION_KEY:?set SESSION_KEY=0x<granted session key>}"

mkdir -p "$HOME/.codex"; touch "$CFG"; chmod 600 "$CFG"
if ! grep -q 'mcp_servers.dfmi-buykit' "$CFG"; then
cat >> "$CFG" <<EOT

[mcp_servers.dfmi-buykit]
command = "node"
args = ["$HERE/../buykit/src/server.mjs"]
env = { SESSION_WALLET = "$SESSION_WALLET", SESSION_KEY = "$SESSION_KEY" }
EOT
echo "added dfmi-buykit to $CFG"
else
echo "dfmi-buykit already in $CFG (edit it by hand if the wallet or key changed)"
fi

node -e "import('$HERE/buyer-core.mjs').then(m => process.stdout.write('# Buyer agent rules\n\n' + m.SYSTEM + '\n\nTools: check_budget, pay_invoice, list_purchases (MCP server dfmi-buykit).\n'))" > "$HERE/AGENTS.md"
echo "wrote $HERE/AGENTS.md"
echo
echo "next:  codex login   (headless: codex login --device-auth)   then, from $HERE:"
echo '       codex exec --approve-for-me "Pay invoice inv_…: 0.020287 dUSD to 0x<seller> on eip155:112172."'
