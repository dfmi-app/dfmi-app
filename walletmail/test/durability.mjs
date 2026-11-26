// Run from walletmail/test: node durability.mjs ../server.js
// Real wallet signatures + software WebAuthn; S3 and SES are local fixtures only.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { authenticator } from './durability-authenticator.mjs';
const { ethers } = createRequire(import.meta.url)('ethers');
const SERVER = path.resolve(process.argv[2] || '../server.js');
const dir = fs.mkdtempSync(path.resolve('durability-'));
const store = path.join(dir,'objects.json'), control=path.join(dir,'fault.json'), audit=path.join(dir,'operations.jsonl');
fs.writeFileSync(store,'{}'); fs.writeFileSync(control,'{}'); fs.writeFileSync(audit,'');
const bucket='isolated-durability'; const checks=[]; const active=new Set(); const ports=[];
const check=(name,pass,evidence={})=>{checks.push({name,passed:!!pass,evidence});console.log((pass?'PASS ':'FAIL ')+name+' '+JSON.stringify(evidence));};
const fault=(name,prefix)=>fs.writeFileSync(control,JSON.stringify(name?{name,prefix}:{}));
const objects=()=>JSON.parse(fs.readFileSync(store));
const has=(key)=>!!objects()[bucket+'/'+key];
async function start(fence='') {
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));ports.push(port);
  const p=spawn(process.execPath,['-r','./durability-store.cjs',SERVER],{env:{...process.env,PORT:String(port),DRILL_STORE:store,DRILL_CONTROL:control,DRILL_AUDIT:audit,
    AWS_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'test',AWS_SECRET_ACCESS_KEY:'test',S3_INCOMING_BUCKET:bucket,EMAIL_DOMAIN:'example.invalid',DFMI_RPC:'http://127.0.0.1:9',
    ENS_REGISTRY:'',ENS_RESOLVER:'',ENS_BOOTSTRAP_NAMES:'',KNOWN_ENS_MAPPINGS:'{}',MAILBOX_ADDRESS:'',SIGNATURE_ENFORCE:'1',SESSIONS_NOT_BEFORE:fence},stdio:['ignore','pipe','pipe']});
  let logs='';p.stdout.on('data',d=>logs+=d);p.stderr.on('data',d=>logs+=d);const s={p,base:`http://127.0.0.1:${port}`,logs:()=>logs};active.add(s);
  for(let n=0;n<100;n++){if(p.exitCode!==null)throw Error('startup exited '+logs);try{if((await fetch(s.base+'/api/health')).ok)return s;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('startup timed out '+logs);
}
async function stop(s){if(!s||!active.has(s))return;if(s.p.exitCode===null){const done=once(s.p,'exit');s.p.kill();await done;}active.delete(s);fs.appendFileSync(path.join(dir,'servers.log'),s.logs());}
async function call(s,method,url,token,body){const r=await fetch(s.base+url,{method,headers:{'content-type':'application/json',origin:'https://identity.dfmi.app',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:r.status,j:await r.json().catch(()=>({}))};}
async function signIn(s,w){const c=await call(s,'POST','/api/auth/challenge',null,{wallet:w.address});return call(s,'POST','/api/auth/verify',null,{challengeId:c.j.challengeId,signature:await w.signMessage(c.j.message)});}
async function login(s,w){const r=await signIn(s,w);if(!r.j.token)throw Error('login failed '+JSON.stringify(r));return r.j.token;}
const session=(s,t)=>call(s,'GET','/api/session',t);
async function register(s,t,a){const o=await call(s,'POST','/api/auth/passkey/register/options',t,{});if(o.status!==200)return o;return call(s,'POST','/api/auth/passkey/register/verify',t,{challengeId:o.j.challengeId,response:a.create(o.j.options)});}
async function passkeyLogin(s,a,address){const o=await call(s,'POST','/api/auth/passkey/login/options',null,address?{address}:{});if(o.status!==200)return o;return call(s,'POST','/api/auth/passkey/login/verify',null,{challengeId:o.j.challengeId,response:a.get(o.j.options)});}
const w=ethers.Wallet.createRandom(),recipient=ethers.Wallet.createRandom();let s;
try{
  s=await start();let token=await login(s,w);
  const kept=authenticator(),removed=authenticator();check('register active credential',(await register(s,token,kept)).status===200);check('register credential to revoke',(await register(s,token,removed)).status===200);
  const backup=fs.readFileSync(store);await call(s,'DELETE','/api/auth/passkeys/'+removed.id,token);
  check('revoked passkey rejected before rollback',(await passkeyLogin(s,removed)).status===401);
  await stop(s);fs.writeFileSync(store,backup);const fence=new Date().toISOString();s=await start(fence);
  check('old session rejected after restore',(await session(s,token)).status===401);
  check('revoked credential cannot mint a new session after restore',(await passkeyLogin(s,removed)).status===401);
  check('all pre-restore credentials require re-enrollment',(await passkeyLogin(s,kept)).status===401);
  check('address-based options exclude pre-restore credentials',(await call(s,'POST','/api/auth/passkey/login/options',null,{address:w.address})).status===404);
  token=await login(s,w);check('wallet login after restore works',(await session(s,token)).status===200);
  // The same authentic credential can be rebound only after a fresh wallet proof.
  check('wallet session can re-enroll existing credential',(await register(s,token,kept)).status===200);
  check('re-enrolled passkey signs in',(await passkeyLogin(s,kept)).status===200);
  const newAuth=authenticator();check('wallet session can add a fresh credential',(await register(s,token,newAuth)).status===200);
  const pk=await passkeyLogin(s,newAuth);check('fresh credential issues usable session',pk.status===200&&(await session(s,pk.j.token)).status===200);
  check('passkey session cannot re-enroll old credential',(await register(s,pk.j.token,removed)).status===403);
  check('old credential cannot use a fresh address-bound challenge',(await passkeyLogin(s,removed,w.address)).status===401);
  const foreign=await login(s,recipient);check('another wallet cannot rebind restored credential',(await register(s,foreign,removed)).status===409);
  for(const prefix of ['passkeys/','passkeys-by-address/']){fault('PutObjectCommand',prefix);const failed=await register(s,token,authenticator());fault();check('registration persistence failure is explicit: '+prefix,failed.status>=500&&!failed.j.ok);}
  for(const prefix of ['passkeys/','sessions/']){fault('PutObjectCommand',prefix);const failed=await passkeyLogin(s,newAuth);fault();check('passkey login issues no token on persistence failure: '+prefix,failed.status>=500&&!failed.j.token);}
  // Legacy/malformed credential epochs must not bypass the discoverable path.
  const keys=objects();const keptKey=Object.keys(keys).find(k=>k.startsWith(bucket+'/passkeys/')&&JSON.parse(Buffer.from(keys[k].body,'base64')).id===kept.id);
  const original=keys[keptKey];for(const timestamp of [null,'not-a-time',fence]){const rec=JSON.parse(Buffer.from(original.body,'base64'));if(timestamp===null)delete rec.createdAt;else rec.createdAt=timestamp;const state=objects();state[keptKey]={...original,body:Buffer.from(JSON.stringify(rec)).toString('base64')};fs.writeFileSync(store,JSON.stringify(state));check('unsafe credential epoch rejected: '+String(timestamp),(await passkeyLogin(s,kept)).status===401);}
  const state=objects();state[keptKey]=original;fs.writeFileSync(store,JSON.stringify(state));
  await stop(s);s=await start(fence);check('re-enrolled passkey survives another restart',(await passkeyLogin(s,kept)).status===200);
  const peer=await start(fence);const revokeToken=await login(s,w);await session(peer,revokeToken);
  fault('DeleteObjectCommand','sessions/');const failedLogout=await call(s,'POST','/api/auth/logout',revokeToken,{});fault();
  check('failed persistent logout returns explicit failure',failedLogout.status===503&&!failedLogout.j.ok,{status:failedLogout.status});
  const logout=await call(s,'POST','/api/auth/logout',revokeToken,{});check('retry logout persists revocation',logout.status===200&&(await session(s,revokeToken)).status===401);
  check('logout invalidates already-cached peer session',(await session(peer,revokeToken)).status===401);await stop(peer);await stop(s);s=await start(fence);check('logout stays revoked across restart',(await session(s,revokeToken)).status===401);
  token=await login(s,w);const warmed=await session(s,token);fault('GetObjectCommand','sessions/');const unavailable=await session(s,token);fault();check('warm session cannot bypass authoritative storage outage',warmed.status===200&&unavailable.status!==200);
  fault('GetObjectCommand','sessions-revoked/');const revokeUnavailable=await session(s,token);fault();check('warm revocation cache cannot bypass storage outage',revokeUnavailable.status!==200);
  fault('PutObjectCommand','sessions/');const failedSignIn=await signIn(s,w);fault();check('failed session persistence issues no token',failedSignIn.status>=500&&!failedSignIn.j.token);
  const prepBody={recipientType:'wallet',recipientValue:recipient.address,subject:'durable subject',body:'UTF-8 正文'};
  fault('PutObjectCommand','prepared/');const badPrep=await call(s,'POST','/api/messages/prepare',token,prepBody);fault();check('prepare does not acknowledge failed persistence',badPrep.status>=500&&!badPrep.j.messageId);
  const prep=await call(s,'POST','/api/messages/prepare',token,prepBody);const id=prep.j.messageId;if(!id)throw Error('healthy prepare failed');
  fault('PutObjectCommand','content/');const badContent=await call(s,'POST','/api/messages/content',token,{...prepBody,messageId:id});fault();check('content upload does not claim stored on write failure',badContent.status>=500&&!badContent.j.stored&&!has('content/'+id+'.json'));
  const content=await call(s,'POST','/api/messages/content',token,{...prepBody,messageId:id});check('healthy content retry stores durable object',content.status===200&&content.j.stored&&has('content/'+id+'.json'));
  const signature=await w.signMessage('WalletMail:'+id+':'+prep.j.timestamp);const sendBody={messageId:id,recipientWallet:recipient.address,signature};
  fault('PutObjectCommand','sent/');const sentFail=await call(s,'POST','/api/messages/send-internal',token,sendBody);fault();check('internal send reports sent-record failure',sentFail.status>=500&&!sentFail.j.sent);
  fault('PutObjectCommand','content/');const deliveryFail=await call(s,'POST','/api/messages/send-internal',token,sendBody);fault();check('internal send reports recipient-content failure',deliveryFail.status>=500&&!deliveryFail.j.sent);
  check('internal send succeeds with healthy storage',(await call(s,'POST','/api/messages/send-internal',token,sendBody)).j.sent===true);
  const contacts=[{id:'before',name:'before'}];await call(s,'PUT','/api/contacts',token,{contacts});fault('PutObjectCommand','contacts/');const badContacts=await call(s,'PUT','/api/contacts',token,{contacts:[{id:'lost',name:'not saved'}]});fault();
  check('contacts write failure is not acknowledged or cached',badContacts.status>=500&&!badContacts.j.saved&&(await call(s,'GET','/api/contacts',token)).j.contacts?.[0]?.id==='before');
  await stop(s);s=await start(fence);check('successful contact save survives restart',(await call(s,'GET','/api/contacts',token)).j.contacts?.[0]?.id==='before');
  for(const action of ['read','star']){fault('PutObjectCommand',`state/${w.address.toLowerCase()}/${action}/`);const failed=await call(s,'POST',`/api/messages/${id}/${action}`,token,{});fault();check(action+' state failure returns error without success',failed.status>=500&&!failed.j.read&&!failed.j.starred&&!has(`state/${w.address.toLowerCase()}/${action}/${id}`));const good=await call(s,'POST',`/api/messages/${id}/${action}`,token,{});check(action+' retry stores durable state',good.status===200&&has(`state/${w.address.toLowerCase()}/${action}/${id}`));}
  fault('DeleteObjectCommand','sent/');const badDelete=await call(s,'DELETE','/api/messages/'+id,token,{source:'sent'});fault();check('sent deletion failure is not acknowledged',badDelete.status>=500&&!badDelete.j.deleted);
  check('sent deletion retry succeeds',(await call(s,'DELETE','/api/messages/'+id,token,{source:'sent'})).status===200&&!has(`sent/${w.address.toLowerCase()}/${id}.json`));
  fault('PutObjectCommand','sent/');const external=await call(s,'POST','/api/messages/send-external',token,{recipientEmail:'sink@example.invalid',subject:'mock',body:'never sent externally'});fault();check('external send reports uncertain outcome when sent record fails',external.status>=500&&!external.j.sent&&external.j.deliveryMayHaveOccurred===true);
  const healthyExternal=await call(s,'POST','/api/messages/send-external',token,{recipientEmail:'sink@example.invalid',subject:'mock control',body:'only local SES stub'});check('healthy simulated external send persists history',healthyExternal.status===200&&healthyExternal.j.sent&&has(`sent/${w.address.toLowerCase()}/${healthyExternal.j.messageId}.json`));
  const second=await login(s,w);fault('PutObjectCommand','sessions-revoked/');const badAll=await call(s,'POST','/api/auth/logout-all',token,{});fault();check('logout-all persistence failure is explicit',badAll.status===503&&!badAll.j.ok);
  const otherPeer=await start(fence);await session(otherPeer,second);const all=await call(s,'POST','/api/auth/logout-all',token,{});check('successful logout-all invalidates peer cache',all.status===200&&(await session(otherPeer,second)).status===401);await stop(otherPeer);
}catch(e){check('no harness failure',false,{error:e.stack});}
finally{for(const child of [...active])await stop(child);let allFree=true;for(const port of ports){const probe=net.createServer();try{await new Promise((r,j)=>{probe.once('error',j);probe.listen(port,'127.0.0.1',r);});await new Promise(r=>probe.close(r));}catch{allFree=false;}}check('all isolated listeners closed',allFree);const result={passed:checks.filter(x=>x.passed).length,failed:checks.filter(x=>!x.passed).length,checks};fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,failed:result.failed,artifacts:dir}));process.exitCode=result.failed?1:0;}
