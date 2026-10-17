import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { testCertificate } from './tls-fixture.mjs';
import { PROJECT_ROOT } from '../server/config.mjs';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';

test('真实 HTTPS 代理、内测隔离与权限验收', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-https-'));
  const tls = testCertificate(directory);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const token = randomBytes(48).toString('hex');
  const entrance = 'Basic ' + Buffer.from('invited:' + randomBytes(16).toString('hex')).toString('base64');
  let origin, child, database, logs = '';
  // Model the future single-host edge: authenticate EVERY path and overwrite all forwarding hints.
  const proxy = https.createServer(tls, (req, res) => {
    if (req.headers.host !== new URL(origin).host) { res.writeHead(400); return res.end('Invalid host'); }
    if (req.headers.authorization !== entrance) { res.writeHead(401); return res.end('Private test'); }
    const headers = { ...req.headers };
    for (const h of Object.keys(headers)) if (h === 'authorization' || h === 'forwarded' || h.startsWith('x-forwarded-') || h.startsWith('x-delta-') || h === 'x-real-ip') delete headers[h];
    Object.assign(headers, { host: new URL(origin).host, 'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress, 'x-delta-staging-access': token });
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end('Unavailable'); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${proxy.address().port}`;
  const env = { ...process.env, APP_ENV: 'staging', NODE_ENV: 'production', PORT: String(port), BETTER_AUTH_URL: origin, AUTH_DATA_DIR: path.join(directory, 'data'), BETTER_AUTH_SECRET: randomBytes(48).toString('hex'), TRUSTED_PROXY_IPS: '127.0.0.1', STAGING_ACCESS_TOKEN: token, ALLOW_STAGING_MOCKS: 'true', EXTERNAL_SERVICE_MODE: 'local' };
  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => logs += chunk);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('内测启动超时')), 20000);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('已启动')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error('内测退出 ' + code + ': ' + logs)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    database = new DatabaseSync(path.join(env.AUTH_DATA_DIR, 'auth.sqlite'));
  }
  async function stop() {
    database?.close(); database = null;
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
  function request(route, { body, cookie, ip = '127.0.0.1', headers = {}, invited = true, ca = tls.cert } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(origin + route, { ca, servername: 'localhost', localAddress: ip, agent: false, method: body ? 'POST' : 'GET', headers: { ...(invited ? { authorization: entrance } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...headers } }, res => {
        let text = ''; res.on('data', c => text += c); res.on('end', () => {
          let data; try { data = JSON.parse(text); } catch { data = null; }
          resolve({ status: res.statusCode, headers: res.headers, data, text, cookie: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') });
        });
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const signup = email => ({ name: '内测用户', email, password: 'Private-test-password-123!', termsAccepted: true });
  let buyer, other;
  try {
    await start();
    await t.test('TLS证书确实校验，未受邀访问页面/API/注册均拒绝', async () => {
      await assert.rejects(request('/api/health', { ca: '' }));
      for (const route of ['/', '/api/health', '/api/orders', '/api/auth/sign-up/email']) assert.equal((await request(route, { invited: false, ...(route.includes('sign-up') ? { body: signup('outsider@example.test') } : {}) })).status, 401);
      const health = await request('/api/health');
      assert.equal(health.status, 200); assert.equal(health.data.environment, 'staging'); assert.equal(health.data.pid, undefined);
      assert.equal(health.headers['x-delta-environment'], 'staging');
      assert.equal(database.prepare('SELECT COUNT(*) n FROM user').get().n, 0);
      assert.equal((await request('/api/health', { headers: { Host: 'evil.example' } })).status, 400);
    });
    await t.test('直连后端伪造转发头不能绕过内测令牌', async () => {
      const status = await new Promise((resolve, reject) => {
        const direct = http.request({ host: '127.0.0.1', port, path: '/api/auth/sign-up/email', method: 'POST', headers: { Host: new URL(origin).host, 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-Host': new URL(origin).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.1' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        direct.on('error', reject); direct.end(JSON.stringify(signup('outsider@example.test')));
      });
      assert.equal(status, 403); assert.equal(database.prepare('SELECT COUNT(*) n FROM user').get().n, 0);
    });
    await t.test('注册登录使用独立Cookie；HTTPS持久会话带安全属性', async () => {
      buyer = await request('/api/auth/sign-up/email', { body: signup('buyer@example.test') });
      other = await request('/api/auth/sign-up/email', { body: signup('other@example.test') });
      assert.equal(buyer.status, 200); assert.equal(other.status, 200);
      assert.equal(buyer.cookie, ''); assert.equal(other.cookie, '');
      assert.equal((await request('/api/auth/sign-in/email', { body: { email: 'buyer@example.test', password: signup('').password } })).status, 403);
      // Only synthetic fixtures: consume the private Mock emails through the real HTTPS endpoint.
      const outbox = path.join(env.AUTH_DATA_DIR, 'email-outbox');
      for (const email of ['buyer@example.test', 'other@example.test']) {
        const mail = readdirSync(outbox).map(name => JSON.parse(readFileSync(path.join(outbox,name),'utf8'))).find(row => row.recipient === email && row.purpose === 'verify');
        assert.ok(mail?.simulated && !mail.delivered);
        const token = new URLSearchParams(new URL(mail.url).hash.slice(1)).get('verify');
        assert.equal((await request('/api/auth/verify-email?token=' + encodeURIComponent(token))).status, 200);
      }
      other.cookie = (await request('/api/auth/sign-in/email', { body: { email: 'other@example.test', password: signup('').password } })).cookie;
      const login = await request('/api/auth/sign-in/email', { body: { email: 'buyer@example.test', password: signup('').password, rememberMe: true } });
      assert.equal(login.status, 200); buyer.cookie = login.cookie;
      const cookies = login.headers['set-cookie'].join(';');
      for (const pattern of [/__Secure-delta-staging.session_token=/, /HttpOnly/, /Secure/, /SameSite=Lax/, /Max-Age=604800/]) assert.match(cookies, pattern);
      assert.ok(!cookies.includes('Domain='));
      assert.equal((await request('/api/me', { cookie: buyer.cookie })).data.user.id, buyer.data.user.id);
      assert.equal((await request('/api/auth/sign-in/email', { body: { email: 'buyer@example.test', password: 'Incorrect-password-123!' } })).status, 401);
      assert.equal((await request('/api/auth/sign-up/email', { body: signup('buyer@example.test') })).status, 200); // generic duplicate, no enumeration
    });
    await t.test('代理后保持订单隔离、管理员权限、同源限制', async () => {
      assert.equal((await request('/api/orders')).status, 401);
      const created = await request('/api/orders', { cookie: buyer.cookie, body: { mode: 'secret', rulesAccepted: true, requestId: randomUUID() } });
      assert.equal(created.status, 200);
      assert.equal((await request('/api/orders/' + created.data.order.id, { cookie: other.cookie })).status, 404);
      assert.equal((await request('/api/admin', { cookie: buyer.cookie })).status, 403);
      assert.equal((await request('/api/auth/sign-out', { cookie: buyer.cookie, body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await request('/api/orders', { cookie: buyer.cookie, body: { productId: 'secret', requestId: randomUUID() }, headers: { Origin: 'https://evil.example' } })).status, 403);
    });
    await t.test('浏览器新连接与后端重启仍识别同一会话；CLI健康检查走内部端口', async () => {
      await stop(); await start();
      assert.equal((await request('/api/me', { cookie: buyer.cookie })).data.user.id, buyer.data.user.id);
      assert.equal((await request('/account.html', { cookie: buyer.cookie })).status, 200);
      const check = await new Promise(resolve => {
        const proc = spawn(process.execPath, ['scripts/dev.mjs', 'check'], { cwd: PROJECT_ROOT, env }); let text = '';
        proc.stdout.on('data', data => text += data); proc.on('exit', code => resolve({ code, text }));
      });
      assert.equal(check.code, 0); assert.match(check.text, /"staging"/);
      assert.ok(!check.text.includes(token)); assert.ok(!check.text.includes(env.BETTER_AUTH_SECRET));
    });
    await t.test('真实不同来源IP限流独立；伪造IP头不能绕过限流', async () => {
      database.exec('DELETE FROM "rateLimit"');
      for (let i = 0; i < 10; i++) assert.equal((await request('/api/auth/sign-in/email', { body: { email: 'buyer@example.test', password: 'Wrong-password-123!' }, headers: { 'X-Forwarded-For': `192.0.2.${i}`, 'X-Delta-Client-IP': `192.0.2.${i}` } })).status, 401);
      assert.equal((await request('/api/auth/sign-in/email', { body: { email: 'buyer@example.test', password: signup('').password }, headers: { 'X-Forwarded-For': '192.0.2.222' } })).status, 429);
      assert.equal((await request('/api/auth/sign-in/email', { ip: '127.0.0.2', body: { email: 'other@example.test', password: signup('').password } })).status, 200);
      // Unauthenticated product requests exercise the API peer limiter without creating orders.
      for (let i = 0; i < 600; i++) assert.equal((await request('/api/products', { ip: '127.0.0.3' })).status, 200);
      assert.equal((await request('/api/products', { ip: '127.0.0.3', headers: { 'X-Forwarded-For': '192.0.2.200' } })).status, 429);
      assert.equal((await request('/api/products', { ip: '127.0.0.4' })).status, 200);
    });
    await t.test('退出后旧Cookie无效，其他用户会话保持，内测禁止公开种子账户', async () => {
      assert.equal((await request('/api/auth/sign-out', { cookie: buyer.cookie, body: {} })).status, 200);
      assert.equal((await request('/api/me', { cookie: buyer.cookie })).status, 401);
      assert.equal((await request('/account.html', { cookie: buyer.cookie })).status, 303);
      assert.equal((await request('/api/me', { cookie: other.cookie })).status, 200);
      const seed = spawnSync(process.execPath, ['scripts/dev.mjs', 'seed'], { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
      assert.notEqual(seed.status, 0);
      assert.equal(database.prepare('SELECT COUNT(*) n FROM user').get().n, 2);
      assert.ok(!logs.includes(token)); assert.ok(!logs.includes(env.BETTER_AUTH_SECRET));
    });
    await t.test('错误环境签名密钥拒绝启动，恢复原密钥后会话和账户保持', async () => {
      await stop(); const originalSecret = env.BETTER_AUTH_SECRET; env.BETTER_AUTH_SECRET = randomBytes(48).toString('hex');
      await assert.rejects(start(), /认证密钥与此数据目录不一致/);
      env.BETTER_AUTH_SECRET = originalSecret; await start();
      assert.equal((await request('/api/me', { cookie: other.cookie })).status, 200);
      database.exec('DELETE FROM "rateLimit"');
      const login = await request('/api/auth/sign-in/email', { body: { email: 'other@example.test', password: signup('').password } });
      assert.equal(login.status, 200); assert.equal(login.data.user.id, other.data.user.id);
    });
    await t.test('部署环境管理员无二次验证不能读写后台；HTTPS启用后可进入', async () => {
      database.prepare("UPDATE user SET role='admin' WHERE id=?").run(other.data.user.id);
      for (const route of ['/api/admin', '/api/team-admin', '/api/orders']) assert.equal((await request(route, { cookie: other.cookie })).status, 428);
      const page = await request('/admin.html', { cookie: other.cookie }); assert.equal(page.status, 303); assert.match(page.headers.location, /security=1/);
      const setup = await request('/api/security/enroll', { cookie: other.cookie, body: { password: signup('').password } }); assert.equal(setup.status, 200);
      const secret = new TextDecoder().decode(base32.decode(new URL(setup.data.totpURI).searchParams.get('secret')));
      const verified = await request('/api/security/verify', { cookie: other.cookie, body: { code: await createOTP(secret).totp() } }); assert.equal(verified.status, 200);
      assert.equal(verified.data.token, undefined); other.cookie = verified.cookie;
      assert.equal((await request('/api/admin', { cookie: other.cookie })).status, 200);
      assert.equal((await request('/admin.html', { cookie: other.cookie })).status, 200);
      assert.equal((await request('/api/security/disable', { cookie: other.cookie, body: { password: signup('').password } })).status, 403);
      const record = database.prepare('SELECT COUNT(*) n FROM security_proofs WHERE user_id=?').get(other.data.user.id); assert.equal(record.n, 1);
      assert.ok(!logs.includes(secret)); assert.ok(!logs.includes(setup.data.backupCodes[0]));
    });
    await t.test('离线管理授权需停写和已完成二次验证；撤销角色同时撤销会话', async () => {
      const runAdmin = (operation, email) => spawnSync(process.execPath, ['scripts/admin.mjs', operation, email], { cwd: PROJECT_ROOT, env, encoding: 'utf8', windowsHide: true });
      const running = runAdmin('revoke', 'other@example.test'); assert.notEqual(running.status, 0); assert.match(running.stderr, /数据目录正在使用/);
      await stop();
      const unqualified = runAdmin('grant', 'buyer@example.test'); assert.notEqual(unqualified.status, 0); assert.match(unqualified.stderr, /必须先以普通用户登录/);
      const grant = runAdmin('grant', 'other@example.test'); assert.equal(grant.status, 0); assert.ok(!grant.stdout.includes(env.BETTER_AUTH_SECRET));
      await start(); assert.equal((await request('/api/me', { cookie: other.cookie })).status, 401);
      const login = await request('/api/auth/sign-in/email', { body: { email: 'other@example.test', password: signup('').password } }); assert.equal(login.data.twoFactorRedirect, true);
      await stop(); const revoke = runAdmin('revoke', 'other@example.test'); assert.equal(revoke.status, 0);
      await start(); assert.equal(database.prepare('SELECT role FROM user WHERE id=?').get(other.data.user.id).role, 'user');
      assert.equal(database.prepare("SELECT count(*) n FROM audit_events WHERE action IN ('staging_admin_grant','staging_admin_revoke')").get().n, 2);
    });
  } finally {
    await stop(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    assert.ok(directory.startsWith(path.join(tmpdir(), 'delta-https-'))); rmSync(directory, { recursive: true, force: true });
  }
});
