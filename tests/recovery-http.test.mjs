import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';

test('账户归属与找回真实HTTP闭环（私有Mock邮件，不证明真实邮箱归属）',async t=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(path.join(parent,'delta-recovery-'));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const base=`http://127.0.0.1:${port}`, email='recovery@example.test',password='Recovery-original-2026!',next='Recovery-changed-2026!';
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:dir,PORT:String(port),BETTER_AUTH_URL:base,AUTH_REQUIRE_EMAIL_VERIFICATION:'true'},stdio:['ignore','pipe','pipe']});
  let db,logs='';child.stderr.on('data',c=>logs+=c);
  t.after(async()=>{db?.close();if(child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});const target=realpathSync(dir);assert.equal(path.dirname(target),parent);rmSync(target,{recursive:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),20000);child.stdout.on('data',c=>{if(c.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败'+code));});});
  db=new DatabaseSync(path.join(dir,'auth.sqlite'));
  const req=async(route,body,cookie='',origin=base)=>{const r=await fetch(base+route,{redirect:'manual',method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json().catch(()=>null),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};};
  const auth=(route,body,cookie,origin)=>req('/api/auth/'+route,body,cookie,origin);
  const latest=purpose=>readdirSync(path.join(dir,'email-outbox')).map(name=>JSON.parse(readFileSync(path.join(dir,'email-outbox',name),'utf8'))).filter(row=>row.recipient===email&&row.purpose===purpose).sort((a,b)=>b.createdAt-a.createdAt)[0];
  const clear=()=>db.exec('DELETE FROM "rateLimit"; DELETE FROM runtime_limits');
  let cookie, token, id;
  await t.test('严格模式注册无会话；未验证不能登录；重复注册不泄露存在性',async()=>{
    const r=await auth('sign-up/email',{name:'找回验收',email,password,termsAccepted:true});assert.equal(r.status,200);assert.equal(r.cookie,'');assert.equal(r.data.verificationRequired,true);id=db.prepare('SELECT id FROM user WHERE email=?').get(email).id;
    assert.equal((await auth('sign-in/email',{email,password})).status,403);
    const duplicate=await auth('sign-up/email',{name:'重复验收',email,password,termsAccepted:true});assert.equal(duplicate.status,200);assert.equal(duplicate.cookie,'');assert.equal(db.prepare('SELECT count(*) n FROM user').get().n,1);
  });
  await t.test('验证令牌不返回公开API；私有邮件不能HTTP读取；真实验证接口写库',async()=>{
    clear();const mail=latest('verify');assert.ok(mail.simulated&&!mail.delivered);const value=new URLSearchParams(new URL(mail.url).hash.slice(1)).get('verify');
    assert.equal((await req('/email-outbox/'+mail.id+'.json')).status,404);assert.equal((await req('/.local/email-outbox/'+mail.id+'.json')).status,404);
    assert.notEqual((await auth('verify-email?token=altered')).status,200);
    const verified=await auth('verify-email?token='+encodeURIComponent(value));assert.equal(verified.status,200);assert.equal(verified.cookie,'');assert.ok(!JSON.stringify(verified.data).includes(value));assert.equal(db.prepare('SELECT emailVerified FROM user WHERE id=?').get(id).emailVerified,1);
    const login=await auth('sign-in/email',{email,password});assert.equal(login.status,200);cookie=login.cookie;
  });
  await t.test('找回返回通用响应，重定向/CSRF受限，令牌仅留私有收件箱',async()=>{
    clear();const found=await auth('request-password-reset',{email});const missing=await auth('request-password-reset',{email:'absent@example.test'});assert.equal(found.status,200);assert.deepEqual(found.data,missing.data);
    assert.equal((await auth('request-password-reset',{email},'', 'https://evil.example')).status,403);
    assert.equal((await auth('request-password-reset',{email,redirectTo:'https://evil.example'})).status,403);
    assert.equal((await req('/api/auth/verify-email?token=invalid&callbackURL=https%3A%2F%2Fevil.example')).status,403);
    assert.equal((await req('/api/auth/verify-email?token=invalid&callbackURL=%2F&callbackURL=https%3A%2F%2Fevil.example')).status,403);
    assert.equal((await req('/api/auth/verify-email?token=invalid&callbackURL=%2F')).status,400);
    assert.equal((await req('/%00')).status,400);
    token=new URLSearchParams(new URL(latest('reset').url).hash.slice(1)).get('reset');assert.ok(!JSON.stringify(found.data).includes(token));assert.ok(!logs.includes(token));
  });
  await t.test('错误/过期/短密码不重置；单次令牌重置撤销旧会话，旧密码失效',async()=>{
    clear();assert.equal((await auth('reset-password',{token:'bad',newPassword:next})).status,400);
    assert.equal((await auth('reset-password',{token,newPassword:'short'})).status,400);
    const expired=await auth('request-password-reset',{email});assert.equal(expired.status,200);const expiredToken=new URLSearchParams(new URL(latest('reset').url).hash.slice(1)).get('reset');
    db.prepare('UPDATE verification SET expiresAt=? WHERE identifier=?').run(Date.now()-1000,'reset-password:'+expiredToken);
    assert.equal((await auth('reset-password',{token:expiredToken,newPassword:next})).status,400);
    assert.equal((await auth('reset-password',{token,newPassword:next})).status,200);
    assert.equal((await req('/api/me',null,cookie)).status,401);
    assert.equal((await auth('sign-in/email',{email,password})).status,401);assert.equal((await auth('sign-in/email',{email,password:next})).status,200);
    assert.equal((await auth('reset-password',{token,newPassword:password})).status,400);
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='password_reset' AND actor_id=?").get(id));
  });
  await t.test('找回限频且伪造IP不能绕过；恢复页不嵌令牌；admin不是订单作用域',async()=>{
    clear();for(let i=0;i<3;i++)assert.equal((await auth('request-password-reset',{email})).status,200);assert.equal((await auth('request-password-reset',{email})).status,429);
    const r=await fetch(base+'/recovery.html');assert.equal(r.status,200);assert.ok(!(await r.text()).includes(token));
    const user=await auth('sign-in/email',{email,password:next});
    for(const reserved of ['admin','profile','create','DFbad'])assert.equal((await req('/api/orders/'+reserved+'/actions/product',{price:1,requestId:'fake-request'},user.cookie)).status,404);
    assert.equal((await req('/api/admin/product',{price:1,requestId:'fake-request'},user.cookie)).status,403);
  });
  await t.test('邮箱找回不会关闭二次验证或授予管理员；重置后仍需验证码',async()=>{
    clear();const user=await auth('sign-in/email',{email,password:next});
    const setup=await req('/api/security/enroll',{password:next},user.cookie);assert.equal(setup.status,200);
    const secret=new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI).searchParams.get('secret')));
    const verified=await req('/api/security/verify',{code:await createOTP(secret).totp(),method:'totp'},user.cookie);assert.equal(verified.status,200);
    assert.equal((await auth('request-password-reset',{email})).status,200);
    const reset=new URLSearchParams(new URL(latest('reset').url).hash.slice(1)).get('reset');
    assert.equal((await auth('reset-password',{token:reset,newPassword:password})).status,200);
    const login=await auth('sign-in/email',{email,password});assert.equal(login.status,200);assert.equal(login.data.twoFactorRedirect,true);
    assert.equal((await req('/api/me',null,login.cookie)).status,401);
    assert.equal(db.prepare('SELECT twoFactorEnabled FROM user WHERE id=?').get(id).twoFactorEnabled,1);
    assert.equal(db.prepare('SELECT role FROM user WHERE id=?').get(id).role,'user');
    assert.ok(!logs.includes(secret)&&!logs.includes(reset)&&!logs.includes(password));
  });
});
