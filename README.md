# dfmi

**The control plane for agent payments.** Bounded, revocable, intent-scoped credentials for software agents that spend on their own — enforced in the authorization path, not in a log you read after the loss.

dfmi is an open-source research project. It runs on a live, purpose-built EVM chain (`eip155:112172`) with a test settlement unit (`dUSD`) and an x402 facilitator, so that every idea in this repository is exercised by real transactions rather than described in a whitepaper.

- Concepts and walkthrough: <https://dfmi.me>
- Live market, wallet, faucet, developer entry point: <https://dfmi.app>
- Contact: <admin@dfmi.app>

> dfmi is experimental and non-commercial. dUSD is a test unit with no monetary value. See the [Legal Notice](https://dfmi.app/legal.html) and [Terms](https://dfmi.app/terms.html).

## The problem

In a raw x402 / EIP-3009 setup, an autonomous buying agent holds a funded key, and a signed payment authorization is a bearer instrument. If the agent is compromised, the only "revocation" is draining the wallet: you attack the money, not the authority. Coding agents inherited a control plane (sandboxes, `git revert`, CI and review gates). Money has nothing to inherit.

dfmi builds that missing layer as three thin, composable contracts.

## The three layers

| Layer | Question it answers | Contract | Key entry points |
|---|---|---|---|
| **Credential** | How much, until when — and can it be stopped instantly? | [`contracts/SessionKeyWallet.sol`](contracts/SessionKeyWallet.sol) | `grantSession(key, cap, expiry)` · `revokeSession(key)` · `pay(...)` · `ownerWithdraw(...)` |
| **Identity** | Who is the continuing agent behind rotating keys? | [`contracts/AgentRegistry.sol`](contracts/AgentRegistry.sol) | `register(name)` · `bindKey(agentId, key)` · `unbindKey(key)` · `deactivate(agentId)` |
| **Intent** | What is the agent allowed to buy? | [`contracts/IntentSessionWallet.sol`](contracts/IntentSessionWallet.sol) + [`contracts/ServiceRegistry.sol`](contracts/ServiceRegistry.sol) | `grantSession(key, cap, expiry, intentMask)` · `allowed(key, payee)` · `ServiceRegistry.register(payTo, category, label)` |

**Credential.** The agent's operating funds live in the wallet contract, never in the agent's own key. The owner grants a session key with a spend cap and an expiry; the agent signs EIP-712 `Pay(to, amount, nonce, deadline)` messages offline with that session key, and anyone (a relayer, the facilitator) submits them. `pay()` enforces: granted, not revoked, not expired, within cap, correct nonce, valid signature. One `revokeSession()` transaction freezes a compromised agent; every later payment it attempts reverts. The owner can always withdraw.

**Identity.** `AgentRegistry` is a single, global, append-only table. An owner registers an agent once and binds every session key it is ever granted to that `agentId`. History and reputation aggregate by agent across key rotations, and the kill switch gains a second grade: `revokeSession` cancels one card; `deactivate` fires the agent.

**Intent.** `IntentSessionWallet` is the credential wallet with one addition: each session carries an `intentMask`, a 256-bit set of allowed service categories. `ServiceRegistry` gives every payout address a public category (`1 = market-data`, `2 = ai-answers`, `3 = api-tools`, `4 = media`, `5 = compute`, `6..255 = open`). `pay()` resolves the payee's category and enforces membership in the authorization path, next to the revocation gate. "Only market-data services, 1.00 dUSD, 7 days" is one grant. The agent-side flow is unchanged: same EIP-712 `Pay`, same relayer path; intent lives in the grant, not in the signature.

Stated limits, on purpose: `ServiceRegistry` registration is first-come and self-declared, so a malicious seller can mis-categorize itself once. What this MVP proves is that intent *enforcement* needs no new cryptography and no synchronous issuer hop. Trustworthy category *attestation* (curator signatures, stake-and-challenge) is the next problem — an attestation problem, not an enforcement one.

## What is in this repository, and what is not

This repository contains the **protocol layer**: the four contracts above, the build and deploy scripts for the identity and intent layers, and a reference buyer client.

| Path | What it is |
|---|---|
| `contracts/` | The three layers, as Solidity ^0.8.20 (`evmVersion: byzantium` for the AuRa chain) |
| `build-agent-registry.mjs` | Compiles `AgentRegistry.sol` to `agent-registry.json` (`abi`, `bytecode`) |
| `deploy-agent-registry.mjs` | Deploys the global `AgentRegistry` and wires its address into the facilitator config |
| `build-intent.mjs` | Compiles `ServiceRegistry.sol` and `IntentSessionWallet.sol` |
| `deploy-intent-demo.mjs` | One-shot intent-layer demo: deploys the registry and wallet, registers a category, funds the wallet, and grants a session scoped to `market-data` only |
| `buyers/` | `buy.mjs`: an x402 buyer / verification client (exact scheme, EVM) that runs the full loop — 402 → offline signature → paid retry → settlement receipt |
| `paykit/` | **Seller-side toolbox** as an MCP server: `create_invoice` (unique exact amount), `check_payment` (reads the chain; `unknown` is never "unpaid"), `send_reminder` (drafts only), `list_invoices`. Read-only, holds no keys. Plus `pay.mjs`, a buyer-side helper that signs offline and settles through the facilitator with no gas |
| `buykit/` | **Buyer-side toolbox** as an MCP server: `check_budget`, `pay_invoice` (within a `SessionKeyWallet` session, via the facilitator, idempotent), `list_purchases`. Holds a bounded session key, never the owner's key. `grant.mjs` is the owner's issue/revoke tool |
| `seller-agent/` | Reference selling agent: same rules and code-enforced delivery gate on three backends (Claude Agent SDK, any OpenAI-compatible endpoint such as Ollama Cloud, Codex CLI via MCP), plus `seller-serve.mjs`, the seller as an HTTP service another agent can buy from. Delivery happens only after paykit sees settlement on-chain |
| `buyer-agent/` | Reference buying agent on the same three backends; the owner's per-purchase limit is passed into buykit as `max_amount`, so the bound is code, not memory |

Not in this repository, by design: the facilitator (payment verification and settlement service), the chain node configuration, the dUSD contract, and the market front end. These are the **operating layer**; they run the live network at dfmi.app and are kept separate from the protocol contracts so the contracts can be read, reused, and audited on their own.

## Quick start

Build and deploy the identity registry (requires Node 18+, `solc`, `ethers`, and a `.env` with `DEPLOYER_PRIVATE_KEY`; never commit `.env`):

```bash
node build-agent-registry.mjs
node deploy-agent-registry.mjs
```

Buy something on the live market with the reference client (claim test dUSD first from the faucet at dfmi.app):

```bash
cd buyers
npm install
cp .env.example .env   # add BUYER_PRIVATE_KEY
node buy.mjs --help
```

See [`buyers/README.md`](buyers/README.md) for the full claim → buy → read flow.

## Timeline

| When | What |
|---|---|
| May 2026 | Design started: revocation belongs in the credential, not the balance |
| May 2026 | dfmi chain (`eip155:112172`), dUSD, and the x402 facilitator brought up |
| May 2026 | `SessionKeyWallet` (v1: cap, expiry, revoke) deployed and exercised by live purchases |
| 2 August 2026 | dfmi.app and dfmi.me public; Terms, Privacy, and Legal Notice effective |
| 17 August 2026 | Protocol contracts and reference client published in this repository |
| 19 August 2026 | `AgentRegistry` (identity layer) deployed |
| 20 August 2026 | `IntentSessionWallet` + `ServiceRegistry` (intent layer) deployed |
| 6 September 2026 | First agent-to-agent purchase settled on dfmi: seller agent invoiced with `paykit`, buyer paid through the facilitator, seller verified on-chain and delivered — reproduced on Claude, glm-5.3 and gpt-6-astra. `buykit` and the buyer agent published |

The credential layer ran against real transactions for three months before this repository was made public; the public commit history begins at publication, not at the start of the work.

## Design principles

- **The decision lives in the code path, not in the review.** A transaction that violates a grant does not fail an audit; it fails to exist.
- **Simple, binary rules.** Cap, expiry, allowed category. Yes or no. A rule that needs interpretation is a rule an agent can argue with.
- **Revocation is cheap, custody is separate.** The owner key never enters the agent. Revoking a session costs one transaction and never touches the principal.
- **Composable, not lock-in.** dfmi is a layer above settlement. It assumes money that settles instantly and at par, and asks the question the rail cannot: was this agent allowed to send it at all?

## License

MIT. See [`LICENSE`](LICENSE). Copyright (c) 2026 dfmi Labs contributors.
