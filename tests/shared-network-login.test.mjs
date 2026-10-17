import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {createAuth} from '../server/auth.mjs';
import {prepareRuntimeDirectory} from '../server/config.mjs';
import {rateLimitError} from '../dist/business-api.mjs';

test('共享出口8账号并发登录、160次身份刷新保持各自身份，超额登录仍限流',async t=>{
 const parent=realpathSync(tmpdir()),directory=mkdtempSync(path.join(parent,'delta-shared-login-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`,password=`Synthetic-${randomUUID()}!`,users=[];
 let child;
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}const resolved=realpathSync(directory);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('delta-shared-login-'));rmSync(resolved,{recursive:true});});
 prepareRuntimeDirectory({dataDirectory:directory,environment:'test'});
 const seed=await createAuth({baseURL:base,dataDirectory:directory,environment:'test',requireEmailVerification:false,phoneMode:'disabled'});
 try{for(let i=0;i<8;i++){const response=await seed.auth.api.signUpEmail({body:{name:`合成共享出口${i}`,email:`shared-${randomUUID()}@example.test`,password,termsAccepted:true},asResponse:true});assert.equal(response.status,200);users.push((await response.json()).user);}}finally{seed.database.close();}
 const env={...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:directory,PORT:String(port),BETTER_AUTH_URL:base};
 for(const key of ['BETTER_AUTH_SECRET','STAGING_ACCESS_TOKEN','ALLOW_STAGING_MOCKS','AUTH_REQUIRE_EMAIL_VERIFICATION','AUTH_PHONE_MODE','TRUSTED_PROXY_IPS','BACKUP_KEY_FILE','AUTH_KEY_REF'])delete env[key];
 child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('isolated startup timeout')),15000);child.stdout.on('data',b=>{if(String(b).includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('isolated startup exited '+code));});child.once('error',reject);});
 const login=email=>fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(10000)});
 const sessions=await Promise.all(users.map(async user=>{const response=await login(user.email);assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);assert.equal((await response.json()).user.id,user.id);return {user,cookie};}));
 for(let round=0;round<20;round++)await Promise.all(sessions.map(async({user,cookie})=>{const response=await fetch(base+'/api/me',{headers:{Cookie:cookie},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);assert.equal((await response.json()).user.id,user.id);}));
 for(let i=0;i<2;i++){const response=await login(users[i].email);assert.equal(response.status,200);await response.arrayBuffer();}
 const limited=await login(users[0].email);assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('x-retry-after'))>0);
 const feedback=rateLimitError(limited);assert.ok(feedback.retryAfter>0);assert.match(feedback.message,/等待约\d+秒/);
 const valid=await fetch(base+'/api/me',{headers:{Cookie:sessions[0].cookie}});assert.equal(valid.status,200);assert.equal((await valid.json()).user.id,users[0].id);
});


