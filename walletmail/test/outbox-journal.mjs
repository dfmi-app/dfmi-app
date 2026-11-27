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
function opsIn(bucket, ...a) { try { return { code: 0, out: execFileSync(process.execPath, ['-r', path.join(HERE, 'events-store.cjs'), path.join(dir, 'tools', 'outbox-ops.mjs'), ...a], { cwd: dir, env: { ...ENV, S3_INCOMING_BUCKET: bucket }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; } }
function ops(...a) { try { return { code: 0, out: execFileSync(process.execPath, ['-r', path.join(HERE, 'events-store.cjs'), path.join(dir, 'tools', 'outbox-ops.mjs'), ...a], { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; } }
const user = async () => { const w = ethers.Wallet.createRandom(); return { w, addr: w.address.toLowerCase(), t: await login(w) }; };
// "restore": a new bucket holding a copy of an earlier snapshot of the mail bucket
function restoreTo(snap, bucket) { const o=objects(); for (const [k,v] of Object.entries(snap)) o[bucket+k.slice(4)]=v; fs.writeFileSync(store,JSON.stringify(o)); }
const mailSnapshot = () => Object.fromEntries(Object.entries(objects()).filter(([k])=>k.startsWith('mail/')));
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
 // Durable guard (on top of the journal patch): the marker alone turns it on; forgetting the env setting does not reopen sending
 rr=ops('guard','on','--operator','offline-review','--reason','restored a pre-journal backup');
 u=await user();await sleep(10500);r=await send(u.t,'guard-marker-only');
 ok('durable guard marker blocks unknown ids without any env setting',rr.code===0&&r.status===503&&sesCount('guard-marker-only')===0&&(await call('GET','/api/health')).j.outbox.restoreGuard===true,JSON.stringify({status:r.status,code:rr.code}));
 rr=ops('guard','off','--operator','x');
 ok('turning the guard off requires an operator and a reason',rr.code!==0);
 rr=ops('guard','off','--operator','offline-review','--reason','legacy ids accounted for');
 ok('guard off is refused without a backfill (a reason alone is never enough)',rr.code!==0&&/no completed backfill/.test(rr.out),rr.out);
 rr=ops('backfill','--operator','x','--reason','y');
 ok('backfill requires a source (--source-bucket or --ids)',rr.code!==0);
 rr=ops('backfill','--source-bucket','mail','--operator','offline-review','--reason','scan of the bucket being served, after the guard went on');
 ok('a backfill of the served bucket itself completes and is recorded with its source',rr.code===0&&JSON.parse(rr.out).source.bucket==='mail'&&Object.keys(objects()).some(k=>k.startsWith('events/resolutions/_backfill/mail/')),rr.out.slice(0,300));
 rr=ops('guard','off','--operator','offline-review','--reason','legacy ids accounted for');
 ok('…but it does not qualify: the served bucket scanned after the guard went on does not prove pre-rollback records were handled',rr.code!==0&&/pre-rollback source/.test(rr.out),rr.out);
 const idsFile=path.join(dir,'legacy-ids.txt');fs.writeFileSync(idsFile,`${u.addr} listed-legacy
`);
 rr=ops('backfill','--ids',idsFile,'--operator','offline-review','--reason','legacy ids from the pre-restore send log');
 ok('an explicit legacy-ID list closes each listed id that has no record (recorded with the list hash)',rr.code===0&&JSON.parse(rr.out).closed.some(x=>x.messageId==='listed-legacy')&&!!JSON.parse(rr.out).source.idsSha256,rr.out.slice(0,300));
 rr=ops('guard','off','--operator','offline-review','--reason','legacy ids accounted for');await sleep(10500);
 r=await send(u.t,'listed-legacy');
 ok('a listed legacy id is never sent (closed as undeterminable)',r.status===409&&sesCount('listed-legacy')===0,JSON.stringify(r));
 r=await send(u.t,'guard-marker-only');
 ok('after a recorded guard off, a new id sends once; both changes are recorded',rr.code===0&&r.status===200&&sesCount('guard-marker-only')===1&&Object.keys(objects()).filter(k=>k.startsWith('events/resolutions/_restore-guard/mail/')).length===2);
 // Guard fix (reviewer's f4542cf-guard-fix, merged 2026-11-27): no cached "off" — on and off take effect at once on a running
 // instance; the health check refreshes the state; a damaged marker counts as ON. No sleeps here on purpose.
 r=await send(u.t,'gf-warm');ok('guard fix: with the guard off a new id sends (this instance has just read "off")',r.status===200&&sesCount('gf-warm')===1);
 rr=ops('guard','on','--operator','offline-review','--reason','immediate-on check');r=await send(u.t,'gf-immediate-on');
 ok('guard fix: guard on takes effect immediately — the very next unknown id is blocked, no SES submission',rr.code===0&&r.status===503&&sesCount('gf-immediate-on')===0,JSON.stringify({code:rr.code,status:r.status}));
 ok('guard fix: the health check shows the guard on immediately',(await call('GET','/api/health')).j.outbox.restoreGuard===true);
 rr=ops('guard','off','--operator','offline-review','--reason','immediate-off check (the earlier ID-list backfill qualifies)');
 ok('guard fix: health shows the guard off immediately after a recorded guard off',rr.code===0&&(await call('GET','/api/health')).j.outbox.restoreGuard===false,rr.out.slice(0,300));
 r=await send(u.t,'gf-immediate-off');ok('guard fix: guard off takes effect immediately — the next new id sends once',r.status===200&&sesCount('gf-immediate-off')===1,JSON.stringify(r));
 { const mk='events/journal/_restore-guard/mail.json', saved=objects()[mk];
   const damaged=[['unparsable JSON','{"active": fal'],['missing "active"','{"operator":"x","reason":"y"}'],['"active" as a string','{"active":"false"}'],['"active" as a number','{"active":0}'],['an array','[false]'],['JSON null','null']];
   for(const [name,body] of damaged){ const o=objects();o[mk]={body:Buffer.from(body).toString('base64'),etag:'"damaged"',at:Date.now()};fs.writeFileSync(store,JSON.stringify(o));
     const id='gf-damaged-'+name.replace(/\W+/g,'-');u=await user();const h=(await call('GET','/api/health')).j.outbox.restoreGuard;r=await send(u.t,id);
     ok(`guard fix: a damaged marker (${name}) counts as ON — health shows on, a new id is blocked, no SES submission`,h===true&&r.status===503&&sesCount(id)===0,JSON.stringify({health:h,status:r.status})); }
   const o=objects();o[mk]=saved;fs.writeFileSync(store,JSON.stringify(o)); }
 u=await user();r=await send(u.t,'gf-after-repair');ok('guard fix: with the valid "off" marker back, a new id sends once again',r.status===200&&sesCount('gf-after-repair')===1,JSON.stringify(r));

 // L3 (acceptance C): a legacy message sent AFTER the backup, with no SES event and no journal (the pre-journal server),
 // so the restored data has no trace of it. Disposition = backfill (journal it from the live bucket before any restore).
 // Then: restore → retry; guard off → restart → retry; a second restore into a fresh bucket with no guard marker → retry.
 await stop();await start();
 u=await user();const backup=mailSnapshot();
 fault({events:'off'});await send(u.t,'L3');await send(u.t,'L3s');await send(u.t,'L3u');fault();
 state=objects();for(const id of ['L3','L3s','L3u'])delete state[`events/journal/${u.addr}/${Buffer.from(id).toString('base64url')}.json`];
 for(const id of ['L3s','L3u'])delete state[`mail/outbox/${u.addr}/${id}.json`];   // L3s, L3u: only their Sent record survives
 { const k=`mail/sent/${u.addr}/L3u.json`;const e=JSON.parse(Buffer.from(state[k].body,'base64'));delete e.fromEmail;state[k].body=Buffer.from(JSON.stringify(e)).toString('base64'); }   // L3u cannot be fingerprinted
 fs.writeFileSync(store,JSON.stringify(state));
 ok('L3 setup: one SES submission each, no journal, no events',['L3','L3s','L3u'].every(id=>sesCount(id)===1)&&!Object.keys(objects()).some(k=>k.includes(`/index/${u.addr}/`)));
 rr=ops('inventory');
 ok('inventory counts the legacy records not yet journaled and the unverifiable one',rr.code===0&&JSON.parse(rr.out).notJournaled>=2&&JSON.parse(rr.out).unverified.some(x=>x.messageId==='L3u'),rr.out.slice(0,400));
 rr=ops('backfill','--source-bucket','mail','--operator','offline-review','--reason','journal legacy records of the live bucket before any restore');
 const bf=rr.code===0?JSON.parse(rr.out):{migrated:[],unverified:[]};
 ok('backfill (source = live bucket) migrates L3 and L3s and lists L3u as unverified (not migrated)',bf.unverified.some(x=>x.messageId==='L3u')&&!bf.migrated.some(x=>x.messageId==='L3u'),rr.out.slice(0,400));
 ok('backfill journals L3 from its outbox record and L3s from its Sent record (not retryable)',['L3','L3s'].every(id=>bf.migrated.some(w=>w.wallet===u.addr&&w.messageId===id&&w.state==='sent'))
   &&['L3','L3s'].every(id=>{const j=JSON.parse(Buffer.from(objects()[`events/journal/${u.addr}/${Buffer.from(id).toString('base64url')}.json`].body,'base64'));return j.retryable===false&&!!j.fp&&j.backfilledFrom;}),rr.out.slice(0,400));
 rr=ops('backfill','--source-bucket','mail','--operator','offline-review','--reason','second run');
 ok('a second backfill changes nothing (existing entries are never overwritten)',rr.code===0&&JSON.parse(rr.out).counts.migrated===0);
 // restore 1: bucket mail2 from the backup taken before L3; the durable guard on for mail2
 restoreTo(backup,'mail2');rr=opsIn('mail2','guard','on','--operator','offline-review','--reason','restored mail2 from the pre-L3 backup');
 await stop();await start({S3_INCOMING_BUCKET:'mail2'});u.t=await login(u.w);
 ok('restore 1: L3 is absent from the restored mail data',!Object.keys(objects()).some(k=>k.startsWith(`mail2/outbox/${u.addr}/L3`)||k.startsWith(`mail2/sent/${u.addr}/L3`)));
 r=await send(u.t,'L3');let r2=await send(u.t,'L3s');
 ok('restore 1: L3 and L3s retries are duplicates, no SES submission',r.status===200&&r.j.duplicate&&r2.status===200&&r2.j.duplicate&&sesCount('L3')===1&&sesCount('L3s')===1,JSON.stringify([r.status,r.j.error,r2.status,r2.j.error]));
 r=await send(u.t,'L3s',{body:'a different body under the L3s id'});
 ok('restore 1: the backfilled Sent fingerprint refuses different content under the same id',r.status===409&&sesCount('L3s')===1);
 r=await send(u.t,'L3u');
 ok('restore 1: the unverified L3u is blocked by the guard (503), no SES submission',r.status===503&&sesCount('L3u')===1,JSON.stringify(r));
 rr=opsIn('mail2','backfill','--source-bucket','mail2','--operator','offline-review','--reason','scan of the restored bucket');
 rr=opsIn('mail2','guard','off','--operator','offline-review','--reason','restored bucket scanned');
 ok('restore 1: guard off is refused while the latest pre-rollback backfill has an unverified record (scanning the restored bucket does not count)',rr.code!==0&&/unverified/.test(rr.out),rr.out);
 const l3uFile=path.join(dir,'l3u.txt');fs.writeFileSync(l3uFile,`${u.addr} L3u
`);
 rr=opsIn('mail2','backfill','--ids',l3uFile,'--operator','offline-review','--reason','L3u content cannot be verified: close it');
 ok('restore 1: the unverified L3u is closed by an explicit ID list',rr.code===0&&JSON.parse(rr.out).closed.some(x=>x.messageId==='L3u'));
 rr=opsIn('mail2','guard','off','--operator','offline-review','--reason','legacy disposition complete');
 ok('restore 1: after that the recorded guard off succeeds',rr.code===0,rr.out);
 await stop();await start({S3_INCOMING_BUCKET:'mail2'});u.t=await login(u.w);
 r=await send(u.t,'L3');r2=await send(u.t,'L3s');let r3=await send(u.t,'L3u');
 ok('guard off + restart: L3u stays closed (409)',r3.status===409&&sesCount('L3u')===1);
 ok('guard off + restart: L3 and L3s are still duplicates, no SES submission',(await call('GET','/api/health')).j.outbox.restoreGuard===false&&r.status===200&&r.j.duplicate&&r2.status===200&&r2.j.duplicate&&sesCount('L3')===1&&sesCount('L3s')===1,JSON.stringify([r.status,r2.status]));
 // restore 2: a fresh bucket from the same backup, no guard marker, no env setting
 restoreTo(backup,'mail3');await stop();await start({S3_INCOMING_BUCKET:'mail3'});u.t=await login(u.w);
 r=await send(u.t,'L3');r2=await send(u.t,'L3s');
 ok('restore 2 (fresh bucket, no guard marker, no env): L3 and L3s are still duplicates, no SES submission',(await call('GET','/api/health')).j.outbox.restoreGuard===false&&r.status===200&&r.j.duplicate&&r2.status===200&&r2.j.duplicate&&sesCount('L3')===1&&sesCount('L3s')===1,JSON.stringify([r.status,r2.status]));
 r3=await send(u.t,'L3u');
 ok('restore 2: L3u stays closed (409), no SES submission',r3.status===409&&sesCount('L3u')===1);
 ok('restore 2: Sent history shows L3 and L3s again',(await call('GET','/api/messages/sent',u.t)).j.emails?.filter(e=>e.id==='L3'||e.id==='L3s').length===2);
} catch(e){console.log('ERROR',e.stack);fail++;}
finally{try{await stop();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
console.log(fail ? `${fail} FAILED` : 'all passed');process.exit(fail?1:0);
