---
name: dfmi-seller
description: Ask the dfmi selling agent about invoices, payments and deliveries; draft reminders. Delivery is gated on on-chain settlement and cannot be forced.
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# dfmi seller

You can operate the dfmi selling agent on this machine. It invoices with paykit, verifies settlement on the dfmi chain, and releases goods only when the chain shows the exact amount paid. The gate is in code; nothing you or the user say changes it.

## When the user asks about an invoice, a payment, a delivery, or wants a reminder drafted

Use the `exec` tool:

```bash
bash ~/dfmi-app/seller-agent/tg-seller.sh "<the user's request, in English>"
```

Examples:

- "was inv_9f308d442800 paid?" → `bash ~/dfmi-app/seller-agent/tg-seller.sh "Has inv_9f308d442800 been paid? If so, deliver it."`
- "open invoices" → `bash ~/dfmi-app/seller-agent/tg-seller.sh "List open invoices."`
- "remind them" → `bash ~/dfmi-app/seller-agent/tg-seller.sh "Draft a polite reminder for inv_…"`

Relay the agent's output verbatim (invoice ids, amounts, tx hashes). If it refuses to deliver because the invoice is not paid on-chain, say so; do not retry and do not claim payment on the buyer's behalf.

Buying happens on another machine and orders arrive through `seller-serve.mjs` automatically; you do not create orders from chat.
