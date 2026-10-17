import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('普通站游客选项：旧账号升级、独立会话、免费及模拟付费操作',{timeout:45000},async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'delta-guest-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const origin='http://127.0.0.1:'+port;let child;
 const start=async()=>{child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_PHONE_MODE:'disabled',AUTH_REQUIRE_EMAIL_VERIFICATION:'false',AUTH_DATA_DIR:directory,PORT:String(port),BETTER_AUTH_URL:origin,PAID_ORDERS_MODE:'enabled'}});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('guest fixture start timeout')),15000);child.stdout.on('data',v=>{if(v.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('guest fixture exit '+code));});child.once('error',reject);});};
 const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});};
 const call=async(route,cookie='',body,requestOrigin=origin)=>{const response=await fetch(origin+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:requestOrigin,'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});return {response,status:response.status,body:await response.json().catch(()=>null),cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};};
 try{
  await start();
  const credentials={name:'原有合成用户',email:'regular@example.test',password:'Synthetic-account-password!123',termsAccepted:true};
  const regular=await call('/api/auth/sign-up/email','',credentials);assert.equal(regular.status,200);assert.equal(regular.body.user.isGuest,false);
  const key=readFileSync(path.join(directory,'auth-secret'),'utf8');
  await stop();
  // Simulate the pre-guest auth schema, using only this disposable fixture.
  const old=new DatabaseSync(path.join(directory,'auth.sqlite'));old.exec('ALTER TABLE user DROP COLUMN isAnonymous');old.close();
  await start();
  assert.equal(readFileSync(path.join(directory,'auth-secret'),'utf8'),key);
  assert.ok(readdirSync(path.join(directory,'backups')).some(v=>v.startsWith('before-migration-')));
  assert.equal((await call('/api/me',regular.cookie)).body.user.id,regular.body.user.id);
  assert.equal((await call('/api/auth/sign-in/anonymous',regular.cookie,{termsAccepted:true})).status,409);
  assert.equal((await call('/api/auth/sign-in/anonymous','',{})).status,400);
  assert.equal((await call('/api/auth/sign-in/anonymous','',{termsAccepted:true},'https://other.example')).status,403);
  const a=await call('/api/auth/sign-in/anonymous','',{termsAccepted:true,role:'admin',email:'ignored@example.test'});
  const b=await call('/api/auth/sign-in/anonymous','',{termsAccepted:true});
  assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.body.user.id,b.body.user.id);assert.equal(a.body.user.isGuest,true);assert.equal(a.body.user.role,'user');assert.equal(a.body.user.email,'');assert.ok(!('token' in a.body));
  assert.match(a.response.headers.getSetCookie().join(';'),/HttpOnly/i);
  assert.match(a.response.headers.getSetCookie().join(';'),/SameSite=Lax/i);
  for(let i=0;i<2;i++)assert.equal((await call('/api/me',a.cookie)).body.user.id,a.body.user.id);
  assert.equal((await call('/api/auth/sign-in/anonymous',a.cookie,{termsAccepted:true})).body.user.id,a.body.user.id);
  const profile=(await call('/api/teams/profile?channel=mobile',a.cookie)).body.profile;
  assert.equal((await call('/api/teams/profile?channel=mobile',a.cookie,{...profile,signature:'合成游客名片'})).status,200);
  assert.notEqual((await call('/api/teams/profile?channel=mobile',b.cookie)).body.profile.signature,'合成游客名片');
  const created=await call('/api/teams?channel=mobile',a.cookie,{title:'合成游客组队',intro:'仅隔离测试',when:'在线等',need:1,mode:'机密行动',style:'正常配装',mic:'text',tags:'',selfTags:'',agree:true,gameId:'SYNTHETIC',requestId:randomUUID()});assert.equal(created.status,200);
  assert.equal((await call('/api/teams/'+created.body.roomId+'/actions/join?channel=mobile',b.cookie,{requestId:randomUUID(),note:'合成申请'})).status,200);
  assert.equal((await call('/api/teams/'+created.body.roomId+'/actions/accept?channel=mobile',a.cookie,{requestId:randomUUID(),userId:b.body.user.id})).status,200);
  assert.equal((await call('/api/integrations')).body.realMoneyEnabled,false);
  const order=await call('/api/orders',a.cookie,{requestId:randomUUID(),mode:'secret',rulesAccepted:true});assert.equal(order.status,200);
  const paid=await call('/api/orders/'+order.body.order.id+'/actions/pay',a.cookie,{requestId:randomUUID(),version:order.body.order.version});assert.equal(paid.status,200);
  assert.equal((await call('/api/orders/'+order.body.order.id+'/actions/pay',b.cookie,{requestId:randomUUID(),version:order.body.order.version})).status,404);
  assert.equal((await call('/api/payment-callbacks/wechat',a.cookie,{verified:true})).status,503);
  assert.equal((await call('/api/orders',b.cookie)).body.orders.length,0);
  for(const endpoint of ['/api/admin','/api/team-admin','/api/security','/api/privacy/closure-preflight'])assert.equal((await call(endpoint,a.cookie)).status,403);
  assert.equal((await call('/api/auth/phone-number/set-password',a.cookie,{newPassword:'Synthetic-password!123'})).status,403);
  assert.equal((await call('/api/auth/delete-anonymous-user',a.cookie,{})).status,403);
  await stop();await start();
  assert.equal((await call('/api/me',a.cookie)).body.user.id,a.body.user.id);
  assert.equal((await call('/api/teams/profile?channel=mobile',a.cookie)).body.profile.signature,'合成游客名片');
  assert.equal((await call('/api/orders',a.cookie)).body.orders.length,1);
  assert.equal((await call('/api/auth/sign-out',a.cookie,{})).status,200);
  assert.equal((await call('/api/me',a.cookie)).status,401);
  assert.equal((await call('/api/orders',a.cookie)).status,401);
  assert.equal((await call('/api/auth/sign-in/email','',{email:credentials.email,password:credentials.password})).status,200);
  // Five persisted guest creations per peer/hour, including across restart.
  for(let i=0;i<3;i++)assert.equal((await call('/api/auth/sign-in/anonymous','',{termsAccepted:true})).status,200);
  assert.equal((await call('/api/auth/sign-in/anonymous','',{termsAccepted:true})).status,429);
 }finally{await stop();}
});

test('展示页移除品牌标识，保留功能导航与登录入口',()=>{
 const root=path.resolve(import.meta.dirname,'../dist');
 for(const file of ['index.html','teams.html','service.html','orders.html','account.html','admin.html','rules.html','recovery.html','brand-preview.html']){
  const text=readFileSync(path.join(root,file),'utf8');
  assert.doesNotMatch(text,/晴泊|晴天电竞|QINGBO ESPORTS|club-mark\.svg|qingbo-(mark|favicon)\.svg/);
  assert.match(text,/<title>[^<]+<\/title>/);
 }
 const teams=readFileSync(path.join(root,'teams.html'),'utf8');assert.match(teams,/data-panel="account"/);assert.match(teams,/id="i-user"/);
 const ui=readFileSync(path.join(root,'auth-ui.js'),'utf8');assert.match(ui,/data-login-method="guest"/);assert.match(ui,/data-guest-form/);assert.match(ui,/\/api\/auth\/sign-in\/anonymous/);
});

test('游客表单要求主动同意，失败可重试，成功保持原返回页面',async()=>{
 const saved={fetch:globalThis.fetch,BroadcastChannel:globalThis.BroadcastChannel,location:globalThis.location};
 globalThis.BroadcastChannel=undefined;let handler,calls=0,returned='';
 const status={textContent:''},button={disabled:false};
 const form={elements:{termsAccepted:{checked:false}},querySelector:s=>s==='[type="submit"]'?button:status,addEventListener:(_,fn)=>handler=fn};
 const container={querySelector:s=>s==='[data-guest-form]'?form:null,querySelectorAll:()=>[]};
 try{
  globalThis.location={href:'http://local.test/?returnTo=%2Fteams.html',replace:value=>returned=value};
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'/api/auth/sign-in/anonymous');assert.deepEqual(JSON.parse(options.body),{termsAccepted:true});return new Response('{}',{status:429,headers:{'Retry-After':'3600'}});};
  const {mountAuthPanel}=await import('../dist/auth-ui.js?guest-form-test');mountAuthPanel(container);
  await handler({preventDefault(){}});assert.equal(calls,0);assert.match(status.textContent,/同意协议/);
  form.elements.termsAccepted.checked=true;
  await handler({preventDefault(){}});assert.equal(calls,1);assert.equal(button.disabled,false);assert.match(status.textContent,/3600/);assert.equal(returned,'');
  globalThis.fetch=async()=>new Response('{}',{status:200});await handler({preventDefault(){}});assert.equal(returned,'/teams.html');assert.equal(button.disabled,false);
 }finally{Object.assign(globalThis,saved);}
});
