// seller.mjs — the drill's seller: the published x402-lib (the same seller library the live sellers run) with a
// trivial product. Started, killed and restarted by payment-faults.mjs; all of its settings come from the environment.
import { createServer } from 'node:http';
import { existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = [process.env.X402_LIB_DIR, join(HERE, '../../wangvc-seller/x402-lib'), join(HERE, '../../lib')].find((d) => d && existsSync(join(d, 'seller-kit.mjs')));
if (!LIB) throw new Error('x402-lib not found: set X402_LIB_DIR');
const { makeSellerKit, listen, SERVER_OPTS } = await import(pathToFileURL(join(resolve(LIB), 'seller-kit.mjs')).href);

const E = process.env, PORT = Number(E.PORT), PATH = '/report';
const RESOURCE = `http://127.0.0.1:${PORT}${PATH}`;
const REQUIREMENTS = { scheme: 'exact', network: `eip155:${E.CHAIN_ID}`, maxAmountRequired: E.PRICE, asset: E.TOKEN, payTo: E.PAY_TO, resource: RESOURCE,
  description: 'drill report', mimeType: 'application/json', maxTimeoutSeconds: 300, extra: { name: 'DFMI Dollar', version: '1' } };
// DRILL_RECOVER=deliver|refund: declare the offer, so that orders paid on chain but missing from the database are rebuilt
const kit = makeSellerKit({ name: 'drill-seller', dbFile: E.ORDERS_DB, facilitator: E.FAC_URL, env: E, sweepMs: Number(E.ORDER_SWEEP_MS || 300),
  chain: { rpc: E.RPC_URL, token: E.TOKEN, chainId: Number(E.CHAIN_ID), gasPriceGwei: 1 },
  recover: E.DRILL_RECOVER ? [{ requirements: REQUIREMENTS, mode: E.DRILL_RECOVER }] : [] });
// every onDelivered callback is appended here, so the drill can count them (one per order)
const onDelivered = E.DRILL_DELIVERED_FILE ? (o) => appendFileSync(E.DRILL_DELIVERED_FILE, o.id + '\n') : null;
// DRILL_PRODUCE=fail: the product can never be made (an upstream that is down for good) → the order must be refunded
const produce = async () => { if (E.DRILL_PRODUCE === 'fail') throw new Error('upstream unavailable (drill)'); return { report: 'drill', at: new Date().toISOString() }; };
const server = createServer(SERVER_OPTS, kit.serve(async (req, res, { send, url }) => {
  if (url.pathname !== PATH) return send(404, { error: 'not found' });
  return kit.sell(req, res, { requirements: REQUIREMENTS, produce, onDelivered });
}));
kit.startSweeper(() => produce);
listen(server, PORT, '127.0.0.1', () => console.log(`[drill-seller] ${RESOURCE} using ${LIB}`));
