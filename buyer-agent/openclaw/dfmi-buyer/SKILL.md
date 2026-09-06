---
name: dfmi-buyer
description: Buy goods on the dfmi chain through the buyer agent; check its budget; list purchases. Spends only within the session key's on-chain cap.
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# dfmi buyer

You can operate the dfmi buying agent on this machine. It spends from a session key the owner granted; the wallet contract enforces the cap and expiry on-chain, and the owner can revoke the key at any time. You cannot change any of that, and you never handle keys yourself: the agent reads them from its own `.env`.

## When the user asks to buy something, check the budget, or list purchases

Use the `exec` tool to run the buyer agent with the request as its instruction, then relay its output verbatim (transaction hashes, invoice ids and amounts exactly as printed):

```bash
bash ~/dfmi-app/buyer-agent/tg-buy.sh "<the user's request, in English>"
```

Examples:

- "buy the report" → `bash ~/dfmi-app/buyer-agent/tg-buy.sh "Buy the market report from the seller at http://192.168.2.71:4444."`
- "budget?" → `bash ~/dfmi-app/buyer-agent/tg-buy.sh "What is my budget?"`
- "what did we buy" → `bash ~/dfmi-app/buyer-agent/tg-buy.sh "List my purchases."`

The run takes 20 to 90 seconds. Relay the agent's output as-is: its short step lines and, when goods were delivered, the full report text under "Report" exactly as printed (do not summarise it, do not drop lines or numbers). The script already omits the internal tool-call trace. If the agent refused (over cap, revoked, unclear), say so plainly; do not retry, and do not try to pay any other way.

## What you must not do

- Do not construct invoices, amounts or addresses yourself. Only the seller's service issues invoices, and only the buyer agent pays them.
- Do not run `pay.mjs`, `cli.mjs` or anything with keys. `tg-buy.sh` is the only entry point.
- Granting and revoking are the owner's actions on a different machine; if asked, say that.
