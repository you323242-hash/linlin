import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('免费聊天在隔离外部SQLite短写锁释放后恢复且只写一次',{timeout:25000},async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'delta-free-lock-')),listener=net.createServer();
 await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base='http://127.0.0.1:'+port;let child,holder;
 const stop=async p=>{if(p?.exitCode===null&&p.signalCode===null)await new Promise(r=>{p.once('exit',r);p.kill();});};
 const req=async(route,cookie,body)=>{const r=await fetch(base+route,{signal:AbortSignal.timeout(12000),method:body?'POST':'GET',headers:{Cookie:cookie||'',...(body?{Origin:base,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};};
 try{
  child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:dir,PAID_ORDERS_MODE:'disabled'}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('LOCK_FIXTURE_TIMEOUT')),15000);child.stderr.on('data',()=>{});child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('LOCK_FIXTURE_EXIT'));});});
  const users=[];for(let i=0;i<2;i++){const r=await req('/api/auth/sign-up/email','',{name:'合成写锁'+i,email:'lock-'+i+'@example.test',password:'Synthetic-lock-password-2026!',termsAccepted:true});assert.equal(r.status,200);users.push(r);}
  const room=await req('/api/teams',users[0].cookie,{requestId:randomUUID(),title:'隔离写锁测试',intro:'友善协作',when:'现在可开始',need:1,mode:'机密行动',style:'稳健搜集',mic:'text',tags:'愿意配合',selfTags:'耐心沟通',agree:true});assert.equal(room.status,200);
  const id=room.data.roomId,action=(user,verb,body={})=>req('/api/teams/'+id+'/actions/'+verb,user.cookie,{...body,requestId:randomUUID()});
  assert.equal((await action(users[1],'join')).status,200);assert.equal((await action(users[0],'accept',{userId:users[1].data.user.id})).status,200);
  const code="import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');console.log('LOCKED');setTimeout(()=>{db.exec('ROLLBACK');db.close();},250);";
  holder=spawn(process.execPath,['--input-type=module','-e',code,path.join(dir,'auth.sqlite')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('LOCK_ACQUIRE_TIMEOUT')),5000);holder.stderr.on('data',()=>{});holder.stdout.on('data',b=>{if(b.toString().includes('LOCKED')){clearTimeout(timer);resolve();}});holder.once('exit',()=>{clearTimeout(timer);reject(Error('LOCK_HOLDER_EXIT'));});});
  const body={message:'写锁释放后的合成消息',requestId:randomUUID()},began=performance.now();
  const sent=await req('/api/teams/'+id+'/actions/message',users[1].cookie,body),durationMs=performance.now()-began;
  assert.equal(sent.status,200);assert.ok(durationMs>=100,'Request should wait for the controlled write lock');assert.ok(durationMs<5000,'Bounded recovery');
  assert.equal((await req('/api/teams/'+id+'/actions/message',users[1].cookie,body)).status,200);
  const list=await req('/api/teams/'+id+'/messages',users[0].cookie);assert.equal(list.status,200);assert.equal(list.data.messages.length,1);
  assert.equal((await req('/api/health')).status,200);
  await stop(holder);await stop(child);
  const db=new DatabaseSync(path.join(dir,'auth.sqlite'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,0);}finally{db.close();}
  t.diagnostic(JSON.stringify({scope:'controlled-isolated-sqlite-lock',scheduledHoldMs:250,requestMs:durationMs,messages:1,idempotent:true,publicCapacityVerified:false}));
 }finally{await stop(holder);await stop(child);}
});
