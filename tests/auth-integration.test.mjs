import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { verifyPassword } from 'better-auth/crypto';

test('用户认证与持久化真实 HTTP 验收', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-auth-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const baseURL = `http://127.0.0.1:${port}`;
  const email = 'first@example.test';
  const password = 'Test-account-password-123!';
  let child;
  let database;
  const start = async () => {
    child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../server/index.mjs')], {
      env: { ...process.env, PORT: String(port), BETTER_AUTH_URL: baseURL, AUTH_DATA_DIR: directory, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start')), 20_000);
      child.stdout.on('data', data => { if (data.toString().includes('已启动')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
      child.once('error', reject);
    });
    database = new DatabaseSync(path.join(directory, 'auth.sqlite'));
  };
  const stop = async () => {
    database?.close(); database = null;
    if (child && child.exitCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
  };
  const request = async (route, { body, cookie = '', origin = baseURL, headers = {} } = {}) => {
    const response = await fetch(baseURL + route, {
      method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => null);
    return { response, data, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  };
  const signup = (overrides = {}) => ({ name: '测试用户甲', email, password, termsAccepted: true, ...overrides });
  const resetLimits = () => database.exec('DELETE FROM "rateLimit"');
  const check = async (name, run) => t.test(name, async () => { resetLimits(); await run(); });
  let sessionCookie;
  let userId;
  try {
    await start();
    await check('本地健康接口检查真实数据库，且不泄漏用户和密钥', async () => {
      const { response, data } = await request('/api/health');
      assert.equal(response.status, 200); assert.equal(data.app, 'delta-companion');
      assert.equal(data.database.auth, 'ok'); assert.equal(data.database.mocks, 'ok');
      assert.equal(data.providers.storage, 'local'); assert.equal(data.providers.payment, 'mock');
      assert.ok(!('secret' in data)); assert.ok(!('users' in data));
    });
    await check('1 新用户注册成功；用户和认证记录实际写入 SQLite', async () => {
      const result = await request('/api/auth/sign-up/email', { body: signup() });
      assert.equal(result.response.status, 200);
      sessionCookie = result.cookie; userId = result.data.user.id;
      assert.ok(sessionCookie.includes('delta-test.session_token='));
      assert.equal(database.prepare('SELECT id FROM "user" WHERE email=?').get(email).id, userId);
      assert.equal(database.prepare('SELECT COUNT(*) n FROM account WHERE userId=?').get(userId).n, 1);
    });
    await check('2 密码为可验证的带盐哈希，不是明文；返回不含密码', async () => {
      const stored = database.prepare('SELECT password FROM account WHERE userId=?').get(userId).password;
      assert.notEqual(stored, password);
      assert.equal(await verifyPassword({ hash: stored, password }), true);
      assert.equal(await verifyPassword({ hash: stored, password: 'incorrect-password' }), false);
      const { data } = await request('/api/me', { cookie: sessionCookie });
      assert.equal(data.user.id, userId); assert.equal(data.user.name, '测试用户甲');
      assert.ok(!JSON.stringify(data).includes(stored)); assert.ok(!('password' in data.user));
    });
    await check('3 正确账号密码登录，并创建持久会话', async () => {
      const result = await request('/api/auth/sign-in/email', { body: { email, password, rememberMe: true } });
      assert.equal(result.response.status, 200); sessionCookie = result.cookie;
      const cookies = result.response.headers.getSetCookie().join(';');
      assert.match(cookies, /HttpOnly/i); assert.match(cookies, /SameSite=Lax/i); assert.match(cookies, /Max-Age=604800/i);
    });
    await check('4 错误密码和不存在的用户不能登录', async () => {
      for (const account of [email, 'missing@example.test']) {
        const result = await request('/api/auth/sign-in/email', { body: { email: account, password: 'Wrong-password-123!' } });
        assert.equal(result.response.status, 401); assert.ok(!result.cookie.includes('delta-test.session_token='));
      }
    });
    await check('5 重复及大小写重复注册不创建第二用户', async () => {
      for (const address of [email, email.toUpperCase()]) {
        const result = await request('/api/auth/sign-up/email', { body: signup({ email: address }) });
        assert.ok([400, 422].includes(result.response.status));
      }
      assert.equal(database.prepare('SELECT COUNT(*) n FROM "user"').get().n, 1);
    });
    await check('6 协议未同意、非法昵称和短密码不能注册', async () => {
      for (const change of [{ termsAccepted: false }, { name: ' ' }, { password: 'short' }, { password: 'x'.repeat(129) }]) {
        const result = await request('/api/auth/sign-up/email', { body: signup({ email: 'invalid@example.test', ...change }) });
        assert.equal(result.response.status, 400);
      }
      assert.equal(database.prepare('SELECT COUNT(*) n FROM "user" WHERE email=?').get('invalid@example.test').n, 0);
    });
    await check('7 第二账号独立；相同密码哈希不同；客户端不能自授管理员', async () => {
      const second = await request('/api/auth/sign-up/email', { body: signup({ email: 'second@example.test', name: '测试用户乙', role: 'admin' }) });
      assert.equal(second.response.status, 200);
      const me = await request('/api/me', { cookie: second.cookie });
      assert.notEqual(me.data.user.id, userId); assert.equal(me.data.user.role, 'user');
      const hashes = database.prepare('SELECT password FROM account').all().map(row => row.password);
      assert.equal(new Set(hashes).size, 2);
    });
    await check('8 刷新重复访问及重开请求保持同一用户；页面禁止缓存', async () => {
      for (let i = 0; i < 3; i++) {
        const me = await request('/api/me', { cookie: sessionCookie });
        assert.equal(me.response.status, 200); assert.equal(me.data.user.id, userId);
        assert.equal(me.response.headers.get('cache-control'), 'no-store');
      }
      const response = await fetch(baseURL + '/account.html', { headers: { Cookie: sessionCookie } });
      assert.equal(response.status, 200); assert.match(await response.text(), /用户中心/);
    });
    await check('9 服务器重启后，用户与原会话仍可识别', async () => {
      const secret = readFileSync(path.join(directory, 'auth-secret'), 'utf8');
      await stop(); await start();
      assert.equal(readFileSync(path.join(directory, 'auth-secret'), 'utf8'), secret);
      const me = await request('/api/me', { cookie: sessionCookie });
      assert.equal(me.response.status, 200); assert.equal(me.data.user.id, userId);
    });
    await check('10 持续使用时数据库和浏览器 Cookie 同步续期', async () => {
      database.prepare('UPDATE session SET expiresAt=? WHERE userId=?').run(Date.now() + 5 * 24 * 3600 * 1000, userId);
      const result = await request('/api/me', { cookie: sessionCookie });
      assert.equal(result.response.status, 200);
      assert.match(result.response.headers.getSetCookie().join(';'), /Max-Age=604800/i);
      assert.ok(new Date(result.data.expiresAt).getTime() > Date.now() + 6 * 24 * 3600 * 1000);
    });
    await check('11 无会话不能进入受保护页面（包括编码路径）', async () => {
      const me = await request('/api/me'); assert.equal(me.response.status, 401);
      for (const route of ['/account.html', '/%61ccount.html', '/account.html?role=provider']) {
        const result = await request(route); assert.equal(result.response.status, 303);
        assert.match(result.response.headers.get('location'), /^\/\?login=1/);
      }
    });
    await check('12 退出撤销服务端会话，旧 Cookie 重放也不能登录', async () => {
      const result = await request('/api/auth/sign-out', { body: {}, cookie: sessionCookie });
      assert.equal(result.response.status, 200);
      assert.equal((await request('/api/me', { cookie: sessionCookie })).response.status, 401);
      assert.equal((await request('/account.html', { cookie: sessionCookie })).response.status, 303);
    });
    await check('13 过期和伪造会话均拒绝；退出后可以重新登录', async () => {
      const login = await request('/api/auth/sign-in/email', { body: { email, password } });
      assert.equal(login.response.status, 200);
      assert.equal((await request('/api/me', { cookie: login.cookie + 'tampered' })).response.status, 401);
      database.prepare('UPDATE session SET expiresAt=? WHERE userId=?').run(Date.now() - 1000, userId);
      assert.equal((await request('/api/me', { cookie: login.cookie })).response.status, 401);
    });
    await check('14 非本站来源不能注册、登录或退出', async () => {
      for (const route of ['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-out']) {
        assert.equal((await request(route, { body: signup(), origin: 'https://evil.example' })).response.status, 403);
      }
    });
    await check('15 数据库、密钥不开放；新订单 API 要求登录', async () => {
      for (const route of ['/.local/auth.sqlite', '/server/auth.mjs', '/.git/config', '/api/auth/update-user']) {
        assert.equal((await request(route)).response.status, 404);
      }
      assert.equal((await request('/api/orders')).response.status, 401);
    });
    await check('16 首页、服务、规则和预览资源继续可访问', async () => {
      for (const route of ['/', '/service.html?mode=secret', '/orders.html', '/rules.html', '/style.css', '/auth-ui.js']) {
        const response = await fetch(baseURL + route); assert.equal(response.status, 200);
      }
    });
    await check('底层注销/身份修改接口不可绕过应用白名单，用户和历史订单不被级联删除', async () => {
      const login = await request('/api/auth/sign-in/email', { body: { email, password } });
      assert.equal(login.response.status, 200);
      const created = await request('/api/orders', { cookie: login.cookie, body: { requestId: 'privacy-' + Date.now(), mode: 'secret', rulesAccepted: true } });
      assert.equal(created.response.status, 200);
      const orderId = created.data.order.id;
      const account = database.prepare('SELECT * FROM account WHERE userId=?').get(userId);
      const snapshot = database.prepare('SELECT payload FROM orders WHERE id=?').get(orderId).payload;
      for (const route of ['/api/auth/delete-user', '/api/auth/delete-user/callback', '/api/auth/%64elete-user', '/api/auth/update-user', '/api/auth/change-email', '/api/auth/link-social']) {
        for (const cookie of ['', login.cookie]) {
          const result = await request(route, { cookie, body: { password, token: 'forged', userId, email: 'attacker@example.test', name: '伪造资料' } });
          assert.equal(result.response.status, 404, route);
        }
      }
      assert.equal(database.prepare('SELECT id FROM user WHERE id=?').get(userId).id, userId);
      assert.deepEqual(database.prepare('SELECT * FROM account WHERE userId=?').get(userId), account);
      assert.equal(database.prepare('SELECT payload FROM orders WHERE id=?').get(orderId).payload, snapshot);
      assert.equal((await request('/api/me', { cookie: login.cookie })).response.status, 200);
      assert.equal((await request('/api/orders/' + orderId, { cookie: login.cookie })).response.status, 200);
    });
    await check('17 登录限流生效，伪造客户端 IP 无法绕过', async () => {
      let status;
      for (let i = 0; i < 11; i++) status = (await request('/api/auth/sign-in/email', { body: { email, password: 'Wrong-password-123!' }, headers: { 'x-delta-client-ip': `fake-${i}`, 'x-forwarded-for': `203.0.113.${i}` } })).response.status;
      assert.equal(status, 429);
    });
  } finally {
    await stop();
    // Only remove the exact temporary test directory created above, never the project database.
    assert.ok(directory.startsWith(path.join(tmpdir(), 'delta-auth-')));
    rmSync(directory, { recursive: true, force: true });
  }
});
