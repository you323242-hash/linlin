import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { createMarket } from '../server/market.mjs';
import { migrate } from '../server/migrations.mjs';
import { createWorker, checkDisk, boundedCall } from '../server/operations.mjs';
import { createLogger } from '../server/logger.mjs';
import { acquireDataLock } from '../server/data-lock.mjs';

async function fixture(t, options = {}) {
  const parent = realpathSync(tmpdir()), directory = mkdtempSync(path.join(parent, 'delta-ops-'));
  const { auth, database } = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: directory });
  const providers = createLocalProviders({ directory });
  let clock = Date.now();
  const market = createMarket(database, providers, { now: () => clock, ...options });
  const users = [];
  for (let i = 0; i < 3; i++) users.push((await auth.api.signUpEmail({ body: { name: `运营测试${i}`, email: `ops${i}@example.test`, password: 'Local-operations-test-2026!', termsAccepted: true } })).user);
  users[2].role = 'admin';
  database.prepare("UPDATE user SET role='admin' WHERE id=?").run(users[2].id);
  const call = (user, scope, fields = {}) => market.command(user, scope, { ...fields, requestId: fields.requestId || randomUUID() });
  const create = async () => (await call(users[0], 'create', { mode: 'secret', rulesAccepted: true })).order;
  const action = (order, name, fields = {}) => call(users[0], `${order.id}:${name}`, { version: market.readOrder(order.id, users[0]).version, ...fields });
  t.after(() => { providers.close(); database.close(); const target = realpathSync(directory); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('delta-ops-')); rmSync(target, { recursive: true }); });
  return { directory, auth, database, providers, market, users, call, create, action, advance: ms => clock += ms, now: () => clock };
}
test('应用迁移可重复执行，失败回滚，已应用 SQL 不可静默更改', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(migrate(db, 'example', 'CREATE TABLE example(id TEXT PRIMARY KEY)'), true);
    assert.equal(migrate(db, 'example', 'CREATE TABLE example(id TEXT PRIMARY KEY)'), false);
    assert.throws(() => migrate(db, 'example', 'CREATE TABLE example(id INTEGER)'), /不可修改/);
    assert.throws(() => migrate(db, 'bad', 'CREATE TABLE rollback_me(id); THIS IS INVALID SQL'));
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='rollback_me'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM app_migrations WHERE id='bad'").get(), undefined);
  } finally { db.close(); }
});
test('模拟通道已支付但响应丢失：先查询、原号恢复、不重复支付', async t => {
  const f = await fixture(t), original = f.providers.payment.createPayment; let sends = 0;
  f.providers.payment.createPayment = async input => { sends++; await original(input); throw Object.assign(Error('sensitive response'), { code: 'TIMEOUT' }); };
  const o = await f.create(); await f.action(o, 'pay');
  assert.equal(f.market.readOrder(o.id, f.users[0]).payment.status, 'processing');
  await f.market.drainPayments(); assert.equal(sends, 1);
  f.advance(5000); await f.market.drainPayments();
  const paid = f.market.readOrder(o.id, f.users[0]); assert.equal(paid.status, 'matching'); assert.equal(sends, 1);
  assert.equal(f.database.prepare('SELECT attempts FROM payment_jobs').get().attempts, 2);
  assert.equal(f.market.operations.snapshot().alerts.length, 0);
  assert.equal(paid.events.filter(e => e.label.startsWith('模拟支付成功')).length, 1);
});
test('模拟退款响应丢失后查询原号，只累计一次退款', async t => {
  const f = await fixture(t), o = await f.create(); await f.action(o, 'pay');
  const original = f.providers.payment.refund; let refunds = 0;
  f.providers.payment.refund = async input => { refunds++; await original(input); throw Object.assign(Error('TIMEOUT'), { code: 'TIMEOUT' }); };
  await f.action(o, 'cancel'); f.advance(5000); await f.market.drainPayments(); await f.market.drainPayments();
  const order = f.market.readOrder(o.id, f.users[0]); assert.equal(order.payment.refunded, 1088); assert.equal(refunds, 1);
  assert.equal((await f.providers.payment.getPayment(order.payment.receiptId)).refundedCents, 1088);
});
test('结果无法查询不重新发钱；失败退避、上限暂停、授权恢复保留累计次数', async t => {
  const f = await fixture(t); let sends = 0;
  f.providers.payment.createPayment = async () => { sends++; throw Error('secret-key-must-not-persist'); };
  const o = await f.create(); await f.action(o, 'pay');
  const originalLookup = f.providers.payment.findPayment;
  f.providers.payment.findPayment = async () => { throw Error('private vendor response'); };
  for (let i = 0; i < 4; i++) { f.advance(300000); await f.market.drainPayments(); }
  let job = f.database.prepare('SELECT * FROM payment_jobs').get();
  assert.equal(job.status, 'blocked'); assert.equal(job.attempts, 5); assert.equal(sends, 1); assert.equal(job.last_error, 'OPERATION_FAILED');
  f.advance(300000); await f.market.drainPayments(); assert.equal(sends, 1);
  await assert.rejects(f.call(f.users[0], 'admin:retry', { id: job.id, kind: 'payment', reason: '已核对通道记录，准备恢复同一任务' }), /管理员/);
  await assert.rejects(f.call({ ...f.users[0], role: 'admin' }, 'admin:retry', { id: job.id, kind: 'payment', reason: '已核对通道记录，准备恢复同一任务' }), /自己参与/);
  f.providers.payment.findPayment = originalLookup;
  f.providers.payment.createPayment = async input => ({ simulated: true, id: 'invalid', status: 'succeeded', reference: input.reference, amountCents: 1, currency: 'CNY' });
  await f.call(f.users[2], 'admin:retry', { id: job.id, kind: 'payment', reason: '已核对通道记录，准备恢复同一任务' });
  job = f.database.prepare('SELECT * FROM payment_jobs').get(); assert.equal(job.attempts, 6); assert.equal(job.status, 'blocked'); assert.equal(job.last_error, 'INVALID_RECEIPT');
  assert.equal(f.market.readOrder(o.id, f.users[0]).payment.status, 'processing');
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM audit_events WHERE action='task_retry'").get().n, 1);
});
test('通道永不返回也可结束等待，通知持久重试不会伪报外部已送达', async t => {
  const f = await fixture(t, { providerTimeoutMs: 15 });
  let aborted = false;
  await assert.rejects(boundedCall(signal => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })), 10), /TIMEOUT/);
  assert.equal(aborted, true);
  await f.create();
  const original = f.providers.notification.send;
  f.providers.notification.send = () => new Promise(() => {});
  await f.market.drainNotifications();
  const job = f.database.prepare('SELECT * FROM notification_jobs').get(); assert.equal(job.last_error, 'TIMEOUT');
  assert.equal(f.market.inbox(f.users[0]).notifications.length, 1);
  f.providers.notification.send = original; f.advance(5000); await f.market.drainNotifications(); await f.market.drainNotifications();
  assert.equal(f.database.prepare('SELECT status FROM notification_jobs').get().status, 'done');
  assert.equal(f.providers.health().operations, 1);
  assert.equal(f.market.operations.snapshot().alerts.length, 0);
});
test('工作循环防重入，失败隔离与心跳检测；等待提醒解决后关闭', async t => {
  const f = await fixture(t, { attentionMs: 1000 }); let runs = 0, finish;
  const worker = createWorker(f.database, f.market.operations, [{ id: 'slow', run: () => { runs++; return new Promise(resolve => finish = resolve); } }, { id: 'fail', run: () => { throw Error('private'); } }], { now: f.now });
  const first = worker.tick(), second = worker.tick(); assert.equal(first, second); assert.equal(runs, 1);
  finish(); await first; assert.equal(f.market.operations.snapshot().tasks.find(t => t.id === 'fail').failures, 1);
  assert.equal(worker.health().status, 'degraded');
  const o = await f.create(); await f.action(o, 'pay'); f.advance(1001); f.market.maintain(); f.market.maintain();
  assert.equal(f.database.prepare("SELECT occurrences FROM operation_alerts WHERE kind='attention'").get().occurrences, 1);
  await f.action(o, 'cancel'); f.market.maintain();
  assert.ok(f.database.prepare("SELECT resolved_at FROM operation_alerts WHERE kind='attention'").get().resolved_at);
  f.advance(186000); assert.equal(worker.health().stale, true); await worker.stop();
});
test('磁盘低水位、恢复与日志轮转：敏感字段不进入日志', async t => {
  const f = await fixture(t);
  checkDisk(f.directory, f.market.operations, { statfs: () => ({ bavail: 1, bsize: 4096 }) });
  assert.equal(f.market.operations.snapshot().alerts[0].code, 'LOW_DISK');
  checkDisk(f.directory, f.market.operations, { statfs: () => ({ bavail: 1024 * 1024, bsize: 4096 }) });
  assert.equal(f.market.operations.snapshot().alerts.length, 0);
  const logdir = path.join(f.directory, 'logs'), logger = createLogger(logdir, { maximumBytes: 256, copies: 2 });
  for (let i = 0; i < 20; i++) logger({ event: 'request', requestId: randomUUID(), route: '/api/auth?password=secret', password: 'secret', cookie: 'private', evidence: 'private', status: 200 });
  const files = readdirSync(logdir); assert.equal(files.length, 3);
  assert.ok(!files.map(f => readFileSync(path.join(logdir,f),'utf8')).join('').includes('secret'));
  assert.ok(logger.healthy());
});
test('相同数据目录只能一个写入者，释放后重新取得', async t => {
  const f = await fixture(t), release = await acquireDataLock(f.directory);
  try { await assert.rejects(acquireDataLock(f.directory), /正在使用/); }
  finally { await release(); }
  const second = await acquireDataLock(f.directory); await second();
});
