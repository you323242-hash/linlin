import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';

test('网站意见实际HTTP：登录、来源、本人隔离、管理处理、限流与重启',async()=>{
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(path.join(parent,'delta-feedback-http-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`;let child;
 const start=async()=>{
  const env={...process.env,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:dir};
  for(const key of ['BETTER_AUTH_SECRET','STAGING_ACCESS_TOKEN','TRUSTED_PROXY_IPS','AUTH_REQUIRE_EMAIL_VERIFICATION','AUTH_PHONE_MODE','BACKUP_KEY_FILE','AUTH_KEY_REF'])delete env[key];
  child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),15000);child.stdout.on('data',b=>{if(String(b).includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('startup failed'));});});
 };
 const stop=async()=>{if(child&&child.exitCode===null){await new Promise(r=>{child.once('exit',r);child.kill();});}};
 const req=async(route,cookie='',body,origin=base)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),retryAfter:r.headers.get('Retry-After'),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};};
 try{
  await start();const users=[];
  for(let i=0;i<3;i++)users.push(await req('/api/auth/sign-up/email','',{email:`feedback${i}@example.test`,name:'反馈测试'+i,password:'Feedback-test-password-2026!',termsAccepted:true}));
  assert.ok(users.every(u=>u.status===200));const [a,b,admin]=users;
  const db=new DatabaseSync(path.join(dir,'auth.sqlite'));db.prepare("UPDATE user SET role='admin' WHERE id=?").run(admin.data.user.id);db.close();
  const body={category:'bug',content:'手机页面布局出现问题',requestId:'feedback-http-1'};
  assert.equal((await req('/api/site-feedback')).status,401);
  assert.equal((await req('/api/site-feedback',a.cookie,body,'https://other.test')).status,403);
  const plain=await fetch(base+'/api/site-feedback',{method:'POST',headers:{Cookie:a.cookie,Origin:base,'Content-Type':'text/plain'},body:JSON.stringify(body)});assert.equal(plain.status,403);
  const invalid=await fetch(base+'/api/site-feedback',{method:'POST',headers:{Cookie:b.cookie,Origin:base,'Content-Type':'application/json'},body:'['});assert.equal(invalid.status,400);
  const huge=await fetch(base+'/api/site-feedback',{method:'POST',headers:{Cookie:b.cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...body,content:'a'.repeat(13000)})});assert.equal(huge.status,413);
  assert.equal((await req('/api/site-feedback',b.cookie)).data.feedback.length,0);
  assert.equal((await req('/api/site-feedback',b.cookie,{...body,content:'a'.repeat(2001)})).status,400);
  assert.equal((await req('/api/site-feedback',b.cookie)).data.feedback.length,0);
  const created=await req('/api/site-feedback',a.cookie,body);assert.equal(created.status,200,JSON.stringify(created.data));const id=created.data.feedback.id;
  assert.equal((await req('/api/site-feedback',a.cookie)).data.feedback.length,1);
  assert.equal((await req('/api/site-feedback',b.cookie)).data.feedback.length,0);
  assert.equal((await req('/api/site-feedback/admin',a.cookie)).status,403);
  assert.equal((await req('/api/site-feedback/'+id+'/handle',b.cookie,{status:'resolved',reason:'越权处理测试记录',version:1})).status,403);
  assert.equal((await req('/api/site-feedback?limit=51',a.cookie)).status,400);
  assert.equal((await req('/api/site-feedback/'+id+'/handle',admin.cookie,{status:'resolved',reason:'已复现修复并验证',version:1})).status,200);
  for(let i=0;i<4;i++)assert.equal((await req('/api/site-feedback',a.cookie,body)).status,200);
  const limited=await req('/api/site-feedback',a.cookie,body);assert.equal(limited.status,429);assert.equal(limited.retryAfter,'60');
  await stop();await start();const saved=await req('/api/site-feedback',a.cookie);assert.equal(saved.status,200);assert.equal(saved.data.feedback[0].status,'resolved');
  assert.equal((await req('/api/site-feedback',a.cookie,body)).status,429);
  const privacyUser=await req('/api/auth/sign-up/email','',{email:'privacy-http@example.test',name:'隐私测试',password:'Privacy-only-test-password!',termsAccepted:true});assert.equal(privacyUser.status,200);
  const privates=[];
  for(const kind of ['correction','export','closure']){
   const value={category:'privacy-'+kind,content:'合成本人隐私请求，验证受理不等于删除',requestId:'privacy-http-'+kind,userId:a.data.user.id};
   const submitted=await req('/api/site-feedback',privacyUser.cookie,value);assert.equal(submitted.status,200);assert.equal(submitted.data.feedback.category,value.category);privates.push(submitted.data.feedback);
  }
  assert.equal((await req('/api/site-feedback',privacyUser.cookie)).data.feedback.length,3);
  assert.equal((await req('/api/site-feedback',b.cookie)).data.feedback.length,0);
  const privacyId=privates[2].id;
  const preflightRoute='/api/site-feedback/'+privacyId+'/closure-preflight';
  assert.equal((await req(preflightRoute)).status,401);
  assert.equal((await req(preflightRoute,privacyUser.cookie)).status,403);
  assert.equal((await req(preflightRoute,b.cookie)).status,403);
  assert.equal((await req('/api/site-feedback/'+privates[0].id+'/closure-preflight',admin.cookie)).status,404);
  const checked=await req(preflightRoute,admin.cookie);assert.equal(checked.status,200);assert.equal(checked.data.preflight.advisoryOnly,true);
  assert.equal(checked.data.preflight.footprint.privacyRequests,3);
  assert.equal(Object.hasOwn(checked.data,'userId'),false);
  const checkedAudit=new DatabaseSync(path.join(dir,'auth.sqlite'));
  assert.equal(checkedAudit.prepare("SELECT count(*) n FROM audit_events WHERE action='privacy_preflight_viewed' AND actor_id=? AND target_id=?").get(admin.data.user.id,privacyId).n,1);
  checkedAudit.close();
  assert.equal((await req(preflightRoute,admin.cookie,{userId:b.data.user.id})).status,405);
  const ownClosure=await req('/api/site-feedback',admin.cookie,{category:'privacy-closure',content:'合成管理员本人注销请求',requestId:'privacy-admin-self'});
  assert.equal(ownClosure.status,200);
  assert.equal((await req('/api/site-feedback/'+ownClosure.data.feedback.id+'/closure-preflight',admin.cookie)).status,403);
  assert.equal((await req('/api/site-feedback/'+privacyId+'/handle',privacyUser.cookie,{status:'resolved',version:1,reason:'普通用户不能自行办理申请'})).status,403);
  assert.equal((await req('/api/site-feedback/'+privacyId+'/handle',admin.cookie,{status:'resolved',version:1,reason:'已答复申请；本轮未执行账号删除'})).status,200);
  assert.equal((await req('/api/me',privacyUser.cookie)).status,200);
  await stop();await start();
  assert.equal((await req('/api/site-feedback',privacyUser.cookie)).data.feedback.find(x=>x.id===privacyId).status,'resolved');
 }finally{await stop();const resolved=realpathSync(dir);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('delta-feedback-http-'));rmSync(resolved,{recursive:true});}
});


