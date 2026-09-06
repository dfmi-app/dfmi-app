#!/usr/bin/env bash
# codex-setup.sh — run the seller on a ChatGPT subscription via Codex CLI.
#
# Registers paykit and goods-server as MCP servers in ~/.codex/config.toml (appends; idempotent),
# and writes AGENTS.md here with the seller rules so Codex picks them up when run from this directory.
#
#   export SELLER_ADDRESS=0x...
#   bash codex-setup.sh
#   codex login                       # once, with the ChatGPT account
#   codex exec --approve-for-me "Sell the market report to 0x<buyer> for 0.02 dUSD, due in 7 days."
#
# --approve-for-me is needed: `codex exec` defaults to approval=never, and MCP tool calls require approval,
# so without it every paykit call fails with "MCP tool call requires approval". Headless login: `codex login --device-auth`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CFG="$HOME/.codex/config.toml"
: "${SELLER_ADDRESS:?set SELLER_ADDRESS=0x<your payee address> first}"

mkdir -p "$HOME/.codex"; touch "$CFG"
if ! grep -q 'mcp_servers.dfmi-paykit' "$CFG"; then
cat >> "$CFG" <<EOF

[mcp_servers.dfmi-paykit]
command = "node"
args = ["$HERE/../paykit/src/server.mjs"]

[mcp_servers.seller-goods]
command = "node"
args = ["$HERE/goods-server.mjs"]
env = { SELLER_ADDRESS = "$SELLER_ADDRESS" }
EOF
echo "added dfmi-paykit and seller-goods to $CFG"
else
echo "MCP servers already in $CFG"
fi

node -e "import('$HERE/seller-core.mjs').then(m => process.stdout.write('# Seller agent rules\n\n' + m.SYSTEM + '\n\nTools: create_invoice, check_payment, send_reminder, list_invoices (MCP server dfmi-paykit) and deliver_goods (MCP server seller-goods).\n'))" > "$HERE/AGENTS.md"
echo "wrote $HERE/AGENTS.md (payee $SELLER_ADDRESS)"
echo
echo "next:  codex login   (headless: codex login --device-auth)   then, from $HERE:"
echo '       codex exec --approve-for-me "Sell the market report to 0x<buyer> for 0.02 dUSD, due in 7 days."'
