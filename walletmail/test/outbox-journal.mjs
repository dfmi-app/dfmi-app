// Durable journal regression: original source fails these five cases; no network or real SES.
// Pending reconciliation (2026-11-26): SES events â†’ index â†’ outbox, the pre-send check after a rollback, stale-pending
// alerts, and the operator tool's rules. S3/SES are local fixtures (events-store.cjs); nothing leaves the machine.
//   node outbox-reconcile.mjs ../server.js ../tools/outbox-ops.mjs
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { spawn, execFileSync } from 'node:child_process'; import { once } from 'node:events';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const { ethers } = createRequire(import.meta.url)('ethers');
const SERVER = path.resolve(process.argv[2] || '../server.js'), OPS = path.resolve(process.argv[3] || '../tools/outbox-ops.mjs');
const dir = fs.mkdtempSync(path.join(HERE, 'reconcile-')); fs.copyFileSync(SERVER, path.join(dir, 'server.js')); fs.mkdirSync(path.join(dir, 'tools')); fs.copyFileSync(OPS, path.join(dir, 'tools', 'outbox-ops.mjs'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
const store = path.join(dir, 'objects.json'), control = path.join(dir, 'fault.json'), sesLog = path.join(dir, 'ses.jsonl');
fs.writeFileSync(store, '{}'); fs.writeFileSync(control, '{}'); fs.writeFileSync(sesLog, '');
let fail = 0; const ok = (m, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fail++; };
const fault = (f = {}) => fs.writeFileSync(control, JSON.stringify(f));
const sesCount = (tag) => fs.readFileSync(sesLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((x) => x.tag === tag).length;
const objects = () => JSON.parse(fs.readFileSync(store, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${port}`; let proc;
const ENV = { ...process.env, DRILL_STORE: store, DRILL_CONTROL: control, DRILL_AUDIT: sesLog, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x',
  S3_INCOMING_BUCKET: 'mail', SES_EVENTS_BUCKET: 'events', SES_CONFIGURATION_SET: 'walletmail-events', EMAIL_DOMAIN: 'example.invalid', DFMI_RPC: 'http://127.0.0.1:9', ENS_REGISTRY: '', ENS_RESOLVER: '', ENS_BOOTSTRAP_NAMES: '',
  OUTBOX_RECONCILE_MS: '300', OUTBOX_PENDING_ALERT_MS: '1500', OUTBOX_EVIDENCE_WINDOW_MS: '1000', OUTBOX_CANARY_MAX_GAP_MS: String(3600e3) };
async function start(extra = {}) { proc = spawn(process.execPath, ['-r', path.join(HERE, 'events-store.cjs'), path.join(dir, 'server.js')], { cwd: dir, env: { ...ENV, PORT: String(port), ...extra }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await sleep(50); } throw Error('no start'); }
async function stop() { if (!proc || proc.exitCode !== null || proc.signalCode) return; const d = once(proc, 'exit'); proc.kill(); await d; }
const call = async (m, u, t, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
async function login(w) { const c = await call('POST', '/api/auth/challenge', null, { wallet: w.address }); return (await call('POST', '/api/auth/verify', null, { challengeId: c.j.challengeId, signature: await w.signMessage(c.j.message) })).j.token; }
const send = (t, id, extra = {}) => call('POST', '/api/messages/send-external', t, { messageId: id, recipientEmail: 'someone@example.org', subject: 'hello ' + id, body: 'body ' + id, ...extra });
const outbox = (t, id) => call('GET', '/api/messages/outbox/' + id, t);
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
function ops(...a) { try { return { code: 0, out: execFileSync(process.execPath, ['-r', path.join(HERE, 'events-store.cjs'), path.join(dir, 'tools', 'outbox-ops.mjs'), ...a], { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; } }
const user = async () => { const w = ethers.Wallet.createRandom(); return { w, addr: w.address.toLowerCase(), t: await login(w) }; };
function eraseMail(u,id) { const o=objects();delete o[`mail/outbox/${u.addr}/${id}.json`];delete o[`mail/sent/${u.addr}/${id}.json`];fs.writeFileSync(store,JSON.stringify(o)); }
try {
 await start();
 // Individual event loss while surrounding probes work.
 let u=await user();ops('canary');await sleep(600);
 fault({ses:'lost-response',events:'off'});let r=await send(u.t,'selective-loss');fault();
 ops('canary');await sleep(1400);
 let rr=ops('resolve',u.addr,'selective-loss','--as','not-sent','--operator','offline-review','--reason','healthy probes but one event missing');
 console.log('OBSERVATION selective loss',JSON.stringify({operatorExit:rr.code,evidence:rr.code===0?JSON.parse(rr.out).evidence:null}));
 r=await send(u.t,'selective-loss');
 ok('healthy probes must not turn a selectively missing event into permission to resend',rr.code!==0&&sesCount('selective-loss')===1,JSON.stringify({status:r.status,submissions:sesCount('selective-loss')}));
 // Event is delayed or absent when a backup has no record of an accepted message.
 u=await user();fault({events:'off'});await send(u.t,'lagged-rollback');fault();eraseMail(u,'lagged-rollback');
 r=await send(u.t,'lagged-rollback');
 ok('rollback with an absent/delayed event must not resubmit a previously accepted message',sesCount('lagged-rollback')===1,JSON.stringify({status:r.status,duplicate:r.j.duplicate,submissions:sesCount('lagged-rollback')}));
 // Durable abandoned disposition must remain effective when mail state rolls back.
 u=await user();fault({ses:'lost-response',events:'off'});await send(u.t,'abandoned-rollback');fault();
 rr=ops('resolve',u.addr,'abandoned-rollback','--as','undeterminable','--operator','offline-review','--reason','unknown outcome, never resend');
 const resolutions=Object.keys(objects()).filter(k=>k.startsWith(`events/resolutions/${u.addr}/`));eraseMail(u,'abandoned-rollback');
 r=await send(u.t,'abandoned-rollback');
 ok('an abandoned resolution in the separate bucket must prevent sending after mail rollback',rr.code===0&&resolutions.length===1&&r.status===409&&sesCount('abandoned-rollback')===1,JSON.stringify({status:r.status,resolutionCount:resolutions.length,submissions:sesCount('abandoned-rollback')}));
 // Events have no body fingerprint: the same recipient and subject do not prove identical content.
 u=await user();await send(u.t,'changed-body');await until(async()=>(await outbox(u.t,'changed-body')).j.events?.length>0);eraseMail(u,'changed-body');
 r=await send(u.t,'changed-body',{body:'THIS BODY WAS NEVER SENT'});
 const history=await call('GET','/api/messages/sent',u.t);
 ok('rollback recovery must reject the same id with different body content',r.status===409,JSON.stringify({status:r.status,reconciled:r.j.reconciled,storedWrongBody:history.j.emails?.some(e=>e.id==='changed-body'&&e.body==='THIS BODY WAS NEVER SENT')}));
 // A restored entry created without fp must remain replayable.
 u=await user();await send(u.t,'repeat-recovery');await until(async()=>(await outbox(u.t,'repeat-recovery')).j.events?.length>0);eraseMail(u,'repeat-recovery');
 const first=await send(u.t,'repeat-recovery');r=await send(u.t,'repeat-recovery');
 ok('an identical retry after event-only recovery must return the same successful result',first.status===200&&r.status===200&&r.j.duplicate&&sesCount('repeat-recovery')===1,JSON.stringify({first:first.status,second:r.status,error:r.j.error}));
 const listed = ops('list');
 ok('operator listing includes journal-backed abandoned entries even after mail rollback', listed.code===0 && /abandoned-rollback/.test(listed.out) && /"state": "abandoned"/.test(listed.out));
 // One authoritative atomic claim across concurrent retries.
 u=await user();const rs=await Promise.all(Array.from({length:6},()=>send(u.t,'concurrent')));
 ok('six concurrent retries submit exactly once',sesCount('concurrent')===1&&rs.filter(x=>x.status===200&&!x.j.duplicate).length===1&&rs.every(x=>x.status===200||x.status===409));
 u=await user();fault({s3:{op:'PutObjectCommand',bucket:'events',prefix:'journal/'}});r=await send(u.t,'claim-fails');fault();
 ok('unwritable journal prevents any SES submission',r.status>=500&&sesCount('claim-fails')===0);
 u=await user();fault({s3:{op:'GetObjectCommand',bucket:'events',prefix:'journal/'}});r=await send(u.t,'read-fails');fault();
 ok('unreadable journal prevents any SES submission',r.status>=500&&sesCount('read-fails')===0);
 u=await user();fault({s3:{op:'PutObjectCommand',bucket:'events',prefix:'journal/',state:'sent'}});r=await send(u.t,'outcome-fails');fault();
 ok('accepted mail with an unsaved journal outcome is not ordinary success',r.status===503&&r.j.accepted===true&&r.j.persistenceUnknown===true&&sesCount('outcome-fails')===1);
 await until(async()=>(await outbox(u.t,'outcome-fails')).j.events?.length>0);r=await send(u.t,'outcome-fails');
 ok('accepted mail can be reconciled without a second submission',r.status===200&&r.j.duplicate&&sesCount('outcome-fails')===1);
 u=await user();fault({ses:'reject'});r=await send(u.t,'definite-reject');fault();
 ok('definite SES rejection is persisted as retryable',r.status===502&&(await outbox(u.t,'definite-reject')).j.state==='failed');
 r=await send(u.t,'definite-reject');
 ok('only a persisted definite SES rejection permits a same-id retry',r.status===200&&sesCount('definite-reject')===1);
 // A pre-upgrade event without the original body fingerprint must not authorize reconstruction.
 u=await user();await send(u.t,'legacy-fingerprint');await until(async()=>(await outbox(u.t,'legacy-fingerprint')).j.events?.length>0);eraseMail(u,'legacy-fingerprint');
 let state=objects();delete state[`events/journal/${u.addr}/${Buffer.from('legacy-fingerprint').toString('base64url')}.json`];fs.writeFileSync(store,JSON.stringify(state));
 r=await send(u.t,'legacy-fingerprint',{body:'unverified legacy body'});
 ok('legacy events without a fingerprint cannot fabricate sent content',r.status===409&&sesCount('legacy-fingerprint')===1);
 // Keep only the independently retained closure, not either state record.
 u=await user();fault({ses:'lost-response',events:'off'});await send(u.t,'closure-only');fault();
 rr=ops('resolve',u.addr,'closure-only','--as','undeterminable','--operator','offline-review','--reason','unknown');eraseMail(u,'closure-only');
 state=objects();delete state[`events/journal/${u.addr}/${Buffer.from('closure-only').toString('base64url')}.json`];fs.writeFileSync(store,JSON.stringify(state));
 r=await send(u.t,'closure-only');
 ok('retained closure alone blocks sending even without either state record',rr.code===0&&r.status===409&&sesCount('closure-only')===1);
 u=await user();await stop();await start({OUTBOX_REQUIRE_EXISTING_JOURNAL:'1'});r=await send(u.t,'legacy-restore-unknown');
 ok('legacy restore guard rejects unknown ids without a journal',r.status===503&&sesCount('legacy-restore-unknown')===0);
 await stop();await start();
} catch(e){console.log('ERROR',e.stack);fail++;}
finally{try{await stop();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
console.log(fail ? `${fail} FAILED` : 'all passed');process.exit(fail?1:0);
