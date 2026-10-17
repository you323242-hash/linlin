import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('免费组队撤权后的旧请求与举报隔离HTTP专项',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'delta-r146-revocation-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`;let child,db;
 async function start(){
  child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('ISOLATED_START_TIMEOUT')),15000);child.stderr.on('data',()=>{});child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('ISOLATED_EXIT_'+code));});});
  db=new DatabaseSync(path.join(directory,'auth.sqlite'));
 }
 async function stop(){db?.close();db=null;if(child?.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});}
 async function req(route,user,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{...(user?{Cookie:user.cookie}:{}),...(body?{Origin:base,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};}
 const post=(route,user,body={})=>req(route,user,{...body,requestId:randomUUID()});
 const action=(room,user,verb,body)=>post(`/api/teams/${room}/actions/${verb}`,user,body);
 const fields={title:'隔离撤权专项146',intro:'合成记录，不属于实际用户',when:'现在',need:1,mode:'机密行动',style:'稳健搜集',mic:'text',tags:'愿意配合',selfTags:'耐心沟通',agree:true};
 try{
  await start();const users=[];
  for(let i=0;i<3;i++){const r=await req('/api/auth/sign-up/email',null,{name:'撤权专项'+i,email:`r146-${i}@example.test`,password:'Disposable-R146-test-only!',termsAccepted:true});assert.equal(r.status,200);users.push({...r.data.user,cookie:r.cookie});}
  const [host,member,admin]=users;db.prepare("UPDATE user SET role='admin' WHERE id=?").run(admin.id);
  const created=await post('/api/teams',host,fields);assert.equal(created.status,200);const room=created.data.roomId;
  await action(room,member,'join',{note:'加入合成测试'});assert.equal((await action(room,host,'accept',{userId:member.id})).status,200);
  const oldMessage={message:'退出前一次有效合成消息',requestId:randomUUID()};
  assert.equal((await req(`/api/teams/${room}/actions/message`,member,oldMessage)).status,200);
  await t.test('退出后新写入与读取拒绝，旧幂等重放不复活权限或新增消息',async()=>{
   assert.equal((await action(room,member,'leave')).status,200);
   assert.equal((await req(`/api/teams/${room}/messages`,member)).status,403);
   assert.equal((await action(room,member,'message',{message:'退出后的新消息'})).status,403);
   const replay=await req(`/api/teams/${room}/actions/message`,member,oldMessage);assert.equal(replay.status,200);assert.equal(replay.data.membership.state,'left');
   assert.equal(db.prepare('SELECT count(*) AS n FROM team_messages WHERE room_id=?').get(room).n,1);
   assert.equal((await req(`/api/teams/${room}/messages`,member)).status,403);
  });
  let reportId;
  await t.test('重新加入后被移出仍可举报，举报不自动处罚且后台不可越权',async()=>{
   assert.equal((await action(room,member,'join',{note:'重新申请'})).status,200);assert.equal((await action(room,host,'accept',{userId:member.id})).status,200);
   assert.equal((await action(room,host,'remove',{userId:member.id})).status,200);
   assert.equal((await req(`/api/teams/${room}/messages`,member)).status,403);assert.equal((await action(room,member,'message',{message:'被移出后不可发言'})).status,403);
   const reported=await action(room,member,'report',{targetId:host.id,kind:'骚扰 / 辱骂',reason:'合成测试，保留被移出后的举报渠道'});assert.equal(reported.status,200);reportId=reported.data.reportId;
   assert.equal((await action(room,member,'report',{targetId:host.id,kind:'骚扰 / 辱骂',reason:'合成重复举报应拒绝'})).status,409);
   assert.equal((await req('/api/team-admin',member)).status,403);assert.equal((await post('/api/team-admin/review',member,{id:reportId,status:'verified',reason:'普通成员不可自行核实'})).status,403);
   const list=await req('/api/team-admin',admin);assert.equal(list.status,200);assert.equal(list.data.reports.find(r=>r.id===reportId).status,'pending');
   assert.equal(db.prepare('SELECT count(*) AS n FROM team_restrictions').get().n,0);
  });
  await t.test('重启保留撤权和待核实举报，不恢复消息访问',async()=>{
   await stop();await start();assert.equal((await req(`/api/teams/${room}/messages`,member)).status,403);
   assert.equal((await req('/api/team-admin',admin)).data.reports.find(r=>r.id===reportId).status,'pending');
   assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  });
 }finally{await stop();}
});
