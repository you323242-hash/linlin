import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';
import { verifyPassword } from 'better-auth/crypto';
import { randomBytes } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createEncryptedSnapshot, restoreEncryptedSnapshot } from '../scripts/secure-backup.mjs';

test('账户安全真实HTTP：会话、密码、二次验证、恢复码与管理员权限', async t => {
  const parent = realpathSync(tmpdir()), directory = mkdtempSync(path.join(parent, 'delta-security-'));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child, db, main, other, extra, secret, codes;
  const password = 'Security-test-original-2026!', changed = 'Security-test-changed-2026!';
  const cookieMerge = (cookie, values) => {
    const jar = new Map(cookie.split(';').filter(Boolean).map(part => { const i = part.indexOf('='); return [part.slice(0, i).trim(), part.slice(i + 1).trim()]; }));
    for (const value of values) { const part = value.split(';')[0], i = part.indexOf('='); if (i > 0) { if (part.slice(i + 1)) jar.set(part.slice(0, i), part.slice(i + 1)); else jar.delete(part.slice(0, i)); } }
    return [...jar].map(([k, v]) => k + '=' + v).join('; ');
  };
  async function start() {
    child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../server/index.mjs')], { env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', PORT: String(port), BETTER_AUTH_URL: base, AUTH_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let errors = ''; child.stderr.on('data', chunk => errors += chunk);
      const timer = setTimeout(() => reject(Error('账户安全测试启动超时')), 20000);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('已启动')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error('启动失败 ' + code + ': ' + errors)); });
    });
    db = new DatabaseSync(path.join(directory, 'auth.sqlite'));
  }
  async function stop() { db?.close(); db = null; if (child?.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); }
  async function req(route, actor, body, origin = base) {
    const response = await fetch(base + route, { redirect: 'manual', method: body ? 'POST' : 'GET', headers: { ...(actor?.cookie ? { Cookie: actor.cookie } : {}), ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => null);
    if (actor) actor.cookie = cookieMerge(actor.cookie || '', response.headers.getSetCookie());
    return { status: response.status, data, response, cookie: cookieMerge('', response.headers.getSetCookie()) };
  }
  const login = async (email, pwd = changed) => { const result = await req('/api/auth/sign-in/email', null, { email, password: pwd, rememberMe: true }); return { ...result, email }; };
  const code = () => createOTP(secret).totp();
  const check = (name, run) => t.test(name, async () => { db.exec('DELETE FROM "rateLimit"'); await run(); });
  try {
    await start();
    for (const email of ['security@example.test', 'other@example.test']) {
      const result = await req('/api/auth/sign-up/email', null, { email, password, name: '安全验收账户', termsAccepted: true });
      assert.equal(result.status, 200); const actor = { email, cookie: result.cookie, id: result.data.user.id };
      if (!main) main = actor; else other = actor;
    }
    extra = await login(main.email, password);
    await check('只显示本人会话，不公开令牌/IP/其他用户；来源及原生绕过受限', async () => {
      const data = (await req('/api/security', main)).data;
      assert.equal(data.sessions.length, 2); assert.equal(data.sessions.filter(s => s.current).length, 1);
      assert.ok(!JSON.stringify(data).includes('token')); assert.ok(!JSON.stringify(data).includes(other.id));
      assert.equal((await req('/api/security')).status, 401);
      assert.equal((await req('/api/security/revoke-others', main, {}, 'https://evil.example')).status, 403);
      assert.equal((await req('/api/auth/change-password', main, { currentPassword: password, newPassword: changed })).status, 404);
      assert.equal((await req('/api/auth/two-factor/enable', main, { password })).status, 404);
      const redirect = await req('/admin.html'); assert.equal(redirect.status, 303); assert.match(redirect.response.headers.get('location'), /returnTo=%2Fadmin.html/);
    });
    await check('撤销其他会话立即失效，不允许撤销他人或当前会话', async () => {
      const sessions = (await req('/api/security', main)).data.sessions;
      const otherSession = (await req('/api/security', other)).data.sessions[0];
      assert.equal((await req('/api/security/revoke', main, { id: otherSession.id })).status, 404);
      assert.equal((await req('/api/security/revoke', main, { id: sessions.find(s => s.current).id })).status, 409);
      assert.equal((await req('/api/security/revoke', main, { id: sessions.find(s => !s.current).id })).status, 200);
      assert.equal((await req('/api/me', extra)).status, 401); assert.equal((await req('/api/me', main)).status, 200);
      assert.equal((await req('/api/me', other)).status, 200);
      extra = await login(main.email, password);
    });
    await check('错误密码或短密码不修改；正确修改撤销原会话且保留成熟哈希', async () => {
      assert.equal((await req('/api/security/password', main, { currentPassword: 'wrong-original-password', newPassword: changed })).status, 400);
      assert.equal((await req('/api/security/password', main, { currentPassword: password, newPassword: 'short' })).status, 400);
      const old = { cookie: main.cookie };
      assert.equal((await req('/api/security/password', main, { currentPassword: password, newPassword: changed, revokeOtherSessions: false })).status, 200);
      assert.equal((await req('/api/me', old)).status, 401); assert.equal((await req('/api/me', extra)).status, 401);
      assert.equal((await req('/api/me', main)).status, 200); assert.equal((await login(main.email, password)).status, 401);
      const hash = db.prepare('SELECT password FROM account WHERE userId=?').get(main.id).password;
      assert.notEqual(hash, changed); assert.equal(await verifyPassword({ hash, password: changed }), true);
      extra = await login(main.email);
    });
    await check('二次验证须验证才启用；密钥/恢复码加密，启用撤销其他会话', async () => {
      const setup = await req('/api/security/enroll', main, { password: changed }); assert.equal(setup.status, 200);
      secret = new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI).searchParams.get('secret'))); codes = setup.data.backupCodes;
      assert.equal((await req('/api/security', main)).data.twoFactorEnabled, false);
      assert.equal((await req('/api/security/verify', main, { code: 'badcode' })).status, 401);
      const before = { cookie: main.cookie };
      const result = await req('/api/security/verify', main, { code: await code(), trustDevice: true }); assert.equal(result.status, 200);
      assert.equal(result.data.token, undefined); assert.ok(!result.response.headers.getSetCookie().some(c => c.includes('trust_device')));
      assert.equal((await req('/api/security', main)).data.twoFactorEnabled, true);
      assert.equal((await req('/api/me', before)).status, 401); assert.equal((await req('/api/me', extra)).status, 401);
      const record = db.prepare('SELECT secret,backupCodes FROM twoFactor WHERE userId=?').get(main.id);
      assert.notEqual(record.secret, secret); assert.ok(!record.backupCodes.includes(codes[0]));
    });
    await check('启用后二次验证前没有登录会话；验证后恢复同一用户', async () => {
      assert.equal((await req('/api/auth/sign-out', main, {})).status, 200);
      main.cookie = (await login(main.email)).cookie;
      assert.equal((await req('/api/me', main)).status, 401);
      assert.equal((await req('/api/security/verify', main, { code: await code() })).status, 200);
      assert.equal((await req('/api/me', main)).data.user.id, main.id);
      await stop(); await start();
      assert.equal((await req('/api/security', main)).data.twoFactorEnabled, true);
      assert.equal((await req('/api/me', main)).data.user.id, main.id);
    });
    await check('加密备份恢复保留验证密钥、原会话与二次验证记录', async () => {
      const previous = db.prepare('SELECT secret,backupCodes FROM twoFactor WHERE userId=?').get(main.id);
      await stop(); let restored;
      try {
        const key = randomBytes(32), snapshot = path.join(directory, 'security-snapshot'), target = path.join(directory, 'security-restored');
        await createEncryptedSnapshot(directory, snapshot, key); await restoreEncryptedSnapshot(snapshot, target, key);
        restored = await createAuth({ baseURL: base, dataDirectory: target, environment: 'test' });
        assert.deepEqual(restored.database.prepare('SELECT secret,backupCodes FROM twoFactor WHERE userId=?').get(main.id), previous);
        const session = await restored.auth.api.getSession({ headers: new Headers({ cookie: main.cookie }) });
        assert.equal(session.user.id, main.id); assert.equal(session.user.twoFactorEnabled, true);
        assert.equal(restored.database.prepare('SELECT COUNT(*) n FROM security_proofs WHERE session_id=?').get(session.session.id).n, 1);
        const verified = await restored.auth.api.verifyTOTP({ headers: new Headers({ cookie: main.cookie }), body: { code: await code() } }); assert.equal(verified.user.id, main.id);
      } finally { restored?.database.close(); await start(); }
    });
    await check('单次恢复码可完成登录，重复使用拒绝且没有会话', async () => {
      const recovery = await login(main.email); assert.equal(recovery.data.twoFactorRedirect, true);
      assert.equal((await req('/api/security/verify', recovery, { code: codes[0], method: 'backup' })).status, 200);
      assert.equal((await req('/api/me', recovery)).data.user.id, main.id);
      const replay = await login(main.email);
      assert.equal((await req('/api/security/verify', replay, { code: codes[0], method: 'backup' })).status, 401);
      assert.equal((await req('/api/me', replay)).status, 401);
    });
    await check('管理员不可关闭二次验证；过期验证不能绕过售后/附件/API/页面', async () => {
      const opinion=await req('/api/site-feedback',other,{category:'bug',content:'合成管理员验证意见',requestId:'security-opinion-1'});
      assert.equal(opinion.status,200);
      const opinionId=opinion.data.feedback.id;
      db.prepare("UPDATE user SET role='admin' WHERE id=?").run(main.id);
      assert.equal((await req('/api/admin', main)).status, 200);
      assert.equal((await req('/api/site-feedback/admin',main)).status,200);
      assert.equal((await req('/api/security/disable', main, { password: changed })).status, 403);
      db.prepare('UPDATE security_proofs SET verified_at=? WHERE user_id=?').run(Date.now() - 16 * 60_000, main.id);
      for (const route of ['/api/admin', '/api/team-admin', '/api/orders', '/api/attachments/fake','/api/site-feedback/admin']) assert.equal((await req(route, main)).status, 428, route);
      const decision={status:'resolved',reason:'近期二次验证后处理意见',version:1};
      assert.equal((await req('/api/site-feedback/'+opinionId+'/handle',main,decision)).status,428);
      assert.equal(db.prepare('SELECT version FROM site_feedback WHERE id=?').get(opinionId).version,1);
      assert.equal((await req('/api/orders/DF00000000000000000000/actions/proposeCase', main, { outcome: 'refund' })).status, 428);
      const page = await req('/admin.html', main); assert.equal(page.status, 303); assert.match(page.response.headers.get('location'), /security=1/);
      assert.equal((await req('/api/security/verify', main, { code: await code() })).status, 200);
      assert.equal((await req('/api/admin', main)).status, 200);
      assert.equal((await req('/api/site-feedback/'+opinionId+'/handle',main,decision)).status,200);
      assert.equal((await req('/api/site-feedback',other)).data.feedback[0].status,'resolved');
      assert.equal((await req('/api/security/password', main, { currentPassword: changed, newPassword: password })).status, 200);
      assert.equal((await req('/api/admin', main)).status, 428);
      assert.equal((await req('/api/site-feedback/admin',main)).status,428);
    });
    await check('验证限流不能通过客户端字段跳过；审计没有密码/密钥/恢复码', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await req('/api/security/verify', other, { code: '123456' })).status, 400);
      assert.equal((await req('/api/security/verify', other, { code: '123456', trustDevice: true })).status, 429);
      const audit = JSON.stringify(db.prepare("SELECT * FROM audit_events WHERE action LIKE 'security_%'").all());
      assert.ok(audit.includes('security_password_changed')); assert.ok(audit.includes('security_session_revoked'));
      for (const value of [password, changed, secret, codes[0]]) assert.ok(!audit.includes(value));
      const logs = readdirSync(path.join(directory, 'logs')).map(file => readFileSync(path.join(directory, 'logs', file), 'utf8')).join('');
      for (const value of [password, changed, secret, codes[0]]) assert.ok(!logs.includes(value));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    });
    await check('普通用户重生成恢复码和关闭验证均需近期验证，其他会话立即退出', async () => {
      const created = await req('/api/auth/sign-up/email', null, { email: 'optional-mfa@example.test', password, name: '可选验证验收', termsAccepted: true });
      assert.equal(created.status, 200); const actor = { cookie: created.cookie, id: created.data.user.id };
      const second = await login('optional-mfa@example.test', password);
      assert.equal((await req('/api/security/revoke-others', actor, {})).status, 200); assert.equal((await req('/api/me', second)).status, 401);
      const setup = await req('/api/security/enroll', actor, { password }); assert.equal(setup.status, 200);
      const optionalSecret = new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI).searchParams.get('secret')));
      assert.equal((await req('/api/security/verify', actor, { code: await createOTP(optionalSecret).totp() })).status, 200);
      db.prepare('DELETE FROM security_proofs WHERE user_id=?').run(actor.id);
      assert.equal((await req('/api/security/disable', actor, { password })).status, 428);
      assert.equal((await req('/api/security/backup-codes', actor, { password })).status, 428);
      assert.equal((await req('/api/security/verify', actor, { code: await createOTP(optionalSecret).totp() })).status, 200);
      const regenerated = await req('/api/security/backup-codes', actor, { password }); assert.equal(regenerated.status, 200);
      const pending = await login('optional-mfa@example.test', password);
      assert.equal((await req('/api/security/verify', pending, { code: setup.data.backupCodes[0], method: 'backup' })).status, 401);
      assert.equal((await req('/api/security/verify', pending, { code: regenerated.data.backupCodes[0], method: 'backup' })).status, 200);
      assert.equal((await req('/api/security/disable', actor, { password })).status, 200);
      assert.equal((await req('/api/me', pending)).status, 401); assert.equal((await req('/api/me', actor)).status, 200);
      const ordinary = await login('optional-mfa@example.test', password); assert.equal(ordinary.status, 200); assert.equal(ordinary.data.twoFactorRedirect, undefined);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM twoFactor WHERE userId=?').get(actor.id).n, 0);
    });
  } finally { await stop(); const resolved = realpathSync(directory); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('delta-security-')); rmSync(resolved, { recursive: true }); }
});
