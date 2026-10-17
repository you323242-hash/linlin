import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

test('手机号私有Mock认证真实HTTP、身份绑定与重启', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-phone-'));
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r));
  const base = `http://127.0.0.1:${port}`; let child, db;
  const start = async (mode = 'mock') => {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', AUTH_PHONE_MODE: mode, AUTH_DATA_DIR: directory, PORT: String(port), BETTER_AUTH_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; child.stderr.on('data', x => logs += x);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('phone server timeout '+logs)), 15000); child.stdout.on('data', x => { if (x.toString().includes('已启动')) { clearTimeout(timer); resolve(); } }); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); }); });
    db = new DatabaseSync(path.join(directory, 'auth.sqlite'));
  };
  const stop = async () => { db?.close(); db = null; if (child?.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill(); }); };
  const req = async (route, body, cookie = '', origin = base) => {
    const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json(), cookie: r.headers.getSetCookie().map(x => x.split(';')[0]).join('; '), headers: r.headers };
  };
  const send = phoneNumber => req('/api/auth/phone-number/send-otp', { phoneNumber });
  const code = phone => readdirSync(path.join(directory, 'phone-outbox')).map(f => JSON.parse(readFileSync(path.join(directory, 'phone-outbox', f)))).filter(x => x.phoneNumber === phone).sort((a,b) => a.expiresAt-b.expiresAt).at(-1).code;
  const verify = (phoneNumber, otp, cookie = '', extra = {}) => req('/api/auth/phone-number/verify', { phoneNumber, code: otp, termsAccepted: true, ...extra }, cookie);
  const check = (name, fn) => t.test(name, async () => { db.exec('DELETE FROM runtime_limits; DELETE FROM "rateLimit";'); await fn(); });
  let first, cookie, bound, original, anotherCookie;
  try {
    await start('disabled');
    await check('旧库启用前备份，既有身份和会话保持', async () => {
      const old = await req('/api/auth/sign-up/email', { email: 'legacy@example.test', name: '旧用户', password: 'Test-phone-123456!', termsAccepted: true }); assert.equal(old.status, 200);
      await stop(); await start();
      assert.ok(readdirSync(path.join(directory, 'backups')).some(x => x.startsWith('before-migration-')));
      assert.equal((await req('/api/me', null, old.cookie)).data.user.id, old.data.user.id);
      assert.equal(db.prepare('SELECT phoneNumber FROM user WHERE id=?').get(old.data.user.id).phoneNumber, null);
    });
    await check('开启状态明确为模拟；号码/跨站/保留邮箱拒绝', async () => {
      const view = (await req('/api/integrations')).data; assert.equal(view.login.phone.mode, 'private-mock-inbox'); assert.equal(view.login.phone.realOwnershipVerified, false);
      assert.equal((await send('123')).status, 400);
      assert.equal((await req('/api/auth/phone-number/send-otp', { phoneNumber: '+8619900001000' }, '', 'https://evil.example')).status, 403);
      assert.equal((await req('/api/auth/sign-up/email', { name: 'test', email: 'reserved@phone.example.invalid', password: 'Test-phone-123456!', termsAccepted: true })).status, 400);
    });
    await check('获取验证码无公开代码/Token；重发冷却持久化', async () => {
      const r = await send('+8619900001001'); assert.equal(r.status, 200); assert.equal(r.data.simulated, true); assert.equal(r.data.delivered, false); assert.equal(r.data.code, undefined);
      assert.match(code('+8619900001001'), /^\d{6}$/); assert.equal((await send('+8619900001001')).status, 429);
      await stop(); await start(); assert.equal((await send('+8619900001001')).status, 429);
    });
    await check('同意协议前不创建账户，成功注册仅一个基础身份并脱敏', async () => {
      assert.equal((await verify('+8619900001001', code('+8619900001001'), '', { termsAccepted: false })).status, 400);
      first = await verify('+8619900001001', code('+8619900001001')); assert.equal(first.status, 200); cookie = first.cookie;
      assert.equal(first.data.token, undefined); assert.equal(first.data.user.phoneNumber, undefined); assert.equal(first.data.user.phoneVerification, 'mock');
      assert.equal(db.prepare('SELECT count(*) n FROM user WHERE phoneNumber=?').get('+8619900001001').n, 1);
      assert.equal((await req('/api/me', null, cookie)).data.user.id, first.data.user.id);
      assert.equal((await req('/api/security', null, cookie)).data.emailRecoveryEligible, false);
      assert.equal((await verify('+8619900001001', code('+8619900001001'))).status, 400);
    });
    await check('内部手机号邮箱不签发邮件恢复或验证凭据', async () => {
      const email = db.prepare('SELECT email FROM user WHERE id=?').get(first.data.user.id).email;
      const beforeMail = readdirSync(path.join(directory, 'email-outbox')).length;
      const beforeReset = db.prepare("SELECT count(*) n FROM verification WHERE identifier LIKE 'reset-password:%'").get().n;
      for (const route of ['request-password-reset', 'send-verification-email']) {
        assert.equal((await req('/api/auth/' + route, { email })).status, 400);
        assert.equal((await req('/api/auth/' + route, { email: email.toUpperCase() })).status, 400);
      }
      assert.equal(readdirSync(path.join(directory, 'email-outbox')).length, beforeMail);
      assert.equal(db.prepare("SELECT count(*) n FROM verification WHERE identifier LIKE 'reset-password:%'").get().n, beforeReset);
    });
    await check('历史手机号占位邮箱重置令牌不能创建密码或撤销会话', async () => {
      const token = 'synthetic-legacy-phone-reset', now = Date.now();
      db.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('synthetic-legacy-reset-row', 'reset-password:' + token, first.data.user.id, now + 60000, now, now);
      const before = db.prepare('SELECT password FROM account WHERE userId=? AND providerId=?').get(first.data.user.id, 'credential');
      assert.equal((await req('/api/auth/reset-password', { token, newPassword: 'Unexpected-reset-2026!' })).status, 400);
      assert.equal((await req('/api/auth/reset-password?token=' + token, { newPassword: 'Unexpected-reset-2026!' })).status, 400);
      assert.deepEqual(db.prepare('SELECT password FROM account WHERE userId=? AND providerId=?').get(first.data.user.id, 'credential'), before);
      assert.equal((await req('/api/me', null, cookie)).data.user.id, first.data.user.id);
    });
    await check('验证码过期不能登录', async () => {
      await send('+8619900001002'); db.prepare('UPDATE verification SET expiresAt=? WHERE identifier=?').run(Date.now()-1000, '+8619900001002');
      assert.equal((await verify('+8619900001002', code('+8619900001002'))).status, 400);
    });
    await check('三次错误后正确验证码也被拒绝', async () => {
      await send('+8619900001003'); const otp = code('+8619900001003'), wrong = otp === '000000' ? '111111' : '000000';
      for (let i = 0; i < 3; i++) assert.equal((await verify('+8619900001003', wrong)).status, 400);
      assert.equal((await verify('+8619900001003', otp)).status, 403);
    });
    await check('并发正确验证码只能创建一个会话', async () => {
      await send('+8619900001004'); const results = await Promise.all([verify('+8619900001004', code('+8619900001004')), verify('+8619900001004', code('+8619900001004'))]);
      assert.equal(results.filter(x => x.status === 200).length, 1);
      const id = results.find(x => x.status === 200).data.user.id; assert.equal(db.prepare('SELECT count(*) n FROM session WHERE userId=?').get(id).n, 1);
    });
    await check('同一账户并发绑定不同手机号只能成功一次，不覆盖已绑定身份', async () => {
      const account = await req('/api/auth/sign-up/email', { email: 'race-bind@example.test', name: '并发绑定用户', password: 'Test-phone-123456!', termsAccepted: true });
      assert.equal(account.status, 200);
      const phones = ['+8619900001010', '+8619900001011'];
      for (const phone of phones) assert.equal((await send(phone)).status, 200);
      const results = await Promise.all(phones.map(phone => verify(phone, code(phone), account.cookie, { updatePhoneNumber: true, password: 'Test-phone-123456!' })));
      assert.equal(results.filter(result => result.status === 200).length, 1, '一个账户的并发绑定不能两次成功');
      assert.ok(results.some(result => [403, 409].includes(result.status)));
      const winner = results.findIndex(result => result.status === 200), loser = 1 - winner;
      assert.equal(db.prepare('SELECT phoneNumber FROM user WHERE id=?').get(account.data.user.id).phoneNumber, phones[winner]);
      assert.equal((await verify(phones[loser], code(phones[loser]), account.cookie, { updatePhoneNumber: true, password: 'Test-phone-123456!' })).status, 403);
      assert.equal(db.prepare('SELECT phoneNumber FROM user WHERE id=?').get(account.data.user.id).phoneNumber, phones[winner]);
      assert.equal(db.prepare('SELECT count(*) n FROM user WHERE phoneNumber=?').get(phones[loser]).n, 0);
    });
    await check('绑定要求已有会话和原密码，不创建第二用户', async () => {
      original = await req('/api/auth/sign-up/email', { email: 'bind@example.test', name: '绑定用户', password: 'Test-phone-123456!', termsAccepted: true }); assert.equal(original.status, 200);
      await send('+8619900001005'); const otp = code('+8619900001005');
      assert.equal((await verify('+8619900001005', otp, '', { updatePhoneNumber: true, password: 'Test-phone-123456!' })).status, 401);
      assert.equal((await verify('+8619900001005', otp, original.cookie, { updatePhoneNumber: true, password: 'wrong-password' })).status, 403);
      bound = await verify('+8619900001005', otp, original.cookie, { updatePhoneNumber: true, password: 'Test-phone-123456!' }); assert.equal(bound.status, 200); assert.equal(bound.data.user.id, original.data.user.id);
      assert.equal(db.prepare('SELECT id FROM user WHERE phoneNumber=?').get('+8619900001005').id, original.data.user.id);
      assert.equal((await req('/api/security', null, original.cookie)).data.emailRecoveryEligible, true);
    });
    await check('绑定号码冲突拒绝，不覆盖原手机号或自动合并', async () => {
      const other = await req('/api/auth/sign-up/email', { email: 'other@example.test', name: '另一用户', password: 'Test-phone-123456!', termsAccepted: true });
      await send('+8619900001005'); assert.equal((await verify('+8619900001005', code('+8619900001005'), other.cookie, { updatePhoneNumber: true, password: 'Test-phone-123456!' })).status, 409);
    });
    await check('绑定账户手机号登录身份相同，重复登录不重复注册', async () => {
      const login = await verify('+8619900001005', code('+8619900001005')); assert.equal(login.status, 200); assert.equal(login.data.user.id, original.data.user.id);
    });
    await check('模拟OTP不能绕过管理员或用户二次验证', async () => {
      db.prepare('UPDATE user SET twoFactorEnabled=1 WHERE id=?').run(original.data.user.id);
      await send('+8619900001005'); assert.equal((await verify('+8619900001005', code('+8619900001005'))).status, 403);
      db.prepare("UPDATE user SET twoFactorEnabled=0,role='admin' WHERE id=?").run(original.data.user.id);
      assert.equal((await verify('+8619900001005', code('+8619900001005'))).status, 403);
      assert.equal((await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001005',password:'Test-phone-123456!'})).status,401);
      db.prepare("UPDATE user SET role='user' WHERE id=?").run(original.data.user.id);
    });
    await check('首次设密码必须登录、本站来源、近期验证码证明与足够长度',async()=>{
      await send('+8619900001001');anotherCookie=(await verify('+8619900001001',code('+8619900001001'))).cookie;
      assert.equal((await req('/api/auth/phone-number/set-password',{newPassword:'Phone-password-12345!'})).status,401);
      assert.equal((await req('/api/auth/phone-number/set-password',{newPassword:'Phone-password-12345!'},cookie,'https://evil.example')).status,403);
      assert.equal((await req('/api/auth/phone-number/set-password',{newPassword:'short'},cookie)).status,400);
      const sessionId=db.prepare('SELECT id FROM session WHERE userId=? ORDER BY createdAt LIMIT 1').get(first.data.user.id).id;
      const proof=db.prepare('SELECT * FROM verification WHERE identifier=?').get('phone-password:'+sessionId);assert.ok(proof);
      db.prepare('UPDATE verification SET expiresAt=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),proof.id);
      assert.equal((await req('/api/auth/phone-number/set-password',{newPassword:'Phone-password-12345!'},cookie)).status,403);
      db.prepare('UPDATE verification SET expiresAt=? WHERE id=?').run(new Date(Date.now()+300000).toISOString(),proof.id);
    });
    await check('并发设置仅成功一次，库内成熟哈希且不返回密码',async()=>{
      const outcomes=await Promise.all([req('/api/auth/phone-number/set-password',{newPassword:'Phone-password-12345!',userId:original.data.user.id},cookie),req('/api/auth/phone-number/set-password',{newPassword:'Phone-password-12345!'},cookie)]);
      assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
      const rows=db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").all(first.data.user.id);assert.equal(rows.length,1);assert.notEqual(rows[0].password,'Phone-password-12345!');assert.ok(rows[0].password.length>100);
      assert.ok(!JSON.stringify(outcomes.map(x=>x.data)).includes(rows[0].password));
      assert.equal((await req('/api/me',null,cookie)).data.user.phonePasswordSet,true);
      assert.equal((await req('/api/me',null,anotherCookie)).status,401);
      assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE actor_id=? AND action='phone_password_set'").get(first.data.user.id).n,1);
    });
    await check('历史邮箱令牌也不能覆盖已有手机号密码', async () => {
      const before = db.prepare('SELECT password FROM account WHERE userId=? AND providerId=?').get(first.data.user.id, 'credential');
      assert.ok(before.password);
      assert.equal((await req('/api/auth/reset-password', { token: 'synthetic-legacy-phone-reset', newPassword: 'Unexpected-reset-2026!' })).status, 400);
      assert.deepEqual(db.prepare('SELECT password FROM account WHERE userId=? AND providerId=?').get(first.data.user.id, 'credential'), before);
      assert.equal((await req('/api/me', null, cookie)).data.user.id, first.data.user.id);
    });
    await check('正确手机号密码登录身份不变，错误/未知号码拒绝且无需生成OTP',async()=>{
      const before=readdirSync(path.join(directory,'phone-outbox')).length;
      assert.equal((await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001001',password:'Wrong-password-12345!'})).status,401);
      assert.equal((await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001999',password:'Wrong-password-12345!'})).status,401);
      const login=await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001001',password:'Phone-password-12345!',rememberMe:false});assert.equal(login.status,200);assert.equal(login.data.user.id,first.data.user.id);assert.equal(login.data.token,undefined);
      assert.ok(login.headers.getSetCookie().some(x=>x.includes('session_token')&&!/Max-Age=|Expires=/i.test(x)));
      assert.equal(readdirSync(path.join(directory,'phone-outbox')).length,before);
      assert.equal((await req('/api/auth/phone-number/set-password',{newPassword:'Replacement-123456!'},login.cookie)).status,403);
      await req('/api/auth/sign-out',{},login.cookie);assert.equal((await req('/api/me',null,login.cookie)).status,401);
    });
    await check('绑定原账户密码直接可用，不允许首次设置接口覆盖',async()=>{
      const login=await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001005',password:'Test-phone-123456!'});assert.equal(login.status,200);assert.equal(login.data.user.id,original.data.user.id);
      assert.equal((await req('/api/auth/phone-number/set-password',{newPassword:'Replacement-123456!'},login.cookie)).status,403);
    });
    await check('手机号密码失败限流在重启后保持',async()=>{
      for(let i=0;i<10;i++)assert.equal((await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001888',password:'Wrong-password-12345!'})).status,401);
      await stop();await start();assert.equal((await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001888',password:'Wrong-password-12345!'})).status,429);
    });
    await check('重启仍识别同一账户；退出后Cookie失效', async () => {
      await stop(); await start(); assert.equal((await req('/api/me', null, cookie)).data.user.id, first.data.user.id);
      assert.equal((await req('/api/auth/sign-out', {}, cookie)).status, 200); assert.equal((await req('/api/me', null, cookie)).status, 401);
    });
    await check('关闭手机号开关仍保留账密账户与数据；手机号接口拒绝', async () => {
      await stop(); await start('disabled'); assert.equal((await send('+8619900001006')).status, 404);
      assert.equal((await req('/api/auth/sign-in/phone-number',{phoneNumber:'+8619900001001',password:'Phone-password-12345!'})).status,404);
      assert.equal((await req('/api/auth/phone-number/set-password',{newPassword:'Replacement-123456!'},cookie)).status,404);
      assert.equal((await req('/api/auth/sign-in/email', { email: 'bind@example.test', password: 'Test-phone-123456!' })).status, 200);
      assert.equal(db.prepare('SELECT id FROM user WHERE phoneNumber=?').get('+8619900001005').id, original.data.user.id);
      assert.equal((await req('/api/security', null, original.cookie)).data.emailRecoveryEligible, true);
    });
  } finally { await stop(); rmSync(directory, { recursive: true, force: true }); }
});
