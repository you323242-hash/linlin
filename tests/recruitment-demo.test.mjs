import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {startRecruitmentDemo} from '../scripts/recruitment-demo.mjs';
const source=path.resolve(import.meta.dirname,'..');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('招聘体验：免密码独立访客、真实操作与原认证隔离',{timeout:40000},async t=>{
 const port=await freePort(),backendPort=await freePort(),origin='http://127.0.0.1:'+port;
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'qingbo-recruitment-test-'));
 const app=await startRecruitmentDemo({source,data,origin,port,backendPort});
 async function call(route,cookie='',body,requestOrigin=origin){const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:requestOrigin,'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});const bytes=await r.text();return {status:r.status,body:r.headers.get('content-type')?.includes('json')?JSON.parse(bytes):bytes,cookies:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 try{
  await t.test('首页标记合成演示，访客无需提交账户密码且不是共享账号',async()=>{
   assert.match((await call('/teams.html')).body,/招聘体验/);
   const a=await call('/api/me'),b=await call('/api/me');
   assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.body.user.id,b.body.user.id);
   assert.match(a.cookies,/qingbo-recruitment\./);assert.ok(!a.cookies.includes('better-auth.'));
   app.a=a;app.b=b;assert.equal((await call('/api/me',a.cookies)).body.user.id,a.body.user.id);
  });
  await t.test('招聘者可发布、申请、确认和聊天，后台仍拒绝',async()=>{
   const a=app.a.cookies,b=app.b.cookies;
   const fields={title:'合成招聘体验队',intro:'仅演示',when:'在线等',need:1,mode:'机密行动',style:'正常配装',mic:'text',tags:'',selfTags:'',agree:true,gameId:'SYNTHETIC_ID',requestId:randomUUID()};
   const created=await call('/api/teams?channel=mobile',a,fields);assert.equal(created.status,200);const id=created.body.roomId;
   assert.equal((await call('/api/teams/'+id+'/actions/join?channel=mobile',b,{requestId:randomUUID(),note:'演示申请'})).status,200);
   assert.equal((await call('/api/teams/'+id+'/actions/accept?channel=mobile',a,{requestId:randomUUID(),userId:app.b.body.user.id})).status,200);
   assert.equal((await call('/api/teams/'+id+'/actions/message?channel=mobile',b,{requestId:randomUUID(),message:'合成演示消息'})).status,200);
   assert.equal((await call('/api/teams/'+id+'/messages?channel=mobile',a)).body.messages.length,1);
   assert.equal((await call('/api/teams/'+id+'/messages',a)).status,404);
   assert.equal((await call('/api/admin',a)).status,403);
   assert.equal((await call('/api/teams',a,{...fields,requestId:randomUUID()},'https://other.example')).status,403);
  });
  await t.test('付费仅模拟且可以操作新单；密码注册登录入口关闭',async()=>{
   assert.equal((await call('/api/integrations')).body.realMoneyEnabled,false);
   const order=await call('/api/orders',app.a.cookies,{requestId:randomUUID(),mode:'secret',rulesAccepted:true});assert.equal(order.status,200);
   assert.equal((await call('/api/auth/sign-in/email','',{email:'none@example.test',password:'not-a-real-password'})).status,403);
   assert.equal((await call('/api/auth/sign-up/email','',{name:'not-created'})).status,403);
   const other=await call('/api/me','delta.session_token=NOT_A_DEMO_COOKIE; delta-staging.session_token=ALSO_NOT_DEMO');assert.notEqual(other.body.user.id,app.a.body.user.id);
  });
  await t.test('游客刷新保持身份，资料不串号，退出后的旧会话失效',async()=>{
   const a=app.a.cookies,b=app.b.cookies;
   assert.equal((await call('/api/me',a)).body.user.id,app.a.body.user.id);
   const profile=(await call('/api/teams/profile',a)).body.profile;
   assert.equal((await call('/api/teams/profile',a,{...profile,signature:'游客本人合成资料'})).status,200);
   assert.notEqual((await call('/api/teams/profile',b)).body.profile.signature,'游客本人合成资料');
   assert.equal((await call('/api/orders',b)).body.orders.length,0);
   assert.equal((await call('/api/auth/sign-out',a,{})).status,200);
   assert.equal((await call('/api/orders',a)).status,401);
   const fresh=await call('/api/me');assert.equal(fresh.status,200);assert.notEqual(fresh.body.user.id,app.a.body.user.id);
  });
 }finally{await app.close();}
});
test('拒绝将未知既有数据库当招聘演示环境',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'qingbo-non-demo-'));fs.writeFileSync(path.join(data,'auth.sqlite'),'not copied from actual data');
 await assert.rejects(startRecruitmentDemo({source,data,origin:'http://127.0.0.1:59981',port:59981,backendPort:59982}),/REFUSE_EXISTING_NON_DEMO_DATABASE/);
});
