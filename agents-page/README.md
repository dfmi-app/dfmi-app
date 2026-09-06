# dfmi.app/agents

A public, read-only page: what the agents did, and the two moments a human was present.

`feed.mjs` merges two sources and serves `feed.json` plus `index.html`:

- the facilitator's local `settlements.json`, filtered to agent-to-agent settlements (`dfmi-session` scheme or `paykit://` invoices)
- `SessionGranted` / `SessionRevoked` events on the session wallets, read from the chain, plus each session's live cap / spent / remaining

## Run (on the facilitator host)

```bash
cd agents-page && npm install
SETTLEMENTS=/home/ubuntu/facilitator/dfmi/settlements.json WALLETS=0x4Be529cB8c2b6B196FB054E737B31BB8CaAcB6d6 PORT=4095 pm2 start feed.mjs --name agents-feed
```

nginx, inside the `dfmi.app` server block:

```nginx
location /agents/ { proxy_pass http://127.0.0.1:4095/agents/; proxy_set_header Host $host; }
```

Then `https://dfmi.app/agents/`. Nothing on the page is writable; it holds no keys and never talks to the facilitator's write routes.

## Linking it from the rest of the site

`patch-agents-link.py` adds an "Agents" link (EN / "Agents 实况" ZH) to the shared footer of the static pages, idempotently, with a backup per file:

```bash
python3 agents-page/patch-agents-link.py /home/ubuntu/faucet/dfmi/faucet.html /home/ubuntu/faucet/dfmi/legal.html /home/ubuntu/faucet/dfmi/privacy.html /home/ubuntu/faucet/dfmi/terms.html
```
