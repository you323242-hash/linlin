// Isolated local HTTP exercise, never targets a URL or an existing database.
// Bounded workload below the normal peer limit; not a production capacity promise.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import net from 'node:net';
import { inspectPaymentJournal, inspectLocalPaymentChannel } from '../server/payment-journal.mjs';
import { createAuth } from '../server/auth.mjs';
import { prepareRuntimeDirectory } from '../server/config.mjs';

const directory=mkdtempSync(path.join(tmpdir(),'delta-capacity-'));
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
const base=`http://127.0.0.1:${port}`,root=path.resolve(import.meta.dirname,'..');
const env={...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:directory,PORT:String(port),BETTER_AUTH_URL:base};
for(const k of ['BETTER_AUTH_SECRET','STAGING_ACCESS_TOKEN','ALLOW_STAGING_MOCKS','AUTH_REQUIRE_EMAIL_VERIFICATION','AUTH_PHONE_MODE','TRUSTED_PROXY_IPS','BACKUP_KEY_FILE','AUTH_KEY_REF'])delete env[k];
const samples=[],counts={},checks=[];let child,logs='';
const sustainArg=process.argv.slice(2);
assert.ok(sustainArg.length<=1&&(!sustainArg.length||/^--sustain=(120|180|300)$/.test(sustainArg[0])),'optional --sustain=120|180|300 only');
const sustainSeconds=sustainArg.length?Number(sustainArg[0].split('=')[1]):0;
async function start(){
  child=spawn(process.execPath,[path.join(root,'server/index.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',b=>logs+=b);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('isolated startup timeout')),15000);
    child.stdout.on('data',b=>{logs+=b;if(String(b).includes('已启动')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('startup exited '+code));});
  });
}
async function stop(){const target=child;child=null;if(target&&target.exitCode===null&&target.signalCode===null)await new Promise(r=>{target.once('exit',r);target.kill();});}
async function req(route,user,body,expected=200,phase='flow'){
  const t=performance.now();
  const r=await fetch(base+route,{signal:AbortSignal.timeout(10000),method:body?'POST':'GET',headers:{...(user?{Cookie:user.cookie}:{}),...(body?{Origin:base,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const raw=await r.text();samples.push({phase,ms:performance.now()-t,status:r.status,bytes:Buffer.byteLength(raw)});
  counts[r.status]=(counts[r.status]||0)+1;
  assert.equal(r.status,expected,`${route}: ${r.status}`);
  return {data:r.headers.get('content-type')?.includes('application/json')?JSON.parse(raw):null,cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
}
function stats(phase){const s=samples.filter(x=>x.phase===phase),a=s.map(x=>x.ms).sort((a,b)=>a-b);return {phase,requests:s.length,p50ms:+a[Math.ceil(a.length*.5)-1].toFixed(2),p95ms:+a[Math.ceil(a.length*.95)-1].toFixed(2),maxMs:+a.at(-1).toFixed(2),bytes:s.reduce((n,x)=>n+x.bytes,0)};}
try{
  // Create existing-user fixtures through the supported auth API before starting HTTP.
  // Burst registration hits its intentionally stricter anti-abuse limit; do not disable it.
  prepareRuntimeDirectory({dataDirectory:directory,environment:'test'});
  const fixture=await createAuth({baseURL:base,dataDirectory:directory,environment:'test',requireEmailVerification:false,phoneMode:'disabled'});
  const users=[];
  try {for(let i=0;i<8;i++){
    const r=await fixture.auth.api.signUpEmail({body:{name:`隔离负载${i}`,email:`load-${randomUUID()}@example.test`,password:`Load-${randomUUID()}!`,termsAccepted:true},asResponse:true});
    assert.equal(r.status,200);const data=await r.json();
    users.push({...data.user,cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')});
  }} finally {fixture.database.close();}
  await start();await req('/api/health');
  let orders=await Promise.all(users.map(async(u,i)=>{
    const body={requestId:randomUUID(),mode:i%2?'topsecret':'secret',rulesAccepted:true,providerCount:i%2?2:1,price:1};
    const replies=await Promise.all(Array.from({length:4},()=>req('/api/orders',u,body)));
    assert.equal(new Set(replies.map(x=>x.data.order.id)).size,1);
    const o=replies[0].data.order;assert.equal(o.price,i%2?4176:1088);return o;
  }));checks.push('32 concurrent submissions create exactly 8 orders; backend prices retained');
  orders=await Promise.all(orders.map(async(o,i)=>(await req(`/api/orders/${o.id}/actions/pay`,users[i],{requestId:randomUUID(),version:o.version})).data.order));
  orders=await Promise.all(orders.map(async(o,i)=>(await req(`/api/orders/${o.id}/actions/cancel`,users[i],{requestId:randomUUID(),version:o.version})).data.order));
  assert.ok(orders.every(o=>o.status==='cancelled'&&o.payment.refunded===o.price));checks.push('8 parallel mock pay/cancel/full-refund flows');
  const routes=['/api/products','/api/teams','/api/orders','/api/notifications?summary=1','/api/persona','/teams.html','/index.html','/api/preferences'];
  for(const concurrency of [8,16]){
    const phase=`mixed-${concurrency}`,began=performance.now();
    for(let b=0;b<160;b+=concurrency)await Promise.all(Array.from({length:Math.min(concurrency,160-b)},(_,j)=>req(routes[(b+j)%routes.length],users[(b+j)%8],undefined,200,phase)));
    const result=stats(phase);result.durationMs=+(performance.now()-began).toFixed(2);result.requestsPerSecond=+(result.requests*1000/result.durationMs).toFixed(2);
    checks.push(result);
  }
  if(sustainSeconds){
    const began=performance.now(),phase='sustained-3';
    // Three concurrent requests each second (180/min), normal shared-IP limit unchanged.
    // First minute also includes setup/burst traffic; no limiter resets or privileged headers.
    for(let second=0;second<sustainSeconds;second++){
      await new Promise(r=>setTimeout(r,Math.max(0,began+second*1000-performance.now())));
      await Promise.all(Array.from({length:3},(_,j)=>req(routes[(second*3+j)%routes.length],users[(second*3+j)%8],undefined,200,phase)));
      if((second+1)%30===0)console.error(`sustained ${second+1}/${sustainSeconds}s complete`);
    }
    checks.push({...stats(phase),scheduledSeconds:sustainSeconds,concurrency:3});
  }
  await req('/api/orders',null,undefined,401);
  await req('/api/admin',users[0],undefined,403);
  await req('/api/orders/'+orders[0].id,users[1],undefined,404);
  await stop();await start();
  assert.equal((await req('/api/auth/get-session',users[0])).data.user.id,users[0].id);
  assert.equal((await req('/api/orders',users[0])).data.orders.length,1);
  await req('/api/health');await stop();checks.push('restart preserves account session/order; anonymous/admin/IDOR denied');
  const db=new DatabaseSync(path.join(directory,'auth.sqlite'),{readOnly:true}),channel=new DatabaseSync(path.join(directory,'mock-services.sqlite'),{readOnly:true});
  let journal,provider;
  try{
    assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,8);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    journal=inspectPaymentJournal(db);provider=inspectLocalPaymentChannel(db,channel);
    assert.equal(journal.ok,true);assert.equal(journal.receipts,16);assert.equal(journal.legacyUncovered,0);assert.equal(journal.ledger.totals.custodyCents,'0');assert.equal(provider.ok,true);
  }finally{channel.close();db.close();}
  const result={ok:true,node:process.version,platform:process.platform,directory,scope:'isolated-loopback-http-mock',publicCapacityVerified:false,tlsAndBandwidthIncluded:false,totalRequests:samples.length,statusCounts:counts,checks,journal,provider};
  writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await stop();writeFileSync(path.join(directory,'runtime.txt'),logs);}
