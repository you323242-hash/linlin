import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalProviders } from '../server/providers/local.mjs';
import { seedLocalUsers, TEST_USERS, TEST_PASSWORD } from '../scripts/seed-local.mjs';
import { localConfig, PROJECT_ROOT } from '../server/config.mjs';

test('本地 Provider 与测试数据底座', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-foundation-'));
  let services;
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  // Mock adapters and direct seed creation must work with all outbound HTTP blocked.
  globalThis.fetch = async () => { networkAttempts++; throw new Error('NETWORK_NOT_ALLOWED'); };
  try {
    services = createLocalProviders({ directory });
    let payment;
    await t.test('5 种服务都有独立接口，全部明确标为本地模拟', async () => {
      for (const [name, methods] of Object.entries({ payment: ['createPayment', 'getPayment', 'refund'], ai: ['analyze'], sms: ['send'], storage: ['put', 'get'], notification: ['send'] })) {
        for (const method of methods) assert.equal(typeof services[name][method], 'function');
      }
      assert.equal(services.health().simulated, true);
    });
    await t.test('模拟收款使用整数分，重复操作保持同一回执', async () => {
      const input = { reference: 'test-reference', amountCents: 1088, requestId: 'pay-1' };
      payment = await services.payment.createPayment(input);
      assert.equal(payment.simulated, true); assert.equal(payment.currency, 'CNY');
      assert.equal((await services.payment.createPayment(input)).id, payment.id);
      await assert.rejects(services.payment.createPayment({ ...input, amountCents: 2088 }), { code: 'IDEMPOTENCY_CONFLICT' });
      await assert.rejects(services.payment.createPayment({ ...input, amountCents: 10.88 }), { code: 'INVALID_AMOUNT' });
    });
    await t.test('模拟退款有原因、幂等性和金额上限', async () => {
      const input = { paymentId: payment.id, amountCents: 544, requestId: 'refund-1', reason: 'TEST_COMPENSATION' };
      const first = await services.payment.refund(input);
      assert.equal((await services.payment.refund(input)).id, first.id);
      assert.equal((await services.payment.getPayment(payment.id)).refundedCents, 544);
      await assert.rejects(services.payment.refund({ ...input, amountCents: 545, requestId: 'refund-too-much' }), { code: 'REFUND_EXCEEDS_PAYMENT' });
      await assert.rejects(services.payment.refund({ ...input, paymentId: 'missing', requestId: 'refund-missing' }), { code: 'PAYMENT_NOT_FOUND' });
    });
    await t.test('AI 桩不执行审核结论；短信与通知不会声称已发送', async () => {
      const ai = await services.ai.analyze({ text: '测试争议内容，不应写入日志', requestId: 'ai-1' });
      assert.equal(ai.needsHumanReview, true); assert.deepEqual(ai.findings, ['MOCK_NO_ANALYSIS']);
      const sms = await services.sms.send({ recipient: '13800000000', template: 'test-only', requestId: 'sms-1' });
      const notification = await services.notification.send({ userId: 'test-user', topic: 'test-only', requestId: 'notice-1' });
      assert.equal(sms.delivered, false); assert.equal(notification.delivered, false);
    });
    await t.test('本地存储写入读取正常，拒绝路径穿越和覆盖', async () => {
      const content = Buffer.from('local-storage-test');
      const result = await services.storage.put({ key: 'example.txt', content, requestId: 'file-1' });
      assert.equal(result.bytes, content.length);
      assert.deepEqual(await services.storage.get('example.txt'), content);
      assert.equal((await services.storage.put({ key: 'example.txt', content, requestId: 'file-1' })).id, result.id);
      await assert.rejects(services.storage.get('../auth-secret'), { code: 'INVALID_STORAGE_KEY' });
      await assert.rejects(services.storage.put({ key: 'example.txt', content: Buffer.from('overwrite'), requestId: 'file-2' }), { code: 'STORAGE_KEY_EXISTS' });
      await assert.rejects(services.storage.put({ key: 'big.txt', content: Buffer.alloc(1024 * 1024 + 1), requestId: 'file-big' }), { code: 'INVALID_CONTENT' });
    });
    await t.test('模拟事件有记录，重开后回执、退款和文件均保留', async () => {
      services.close(); services = createLocalProviders({ directory });
      assert.equal((await services.payment.getPayment(payment.id)).refundedCents, 544);
      assert.equal((await services.payment.createPayment({ reference: 'test-reference', amountCents: 1088, requestId: 'pay-1' })).id, payment.id);
      assert.equal((await services.storage.get('example.txt')).toString(), 'local-storage-test');
      const database = new DatabaseSync(path.join(directory, 'mock-services.sqlite'));
      try {
        const rows = database.prepare('SELECT * FROM mock_operations').all();
        assert.equal(rows.length, 6);
        for (const row of rows) { assert.ok(row.request_id); assert.ok(row.action); assert.ok(row.created_at); }
        const serialized = JSON.stringify(rows);
        assert.ok(!serialized.includes('13800000000')); assert.ok(!serialized.includes('测试争议内容'));
      } finally { database.close(); }
    });
    await t.test('生产环境或未知配置不能启用 Mock', async () => {
      assert.throws(() => createLocalProviders({ directory, mode: 'real' }), { code: 'MOCK_NOT_ALLOWED' });
      const previous = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        assert.throws(() => createLocalProviders({ directory }), { code: 'MOCK_NOT_ALLOWED' });
        await assert.rejects(seedLocalUsers(directory), /生产/);
      } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
    });
    await t.test('两个测试账号真实落库，重复准备不新增、不重置数据', async () => {
      const first = await seedLocalUsers(directory);
      assert.equal(first.filter(user => user.created).length, 2);
      const database = new DatabaseSync(path.join(directory, 'auth.sqlite'));
      const before = database.prepare('SELECT id,email,role FROM user ORDER BY email').all();
      database.close();
      const second = await seedLocalUsers(directory);
      assert.equal(second.filter(user => user.created).length, 0);
      const afterDatabase = new DatabaseSync(path.join(directory, 'auth.sqlite'));
      try {
        assert.deepEqual(afterDatabase.prepare('SELECT id,email,role FROM user ORDER BY email').all(), before);
        for (const user of before) assert.equal(user.role, 'user');
        assert.equal(afterDatabase.prepare('SELECT COUNT(*) n FROM user').get().n, TEST_USERS.length);
        for (const row of afterDatabase.prepare('SELECT password FROM account').all()) assert.notEqual(row.password, TEST_PASSWORD);
      } finally { afterDatabase.close(); }
    });
    await t.test('路径不随工作目录改变，端口和站点配置校验明确', async () => {
      assert.equal(localConfig({}).dataDirectory, path.join(PROJECT_ROOT, '.local'));
      assert.equal(localConfig({ PORT: '4310' }).baseURL, 'http://127.0.0.1:4310');
      assert.throws(() => localConfig({ PORT: 'not-a-number' }), /PORT/);
      assert.equal(localConfig({ PORT: '4310', BETTER_AUTH_URL: 'https://preview.example.test' }).port, 4310);
    });
    await t.test('所有 Mock 与测试数据准备均无外部 HTTP 请求', () => {
      assert.equal(networkAttempts, 0);
      assert.ok(!readFileSync(path.join(directory, 'mock-services.sqlite')).includes(Buffer.from(TEST_PASSWORD)));
    });
  } finally {
    globalThis.fetch = originalFetch;
    services?.close();
    assert.ok(directory.startsWith(path.join(tmpdir(), 'delta-foundation-')));
    rmSync(directory, { recursive: true, force: true });
  }
});
