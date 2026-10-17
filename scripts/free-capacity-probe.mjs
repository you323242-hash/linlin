// Synthetic loopback only; no URL/data-directory arguments or live database access.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '../server/auth.mjs';
import {prepareRuntimeDirectory} from '../server/config.mjs';

assert.equal(process.argv.length,2,'This isolated probe takes no target or runtime-directory arguments');
const directory=mkdtempSync(path.join(os.tmpdir(),'delta-free-capacity-')),root=path.resolve(import.meta.dirname,'..');
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const base='http://127.0.0.1:'+port,users=[],rooms=[],samples=[],resources=[],phases=[];
let child,timer,stderr='',messagesSent=0;
const cpu=()=>{const sums=os.cpus().reduce((a,c)=>{a.idle+=c.times.idle;a.total+=Object.values(c.times).reduce((x,y)=>x+y,0);return a;},{idle:0,total:0});return sums;};
let previousCPU=cpu();
function resourceSample(){
 const next=cpu(),delta=next.total-previousCPU.total;
 const hostCPU=delta>0?100*(1-(next.idle-previousCPU.idle)/delta):null;previousCPU=next;
 let available=os.freemem(),serverRSS=null;
 if(process.platform==='linux'){
  available=Number(readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1])*1024;
  if(child?.exitCode===null){try{serverRSS=Number(readFileSync('/proc/'+child.pid+'/status','utf8').match(/^VmRSS:\s+(\d+)/m)?.[1])*1024;}catch{}}
 }
 resources.push({hostCPU,availableBytes:available,totalBytes:os.totalmem(),serverRSS});
}
async function request(route,user,body,expected=200,phase='setup'){
 const began=performance.now();let response;
 try{
  response=await fetch(base+route,{signal:AbortSignal.timeout(10000),method:body?'POST':'GET',cache:'no-store',headers:{...(user?{Cookie:user.cookie}:{}),...(body?{Origin:base,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const bytes=await response.arrayBuffer(),isJSON=response.headers.get('content-type')?.includes('application/json');
  samples.push({phase,api:route.startsWith('/api/'),write:!!body,ms:performance.now()-began,status:response.status,bytes:bytes.byteLength});
  assert.equal(response.status,expected,'Unexpected HTTP status at '+route);
  return isJSON?JSON.parse(Buffer.from(bytes).toString('utf8')):null;
 }catch(error){if(!response)samples.push({phase,api:route.startsWith('/api/'),write:!!body,ms:performance.now()-began,status:0,bytes:0});throw error;}
}
const action=(room,user,verb,fields={},phase)=>request('/api/teams/'+room+'/actions/'+verb,user,{...fields,requestId:randomUUID()},200,phase);
async function recruit(pair,phase='setup'){
 const host=users[pair*2],member=users[pair*2+1];
 const room=await request('/api/teams',host,{requestId:randomUUID(),title:'隔离混合招募'+pair,intro:'友善协作测试',when:'现在可开始',need:1,mode:'机密行动',style:'稳健搜集',mic:'text',tags:'愿意配合',selfTags:'耐心沟通',agree:true},200,phase);
 rooms[pair]=room.roomId;
 await action(room.roomId,member,'join',{},phase);await action(room.roomId,host,'accept',{userId:member.id},phase);
}
const stats=(list)=>{const sorted=list.map(x=>x.ms).sort((a,b)=>a-b);return {requests:list.length,p50ms:sorted[Math.ceil(sorted.length*.5)-1]??null,p95ms:sorted[Math.ceil(sorted.length*.95)-1]??null,maxMs:sorted.at(-1)??null,bytes:list.reduce((n,x)=>n+x.bytes,0)};};
try{
 prepareRuntimeDirectory({dataDirectory:directory,environment:'test'});
 const fixture=await createAuth({baseURL:base,dataDirectory:directory,environment:'test',requireEmailVerification:false,phoneMode:'disabled'});
 try{
  for(let i=0;i<20;i++){
   const r=await fixture.auth.api.signUpEmail({body:{name:'合成活动账户'+i,email:'free-'+randomUUID()+'@example.test',password:'Synthetic-'+randomUUID()+'!',termsAccepted:true},asResponse:true});assert.equal(r.status,200);
   const data=await r.json();users.push({id:data.user.id,cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')});
  }
 }finally{fixture.database.close();}
 child=spawn(process.execPath,[path.join(root,'server/index.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:directory,PORT:String(port),BETTER_AUTH_URL:base,PAID_ORDERS_MODE:'disabled'}});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('ISOLATED_START_TIMEOUT')),15000);child.stderr.on('data',b=>{stderr=(stderr+b).slice(-65536);});child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(Error('ISOLATED_START_EXIT_'+code));});});
 await request('/api/health');for(let pair=0;pair<9;pair++)await recruit(pair);
 resourceSample();timer=setInterval(resourceSample,500);
 for(const concurrency of [5,10,20]){
  const phase='free-mixed-'+concurrency,began=performance.now();
  for(let round=0;round<6;round++){
   await new Promise(r=>setTimeout(r,Math.max(0,began+round*2000-performance.now())));
   await Promise.all(users.slice(0,concurrency).map(async(user,index)=>{
    const pair=Math.floor(index/2);
    if(index===18&&!rooms[pair]){await recruit(pair,phase);return;}
    if(!rooms[pair]){await request('/api/persona',user,undefined,200,phase);return;}
    const room=rooms[pair];
    switch((index+round)%8){
     case 0:await request('/api/teams',user,undefined,200,phase);break;
     case 1:await request('/api/teams/'+room,user,undefined,200,phase);break;
     case 2:await request('/api/teams/mine',user,undefined,200,phase);break;
     case 3:await request('/api/teams/'+room+'/messages',user,undefined,200,phase);break;
     case 4:await action(room,user,'message',{message:'混合流量合成消息 '+concurrency+'/'+round},phase);messagesSent++;break;
     case 5:await request('/api/persona',user,undefined,200,phase);break;
     case 6:await request('/teams.html',null,undefined,200,phase);break;
     case 7:await request('/assets/original/companion-jade.webp',null,undefined,200,phase);break;
    }
   }));
  }
  const list=samples.filter(s=>s.phase===phase);
  phases.push({phase,concurrency,rounds:6,scheduledIntervalMs:2000,durationMs:performance.now()-began,api:stats(list.filter(s=>s.api)),static:stats(list.filter(s=>!s.api)),writes:stats(list.filter(s=>s.write)),statusCounts:Object.fromEntries([...new Set(list.map(s=>s.status))].map(code=>[code,list.filter(s=>s.status===code).length]))});
  console.error('PHASE_COMPLETE '+phase);
  await new Promise(r=>setTimeout(r,1200));
 }
 await request('/api/teams/'+rooms[0]+'/messages',users[19],undefined,403,'authorization');
 await request('/api/teams/mine',null,undefined,401,'authorization');
 await request('/api/orders',users[0],{requestId:randomUUID(),mode:'secret',rulesAccepted:true},403,'authorization');
 await request('/api/health');
 clearInterval(timer);resourceSample();
 if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});
 const db=new DatabaseSync(path.join(directory,'auth.sqlite'),{readOnly:true});
 let integrity;
 try{
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  const counts={users:db.prepare('SELECT count(*) n FROM user').get().n,rooms:db.prepare('SELECT count(*) n FROM team_rooms').get().n,members:db.prepare("SELECT count(*) n FROM team_members WHERE state='confirmed'").get().n,messages:db.prepare('SELECT count(*) n FROM team_messages').get().n,orders:db.prepare('SELECT count(*) n FROM orders').get().n};
  assert.deepEqual(counts,{users:20,rooms:10,members:20,messages:messagesSent,orders:0});assert.ok(messagesSent>0);integrity={quickCheck:'ok',foreignKeyViolations:0,counts};
 }finally{db.close();}
 const errorEvents=[];const logDirectory=path.join(directory,'logs');
 for(const file of readdirSync(logDirectory)){if(!file.endsWith('.jsonl'))continue;for(const line of readFileSync(path.join(logDirectory,file),'utf8').trim().split('\n')){if(!line)continue;const e=JSON.parse(line);if(['request_error','worker_error'].includes(e.event))errorEvents.push(e.code);}}
 assert.equal(errorEvents.length,0,'Unexpected server error events');
 const cpuSamples=resources.filter(r=>r.hostCPU!==null).map(r=>r.hostCPU),rss=resources.filter(r=>r.serverRSS!==null).map(r=>r.serverRSS);
 const report={ok:true,scope:'isolated-free-team-mixed-loopback',node:process.version,platform:process.platform,publicCapacityVerified:false,tlsAndBandwidthIncluded:false,lockWaitMeasured:false,unexpectedServerErrors:errorEvents.length,phases,resources:{samples:resources.length,hostCPUAveragePercent:cpuSamples.reduce((a,b)=>a+b,0)/cpuSamples.length,hostCPUMaxPercent:Math.max(...cpuSamples),minimumAvailableBytes:Math.min(...resources.map(r=>r.availableBytes)),hostTotalBytes:os.totalmem(),peakServerRSSBytes:rss.length?Math.max(...rss):null},integrity};
 writeFileSync(path.join(directory,'free-capacity-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,report},null,2));
}finally{
 clearInterval(timer);if(child?.exitCode===null&&child.signalCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});
 writeFileSync(path.join(directory,'runtime.txt'),stderr);
}
