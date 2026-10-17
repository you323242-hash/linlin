import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { localConfig, prepareRuntimeDirectory, PROJECT_ROOT } from '../server/config.mjs';
import { applyRequestContext } from '../server/request-context.mjs';

test('环境配置与代理信任边界', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-config-'));
  const env = { APP_ENV: 'staging', NODE_ENV: 'production', PORT: '4174', BETTER_AUTH_URL: 'https://preview.example.test', AUTH_DATA_DIR: path.join(directory, 'staging'), BETTER_AUTH_SECRET: randomBytes(48).toString('hex'), STAGING_ACCESS_TOKEN: randomBytes(48).toString('hex'), TRUSTED_PROXY_IPS: '127.0.0.1', ALLOW_STAGING_MOCKS: 'true' };
  try {
    await t.test('公网443与内部4174独立；本地与测试默认目录不同', () => {
      const config = localConfig(env);
      assert.equal(config.port, 4174); assert.equal(config.baseURL, 'https://preview.example.test');
      assert.equal(config.environment, 'staging');
      assert.equal(config.requireEmailVerification, true);
      assert.equal(localConfig({...env,AUTH_REQUIRE_EMAIL_VERIFICATION:'false'}).requireEmailVerification,true);
      assert.equal(localConfig({AUTH_REQUIRE_EMAIL_VERIFICATION:'true'}).requireEmailVerification,true);
      assert.throws(()=>localConfig({AUTH_REQUIRE_EMAIL_VERIFICATION:'unexpected'}));
      assert.notEqual(localConfig({}).dataDirectory, localConfig({ APP_ENV: 'test' }).dataDirectory);
    });
    await t.test('拒绝未知环境、无保护内测、路径/来源错误与模拟生产', () => {
      for (const override of [
        { APP_ENV: 'prod' }, { APP_ENV: 'production' }, { APP_ENV: 'local' }, { NODE_ENV: 'test' },
        { PORT: '0' }, { BETTER_AUTH_URL: 'http://preview.example.test' },
        { BETTER_AUTH_URL: 'https://preview.example.test/path' }, { BETTER_AUTH_URL: 'https://user:pass@preview.example.test' },
        { BETTER_AUTH_URL: 'https://preview.example.test?x=1' }, { BETTER_AUTH_URL: 'https://preview.example.test#x' },
        { BETTER_AUTH_URL: 'invalid' }, { BETTER_AUTH_SECRET: '' }, { STAGING_ACCESS_TOKEN: '' },
        { STAGING_ACCESS_TOKEN: env.BETTER_AUTH_SECRET }, { AUTH_DATA_DIR: '' },
        { AUTH_DATA_DIR: '.local' }, { AUTH_DATA_DIR: 'dist/data' }, { AUTH_DATA_DIR: '.' },
        { TRUSTED_PROXY_IPS: '' }, { TRUSTED_PROXY_IPS: '::1' }, { TRUSTED_PROXY_IPS: '0.0.0.0/0' }, { TRUSTED_PROXY_IPS: '203.0.113.1' },
        { ALLOW_STAGING_MOCKS: '' }, { EXTERNAL_SERVICE_MODE: 'real' },
      ]) assert.throws(() => localConfig({ ...env, ...override }));
      assert.throws(() => localConfig({ NODE_ENV: 'production' }));
      assert.throws(() => localConfig({ APP_ENV: 'test', AUTH_DATA_DIR: '.local' }));
      assert.throws(() => localConfig({ ALLOW_STAGING_MOCKS: 'true' }));
      if (process.platform === 'win32') assert.throws(() => localConfig({ AUTH_DATA_DIR: 'DIST/data' }));
    });
    await t.test('数据目录绑定环境，内测拒绝复用已有种子库', () => {
      const config = localConfig(env); prepareRuntimeDirectory(config); prepareRuntimeDirectory(config);
      assert.throws(() => prepareRuntimeDirectory({ ...config, environment: 'local' }), /其他 APP_ENV/);
      writeFileSync(path.join(directory, 'auth.sqlite'), 'not-a-database');
      assert.throws(() => prepareRuntimeDirectory({ ...config, dataDirectory: directory }), /空数据目录/);
    });
    await t.test('未知/生产配置启动失败，不创建数据库', () => {
      for (const app of ['invalid', 'production']) {
        const child = spawnSync(process.execPath, ['server/index.mjs'], { cwd: PROJECT_ROOT, env: { ...process.env, ...env, APP_ENV: app, AUTH_DATA_DIR: path.join(directory, app) }, encoding: 'utf8' });
        assert.notEqual(child.status, 0); assert.equal(existsSync(path.join(directory, app)), false);
        assert.ok(!child.stderr.includes(env.BETTER_AUTH_SECRET)); assert.ok(!child.stderr.includes(env.STAGING_ACCESS_TOKEN));
      }
    });
    const request = (headers = {}, peer = '127.0.0.1') => ({ socket: { remoteAddress: peer }, headers: { host: 'preview.example.test', 'x-forwarded-host': 'preview.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.10', 'x-delta-staging-access': env.STAGING_ACCESS_TOKEN, ...headers } });
    await t.test('仅信任指定代理；无令牌或伪造Host、协议、IP链均拒绝', () => {
      const config = localConfig(env);
      for (const req of [request({}, '192.0.2.10'), request({ host: 'evil.test' }), request({ 'x-forwarded-host': 'evil.test' }), request({ 'x-forwarded-proto': 'http' }), request({ 'x-forwarded-for': '192.0.2.1, 192.0.2.2' }), request({ 'x-forwarded-for': 'unknown' }), request({ 'x-delta-staging-access': '' })]) assert.ok(applyRequestContext(req, config).status);
      const valid = request({ forwarded: 'for=1.1.1.1', 'x-delta-client-ip': '1.1.1.1', 'x-real-ip': '1.1.1.1' });
      assert.equal(applyRequestContext(valid, config).clientIP, '192.0.2.10');
      assert.equal(valid.headers['x-delta-client-ip'], '192.0.2.10');
      for (const header of ['forwarded', 'x-real-ip', 'x-forwarded-for', 'x-delta-staging-access']) assert.equal(valid.headers[header], undefined);
    });
    await t.test('直连本地无条件丢弃来访者伪造的代理头', () => {
      const config = localConfig({ BETTER_AUTH_URL: 'http://preview.example.test' });
      const req = request(); assert.equal(applyRequestContext(req, config).clientIP, '127.0.0.1');
      assert.equal(req.headers['x-forwarded-proto'], undefined);
    });
  } finally {
    assert.ok(directory.startsWith(path.join(tmpdir(), 'delta-config-')));
    rmSync(directory, { recursive: true, force: true });
  }
});
