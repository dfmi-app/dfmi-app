// node mail-restore.mjs ../server.js (run from walletmail/test).
// Full local object snapshot, cold restart, multi-page inbox/state/sent scans,
// MIME attachment integrity, protected detail/download endpoints and read faults.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const { ethers } = createRequire(import.meta.url)('ethers');
const SERVER = path.resolve(process.argv[2] || '../server.js');
const dir = fs.mkdtempSync(path.resolve('mail-restore-'));
const store=path.join(dir,'objects.json'),control=path.join(dir,'fault.json'),audit=path.join(dir,'operations.jsonl');
for(const [file,value] of [[store,'{}'],[control,'{}'],[audit,'']])fs.writeFileSync(file,value);
const bucket='isolated-mail-restore',checks=[],active=new Set(),ports=[];
const check=(name,pass,evidence={})=>{checks.push({name,passed:!!pass,evidence});console.log((pass?'PASS ':'FAIL ')+name+' '+JSON.stringify(evidence));};
const fault=(value={})=>fs.writeFileSync(control,JSON.stringify(value));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function start(fence=''){
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));ports.push(port);
  const p=spawn(process.execPath,['-r','./durability-store.cjs',SERVER],{env:{...process.env,PORT:String(port),DRILL_STORE:store,DRILL_CONTROL:control,DRILL_AUDIT:audit,
    AWS_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'test',AWS_SECRET_ACCESS_KEY:'test',S3_INCOMING_BUCKET:bucket,EMAIL_DOMAIN:'example.invalid',DFMI_RPC:'http://127.0.0.1:9',
    ENS_REGISTRY:'',ENS_RESOLVER:'',ENS_BOOTSTRAP_NAMES:'',KNOWN_ENS_MAPPINGS:JSON.stringify({[b.address.toLowerCase()]:'restore-recipient'}),MAILBOX_ADDRESS:'',SIGNATURE_ENFORCE:'1',SESSIONS_NOT_BEFORE:fence},stdio:['ignore','pipe','pipe']});
  let logs='';p.stdout.on('data',d=>logs+=d);p.stderr.on('data',d=>logs+=d);const s={p,base:`http://127.0.0.1:${port}`,logs:()=>logs};active.add(s);
  for(let n=0;n<100;n++){if(p.exitCode!==null)throw Error('server exited '+logs);try{if((await fetch(s.base+'/api/health')).ok)return s;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('startup timeout '+logs);
}
async function stop(s){if(!s||!active.has(s))return;if(s.p.exitCode===null){const done=once(s.p,'exit');s.p.kill();await done;}active.delete(s);fs.appendFileSync(path.join(dir,'servers.log'),s.logs());}
async function call(s,method,url,token,body){const r=await fetch(s.base+url,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});return{status:r.status,j:await r.json().catch(()=>({}))};}
async function binary(s,url,token){const r=await fetch(s.base+url,{headers:token?{authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(60000)});return{status:r.status,bytes:Buffer.from(await r.arrayBuffer()),headers:Object.fromEntries(r.headers)};}
async function login(s,w,ensName){const c=await call(s,'POST','/api/auth/challenge',null,{wallet:w.address});const r=await call(s,'POST','/api/auth/verify',null,{challengeId:c.j.challengeId,signature:await w.signMessage(c.j.message),...(ensName?{ensName}:{})});if(!r.j.token)throw Error('login '+JSON.stringify(r));return r.j.token;}
const get=(s,url,t)=>call(s,'GET',url,t);
const a=ethers.Wallet.createRandom(),b=ethers.Wallet.createRandom(),c=ethers.Wallet.createRandom();
const bytes=crypto.randomBytes(257),html=Buffer.from('<script>window.untrusted=true</script>');let s;
const mime=(recipient,title,attachments=false)=>Buffer.from(['From: outsider@example.invalid',`To: ${recipient}@example.invalid`,`Subject: ${title}`,'MIME-Version: 1.0',
  ...(attachments?['Content-Type: multipart/mixed; boundary="fixture"','','--fixture','Content-Type: text/plain; charset=utf-8','','MIME 恢复正文','--fixture',
    'Content-Type: application/octet-stream',"Content-Disposition: attachment; filename*=utf-8''%E6%81%A2%E5%A4%8D%E9%99%84%E4%BB%B6.bin",'Content-Transfer-Encoding: base64','',bytes.toString('base64'),'--fixture',
    'Content-Type: text/html','Content-Disposition: attachment; filename="active.html"','Content-Transfer-Encoding: base64','',html.toString('base64'),'--fixture--','']:
    ['Content-Type: text/plain; charset=utf-8','','fixture body',''])].join('\r\n'));
try{
  s=await start();let ta=await login(s,a),tb=await login(s,b),tc=await login(s,c);
  const prep=await call(s,'POST','/api/messages/prepare',ta,{recipientType:'wallet',recipientValue:b.address,subject:'main restore',body:'main 正文'});const id=prep.j.messageId;
  await call(s,'POST','/api/messages/content',ta,{messageId:id,subject:'main restore',body:'main 正文',recipientValue:b.address.toLowerCase()});
  await call(s,'POST','/api/messages/send-internal',ta,{messageId:id,recipientWallet:b.address,signature:await a.signMessage('WalletMail:'+id+':'+prep.j.timestamp)});
  check('sender can read original content',(await get(s,'/api/messages/'+id,ta)).status===200);
  check('recipient can read warm content',(await get(s,'/api/messages/'+id,tb)).status===200);
  check('unrelated wallet cannot read warm cached content',(await get(s,'/api/messages/'+id,tc)).status===404);
  await stop(s);
  const state=JSON.parse(fs.readFileSync(store));const put=(key,body)=>{state[bucket+'/'+key]={body:Buffer.from(body).toString('base64'),modified:'2026-11-25T00:00:00.000Z'};};
  for(let n=0;n<101;n++)put(`content/page-${String(n).padStart(3,'0')}.json`,JSON.stringify({messageId:'page-'+n,sender:a.address.toLowerCase(),recipientValue:b.address.toLowerCase(),subject:'page '+n,body:'restored page',storedAt:1}));
  put('content/000-hidden.json',JSON.stringify({messageId:'000-hidden',sender:a.address.toLowerCase(),recipientValue:b.address.toLowerCase(),subject:'deleted',body:'hidden',storedAt:1}));
  for(let n=0;n<201;n++)put(`sent/${a.address.toLowerCase()}/page-${String(n).padStart(3,'0')}.json`,JSON.stringify({id:'sent-'+n,from:a.address.toLowerCase(),to:b.address.toLowerCase(),subject:'sent fixture',body:'restored sent',timestamp:n}));
  for(let n=0;n<101;n++)put(`raw/000-other-${String(n).padStart(3,'0')}.eml`,mime(c.address.toLowerCase(),'other '+n));
  put('raw/zz-attachment.eml',mime(b.address.toLowerCase(),'binary fixture',true));
  put('raw/zz-ens.eml',mime('restore-recipient','verified alias fixture',true));
  put('raw/zz-spoof.eml',Buffer.from(mime(b.address.toLowerCase(),'spoofed sender',true).toString('utf8').replace('From: outsider@example.invalid',`From: ${c.address.toLowerCase()}@example.invalid`)));
  put('raw/zz-linked.eml',Buffer.from('X-WalletMail-Id: linked-message\r\n'+mime(b.address.toLowerCase(),'linked deleted mail',true).toString('utf8')));
  put(`state/${b.address.toLowerCase()}/deleted/linked-message`,'true');
  put('raw/nested/zz-nested.eml',mime(b.address.toLowerCase(),'nested fixture',true));
  for(let n=0;n<101;n++)put(`incoming/${b.address.toLowerCase()}/incoming-${String(n).padStart(3,'0')}.eml`,mime(b.address.toLowerCase(),'incoming '+n,n===100));
  for(const type of ['read','star','deleted']){
    for(let n=0;n<500;n++)put(`state/${b.address.toLowerCase()}/${type}/000-${String(n).padStart(3,'0')}`,'true');
    put(`state/${b.address.toLowerCase()}/${type}/${type==='deleted'?'000-hidden':id}`,'true');
  }
  fs.writeFileSync(store,JSON.stringify(state));const backup=fs.readFileSync(store);fs.writeFileSync(path.join(dir,'backup.json'),backup);
  const manifest=Object.fromEntries(Object.entries(state).map(([key,value])=>[key,{sha256:hash(Buffer.from(value.body,'base64')),bytes:Buffer.from(value.body,'base64').length}]));fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
  // Destroy only the disposable live fixture, then rebuild from its independent snapshot.
  const broken={...state};delete broken[bucket+'/content/'+id+'.json'];delete broken[bucket+`/sent/${a.address.toLowerCase()}/${id}.json`];broken[bucket+'/raw/zz-attachment.eml'].body=Buffer.from('damaged live fixture').toString('base64');fs.writeFileSync(store,JSON.stringify(broken));
  s=await start();check('control: detail absent after simulated loss',(await get(s,'/api/messages/'+id,tb)).status===404);await stop(s);
  fs.writeFileSync(store,backup);check('restore copies all objects byte for byte',hash(fs.readFileSync(store))===hash(backup),{objects:Object.keys(state).length});
  const fence=new Date().toISOString();s=await start(fence);check('pre-restore sessions stay fenced',(await get(s,'/api/session',tb)).status===401);
  ta=await login(s,a);tb=await login(s,b);tc=await login(s,c);
  const detail=await get(s,'/api/messages/'+id,tb);check('cold restored detail loads from storage',detail.status===200&&detail.j.body==='main 正文'&&detail.j.subject==='main restore');
  check('restored sender detail works',(await get(s,'/api/messages/'+id,ta)).status===200);
  check('unrelated wallet cannot read cold restored content',(await get(s,'/api/messages/'+id,tc)).status===404);
  const inbox=await get(s,'/api/messages/inbox',tb);const pageCount=inbox.j.emails?.filter(e=>e.id.startsWith('page-')).length;
  check('all 101 content records visible across pages',inbox.status===200&&pageCount===101,{visible:pageCount});
  check('all 101 incoming MIME records visible',inbox.j.emails?.filter(e=>e.id.startsWith('incoming-')).length===101);
  check('other wallets raw first page cannot hide own mail',inbox.j.emails?.some(e=>e.id==='zz-attachment.eml'));
  check('nested raw key appears in inbox',inbox.j.emails?.some(e=>e.id==='zz-nested.eml'));
  check('raw recipient filtering excludes other wallets',!inbox.j.emails?.some(e=>e.id.startsWith('000-other-')));
  const main=inbox.j.emails?.find(e=>e.id===id);check('read and star markers beyond page one restored',main?.read&&main?.starred);
  check('deletion markers beyond page one hide restored mail',!inbox.j.emails?.some(e=>e.id==='000-hidden'));
  const sent=await get(s,'/api/messages/sent',ta);check('all 201 sent fixtures visible across pages',sent.j.emails?.filter(e=>e.id.startsWith('sent-')).length===201);
  check('sent fixtures remain isolated to their sender',!(await get(s,'/api/messages/sent',tb)).j.emails?.some(e=>e.id.startsWith('sent-')));
  const meta=inbox.j.emails?.find(e=>e.id==='zz-attachment.eml')?.attachments;
  check('inbox exposes attachment metadata and authenticated URL',meta?.length===2&&meta[0].filename==='恢复附件.bin'&&meta[0].size===bytes.length&&typeof meta[0].downloadUrl==='string');
  const mimeDetail=await get(s,'/api/messages/zz-attachment.eml',tb);check('MIME detail and attachment metadata survive restore',mimeDetail.status===200&&mimeDetail.j.body.includes('MIME 恢复正文')&&mimeDetail.j.attachments?.length===2);
  const download=await binary(s,meta?.[0]?.downloadUrl||'/api/messages/zz-attachment.eml/attachments/0',tb);check('restored binary attachment has exact original SHA-256',download.status===200&&hash(download.bytes)===hash(bytes));
  check('download is private and cannot execute active content',download.headers['content-type']==='application/octet-stream'&&download.headers['content-disposition']?.startsWith('attachment;')&&download.headers['x-content-type-options']==='nosniff'&&download.headers['cache-control']?.includes('no-store')&&download.headers['content-security-policy']?.includes('sandbox'));
  const activeHtml=await binary(s,'/api/messages/zz-attachment.eml/attachments/1',tb);check('HTML attachment forced to binary download',activeHtml.status===200&&hash(activeHtml.bytes)===hash(html)&&activeHtml.headers['content-type']==='application/octet-stream');
  check('Unicode filename is safely encoded in disposition',download.headers['content-disposition']?.includes("filename*=UTF-8''%E6%81%A2%E5%A4%8D"));
  check('nested raw attachment downloadable by listed ID',(await binary(s,'/api/messages/zz-nested.eml/attachments/0',tb)).bytes.equals(bytes));
  check('per-wallet incoming attachment downloadable',(await binary(s,'/api/messages/incoming-100.eml/attachments/0',tb)).bytes.equals(bytes));
  check('unrelated wallet cannot fetch MIME detail',(await get(s,'/api/messages/zz-attachment.eml',tc)).status===404);
  check('message detail needs authenticated session',(await get(s,'/api/messages/zz-attachment.eml')).status===401);
  check('unrelated wallet cannot download attachment',(await binary(s,'/api/messages/zz-attachment.eml/attachments/0',tc)).status===404);
  check('untrusted From header cannot grant raw detail access',(await get(s,'/api/messages/zz-spoof.eml',tc)).status===404);
  check('untrusted From header cannot grant attachment access',(await binary(s,'/api/messages/zz-spoof.eml/attachments/0',tc)).status===404);
  check('other wallet cannot fetch per-wallet incoming attachment',(await binary(s,'/api/messages/incoming-100.eml/attachments/0',tc)).status===404);
  check('verified configured ENS recipient can download attachments',(await binary(s,'/api/messages/zz-ens.eml/attachments/0',tb)).bytes.equals(bytes));
  const aliasSpoof=await login(s,c,'restore-recipient');
  check('self-claimed ENS name grants no raw detail access',(await get(s,'/api/messages/zz-ens.eml',aliasSpoof)).status===404);
  check('self-claimed ENS name grants no attachment access',(await binary(s,'/api/messages/zz-ens.eml/attachments/0',aliasSpoof)).status===404);
  const walletSpoof=await login(s,c,b.address.toLowerCase());
  check('self-claimed wallet-shaped alias grants no content access',(await get(s,'/api/messages/'+id,walletSpoof)).status===404);
  const spoofInbox=await get(s,'/api/messages/inbox',walletSpoof);check('self-claimed aliases cannot add foreign inbox messages',!spoofInbox.j.emails?.some(e=>e.id===id||e.id==='zz-ens.eml'||e.id==='zz-attachment.eml'));
  check('linked message deletion hides raw MIME detail',(await get(s,'/api/messages/zz-linked.eml',tb)).status===404);
  check('linked message deletion hides raw MIME attachment',(await binary(s,'/api/messages/zz-linked.eml/attachments/0',tb)).status===404);
  check('attachment needs authenticated session',(await binary(s,'/api/messages/zz-attachment.eml/attachments/0')).status===401);
  for(const index of ['-1','1e0','99999999999999999999','99'])check('invalid attachment index refused: '+index,(await binary(s,'/api/messages/zz-attachment.eml/attachments/'+index,tb)).status===404);
  check('encoded traversal does not expose storage',(await get(s,'/api/messages/%2e%2e%2fcontacts%2fprivate',tb)).status===404);
  fault({name:'ListObjectsV2Command',prefix:'content/',continuationOnly:true});check('second-page listing failure never returns partial success',(await get(s,'/api/messages/inbox',tb)).status===503);fault();
  for(const cursorMode of ['missing','repeat']){fault({cursorMode});check('invalid pagination cursor fails closed: '+cursorMode,(await get(s,'/api/messages/inbox',tb)).status===503);fault();}
  fault({name:'GetObjectCommand',prefix:'content/page-100.json'});check('object read failure cannot silently omit a message',(await get(s,'/api/messages/inbox',tb)).status===503);fault();
  fault({name:'GetObjectCommand',prefix:'raw/zz-attachment.eml'});check('attachment storage outage returns explicit error',(await binary(s,'/api/messages/zz-attachment.eml/attachments/0',tb)).status===503);fault();
  fault({name:'GetObjectCommand',prefix:`state/${b.address.toLowerCase()}/deleted/`});check('detail refuses access when deletion state cannot be checked',(await get(s,'/api/messages/zz-attachment.eml',tb)).status===503);fault();
  const ops=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);check('all seven mailbox prefixes used continuation tokens',['raw/','content/',`incoming/${b.address.toLowerCase()}/`,`sent/${a.address.toLowerCase()}/`,...['read','star','deleted'].map(t=>`state/${b.address.toLowerCase()}/${t}/`)].every(prefix=>ops.some(o=>o.prefix===prefix&&o.continuation)));
  await call(s,'DELETE','/api/messages/zz-attachment.eml',tb,{source:'inbox'});check('deleted MIME detail is not readable',(await get(s,'/api/messages/zz-attachment.eml',tb)).status===404);check('deleted MIME attachment is not downloadable',(await binary(s,'/api/messages/zz-attachment.eml/attachments/0',tb)).status===404);
  await stop(s);s=await start(fence);check('restored detail remains available after second restart',(await get(s,'/api/messages/'+id,tb)).status===200);
  check('attachment integrity survives second restart',(await binary(s,'/api/messages/incoming-100.eml/attachments/0',tb)).bytes.equals(bytes));
  check('attachment deletion survives second restart',(await binary(s,'/api/messages/zz-attachment.eml/attachments/0',tb)).status===404);
}catch(e){check('no harness failure',false,{error:e.stack});}
finally{for(const child of [...active])await stop(child);let free=true;for(const port of ports){const probe=net.createServer();try{await new Promise((r,j)=>{probe.once('error',j);probe.listen(port,'127.0.0.1',r);});await new Promise(r=>probe.close(r));}catch{free=false;}}check('all isolated listeners closed',free);const result={passed:checks.filter(x=>x.passed).length,failed:checks.filter(x=>!x.passed).length,checks};fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,failed:result.failed,artifacts:dir}));process.exitCode=result.failed?1:0;}
