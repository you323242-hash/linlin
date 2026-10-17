import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_ROOT } from '../server/config.mjs';
import { protectResponse } from '../server/http-protection.mjs';

test('实际HTTP浏览器策略、认证流式大小限制与限频',async t=>{
  const parent=realpathSync(tmpdir()),directory=mkdtempSync(path.join(parent,'delta-http-safe-'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}`,env={...process.env,NODE_ENV:'test',APP_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:directory};
  for(const key of ['BETTER_AUTH_SECRET','TRUSTED_PROXY_IPS','STAGING_ACCESS_TOKEN','ALLOW_STAGING_MOCKS','EXTERNAL_SERVICE_MODE','BACKUP_KEY_FILE','AUTH_KEY_REF'])delete env[key];
  const child=spawn(process.execPath,['server/index.mjs'],{cwd:PROJECT_ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill();await end;}const target=realpathSync(directory);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-http-safe-'));rmSync(target,{recursive:true});});
  let ready=false;for(let i=0;i<250;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(300)})).ok){ready=true;break;}}catch{}await delay(80);}assert.ok(ready,output);
  const post=(body,type='application/json',origin=base)=>fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':type,Origin:origin},body});
  await t.test('仅公开原创插图允许条件缓存，页面/API/私有附件不继承缓存',async()=>{
    const route=base+'/assets/original/copper-outpost.webp';
    const image=await fetch(route);assert.equal(image.status,200);
    assert.equal(image.headers.get('cache-control'),'public, max-age=0, must-revalidate');
    const etag=image.headers.get('etag');assert.match(etag,/^W\/".+"$/);
    assert.ok((await image.arrayBuffer()).byteLength>0);
    for(const method of ['GET','HEAD']){
      const hit=await fetch(route,{method,headers:{'If-None-Match':`"old", ${etag}`}});
      assert.equal(hit.status,304);assert.equal(hit.headers.get('etag'),etag);
      assert.equal((await hit.arrayBuffer()).byteLength,0);assert.equal(hit.headers.get('content-length'),null);
    }
    const miss=await fetch(route,{headers:{'If-None-Match':'"outdated"'}});
    assert.equal(miss.status,200);await miss.arrayBuffer();
    const postImage=await fetch(route,{method:'POST',headers:{'If-None-Match':'*'}});
    assert.notEqual(postImage.status,304);assert.equal(postImage.headers.get('cache-control'),'no-store');await postImage.arrayBuffer();
    for(const name of ['/index.html','/auth-ui.js','/api/products','/api/me','/api/attachments/not-owned','/assets/original/not-found.webp']){
      const response=await fetch(base+name,{headers:{'If-None-Match':'*'}});
      assert.notEqual(response.status,304);assert.equal(response.headers.get('cache-control'),'no-store',name);
    }
  });
  await t.test('所有页面与拒绝响应带CSP，外部脚本/嵌入/表单受限，本地不启用HSTS',async()=>{
    for(const route of ['/','/teams.html','/api/products','/.env','/api/payments/webhook']) {
      const res=await fetch(base+route);assert.match(res.headers.get('content-security-policy'),/script-src 'self'/);
      assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(res.headers.get('content-security-policy'),/form-action 'self'/);
      assert.equal(res.headers.get('x-frame-options'),'DENY');assert.equal(res.headers.get('cross-origin-resource-policy'),'same-origin');assert.equal(res.headers.get('strict-transport-security'),null);
    }
    const headers=new Map();protectResponse({setHeader:(k,v)=>headers.set(k,v)},{environment:'staging'});assert.equal(headers.get('Strict-Transport-Security'),'max-age=86400');
  });
  await t.test('认证仍由原库处理，同源JSON类型精确检查，非法参数不导致500',async()=>{
    assert.equal((await post('{}','application/jsonp')).status,415);assert.equal((await post('{}','application/json','http://evil.test')).status,403);
    assert.equal((await post('[')).status,400);assert.equal((await post('[]')).status,400);
    const signup=await fetch(base+'/api/auth/sign-up/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'防护测试',email:'protection@example.test',password:'Protection-test-2026!',termsAccepted:true})});assert.equal(signup.status,200);
    assert.equal((await signup.json()).token,undefined);
    const cookie=signup.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    assert.equal((await fetch(base+'/api/me',{headers:{Cookie:cookie}})).status,200);
    const session=await (await fetch(base+'/api/auth/get-session',{headers:{Cookie:cookie}})).json();
    assert.equal(session.session.token,undefined);assert.equal(session.session.ipAddress,undefined);assert.equal(session.user.termsAccepted,undefined);
    assert.equal((await post(JSON.stringify({email:'protection@example.test',password:'Protection-test-2026!'}))).status,200);
    const logout=await fetch(base+'/api/auth/sign-out',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:'{}'});assert.equal(logout.status,200);
    const db=new DatabaseSync(path.join(directory,'auth.sqlite'),{readOnly:true});
    try {
      const events=db.prepare("SELECT action,reason FROM audit_events WHERE action IN ('user_registered','session_created','session_revoked')").all();
      for(const action of ['user_registered','session_created','session_revoked'])assert.ok(events.some(e=>e.action===action));
      assert.ok(!JSON.stringify(events).includes('Protection-test-2026!'));assert.ok(!JSON.stringify(events).includes('protection@example.test'));
    }finally{db.close();}
  });
  await t.test('无Content-Length的分块认证请求超限返回413，而非无界读取',async()=>{
    const status=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/auth/sign-up/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('{"large":"');req.write('x'.repeat(20000));req.end('"}');});assert.equal(status,413);
    assert.equal((await fetch(base+'/api/health')).status,200);
  });
  await t.test('认证与管理拒绝响应不可缓存且不泄露堆栈',async()=>{
    const responses = [
      await fetch(base+'/api/me'),
      await fetch(base+'/api/admin/orders'),
      await fetch(base+'/api/payments/webhook'),
      await post('{}','application/jsonp'),
      await post('{}','application/json','http://evil.test'),
    ];
    assert.deepEqual(responses.map(res=>res.status),[401,401,404,415,403]);
    for(const res of responses){
      assert.equal(res.headers.get('cache-control'),'no-store');
      assert.equal(res.headers.get('x-content-type-options'),'nosniff');
      assert.equal(res.headers.get('x-frame-options'),'DENY');
      const body=await res.text();assert.doesNotMatch(body,/node_modules|SQLITE_ERROR|at .*\.mjs:\d/);
    }
  });
  await t.test('认证总入口限频与Retry-After，不依赖业务限频或伪造IP',async()=>{
    let last;for(let i=0;i<42;i++)last=await fetch(base+'/api/auth/get-session',{headers:{'X-Forwarded-For':`192.0.2.${i}`}});
    assert.equal(last.status,429);assert.equal(last.headers.get('retry-after'),'60');
  });
  await t.test('同一网络不能换伪造IP绕过限流；窗口到期后自动恢复，无需解封',async()=>{
    const limited=await fetch(base+'/api/auth/get-session',{headers:{'X-Delta-Client-IP':'198.51.100.1','X-Real-IP':'198.51.100.2','Forwarded':'for=198.51.100.3'}});
    assert.equal(limited.status,429);
    // Only this disposable database advances expiry. No API clock/limiter reset exists.
    const db=new DatabaseSync(path.join(directory,'auth.sqlite'));
    try {db.prepare("UPDATE runtime_limits SET expires_at=0 WHERE namespace='auth-peer'").run();}finally{db.close();}
    const recovered=await fetch(base+'/api/auth/get-session');
    assert.equal(recovered.status,200);assert.equal(await recovered.json(),null);
    assert.equal(recovered.headers.get('retry-after'),null);
  });
});
