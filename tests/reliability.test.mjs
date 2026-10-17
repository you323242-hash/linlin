import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createMarket } from '../server/market.mjs';
import { createEvidence } from '../server/evidence.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { createSnapshot, verifySnapshot, restoreSnapshot } from '../scripts/backup.mjs';

test('异常订单、站内消息与完整恢复', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-reliability-')); let db, providers, market, auth, clock = Date.now(); const users = [];
  async function setup(dir = directory) { const result = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: dir }); db = result.database; auth = result.auth; providers = createLocalProviders({ directory: dir }); market = createMarket(db, providers, { now: () => clock, attentionMs: 1000 }); }
  const call = (u, scope, fields = {}) => market.command(u, scope, { requestId: randomUUID(), ...fields });
  const change = (o, u, name, fields = {}) => call(u, `${o.id}:${name}`, { version: market.readOrder(o.id, users[0]).version, ...fields });
  async function ready() { let o = (await call(users[0], 'create', { mode: 'secret', rulesAccepted: true })).order; o = (await change(o, users[0], 'pay')).order; return (await change(o, users[1], 'accept')).order; }
  try {
    await setup(); for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { email: `reliability${i}@example.test`, password: 'Reliability-local-password!', name: '恢复测试' + i, termsAccepted: true } })).user);
    users[3].role = 'admin'; db.prepare("UPDATE user SET role='admin' WHERE id=?").run(users[3].id);
    await call(users[1], 'profile', { gameId: 'LOCAL-RECOVERY', introduction: '仅测试异常处理恢复', adult: true, available: true, modes: ['secret'], stats: { secret: { kd: 1, gear: 4 } } });
    let o;
    await t.test('未开始取消必须双方同意，不能自批；超时仅提醒，陌生用户无权', async () => {
      o = await ready(); await change(o, users[0], 'requestCancel', { reason: '仅本机验收，双方协商取消尚未开始的服务' });
      await assert.rejects(change(o, users[0], 'respondCancel', { agreed: true }), { status: 409 });
      await assert.rejects(change(o, users[2], 'respondCancel', { agreed: true }), { status: 404 });
      await assert.rejects(change(o, users[1], 'start'), { status: 409 });
      clock += 1000; market.maintain(); market.maintain(); assert.equal(market.readOrder(o.id, users[0]).status, 'ready'); assert.equal(market.readOrder(o.id, users[0]).payment.refunded, 0);
      assert.equal(market.inbox(users[1]).notifications.filter(n => n.label.includes('协商取消待回应')).length, 1);
      const result = (await change(o, users[1], 'respondCancel', { agreed: true })).order; assert.equal(result.status, 'cancelled'); assert.equal(result.payment.refunded, 1088);
      assert.equal(db.prepare("SELECT count(*) AS n FROM payment_jobs WHERE order_id=? AND action='refund'").get(o.id).n, 1);
    });
    await t.test('不同意取消保留理由，仍可开始；提醒限频且不能重复开始', async () => {
      o = await ready(); await change(o, users[1], 'requestCancel', { reason: '仅测试服务者提出取消后消费者不同意' });
      await change(o, users[0], 'respondCancel', { agreed: false, reason: '仅测试保留原因，双方继续正常沟通服务' }); assert.equal(market.readOrder(o.id, users[0]).cancelHistory.length, 1);
      await change(o, users[0], 'remind'); await assert.rejects(change(o, users[1], 'remind'), { status: 409 });
      await change(o, users[1], 'start'); await assert.rejects(change(o, users[1], 'start'), { status: 409 }); await change(o, users[0], 'start');
    });
    await t.test('无页面轮询也能到时，单方确认不自动完成；通知不重复生成', async () => {
      clock += 3600000; market.maintain(); assert.equal(market.readOrder(o.id, users[0]).status, 'confirming');
      await change(o, users[1], 'finish'); clock += 1000; market.maintain(); const before = market.inbox(users[0]).notifications.length; market.maintain(); assert.equal(market.inbox(users[0]).notifications.length, before);
      assert.equal(market.readOrder(o.id, users[0]).status, 'confirming'); await assert.rejects(change(o, users[1], 'finish'), { status: 409 });
      await change(o, users[0], 'finish'); assert.equal(market.readOrder(o.id, users[0]).status, 'completed');
    });
    await t.test('站内消息只能本人读取和标已读；重复标记保持原时间', async () => {
      const n = market.inbox(users[0]).notifications[0]; assert.equal(market.inbox(users[2]).notifications.length, 0);
      assert.throws(() => market.markRead(users[2], n.id), { status: 404 }); market.markRead(users[0], n.id); const at = market.inbox(users[0]).notifications.find(x => x.id === n.id).readAt;
      clock += 1000; market.markRead(users[0], n.id); assert.equal(market.inbox(users[0]).notifications.find(x => x.id === n.id).readAt, at);
    });
    await t.test('取消争议转售后不会残留开始锁；方案无人回应不自动执行', async () => {
      o = await ready(); await change(o, users[0], 'requestCancel', { reason: '仅测试未开始取消期间进入人工售后' }); await change(o, users[0], 'request', { kind: 'complaint', description: '仅测试沟通和人工恢复，不涉及真实客诉。' });
      assert.equal(market.readOrder(o.id, users[0]).cancelRequest, null);
      await change(o, users[3], 'proposeCase', { outcome: 'resume', reason: '仅测试方案无人确认时不会自动执行' }); clock += 1000; market.maintain(); assert.equal(market.readOrder(o.id, users[0]).case.stage, 'proposed');
      await change(o, users[0], 'acceptCase'); await change(o, users[1], 'acceptCase'); await change(o, users[1], 'start'); await change(o, users[0], 'start');
    });
    await t.test('管理员不得自行处理参与订单，其他管理员正常处理', async () => {
      await change(o, users[0], 'request', { kind: 'complaint', description: '仅测试管理员利益冲突限制与证据备份。' });
      users[0].role = 'admin'; await assert.rejects(change(o, users[0], 'proposeCase', { outcome: 'resume', reason: '自己参与的订单不得由本人提出处理方案' }), { status: 403 }); users[0].role = 'user';
      db.prepare('INSERT INTO released_services VALUES (?,?,?)').run(o.id, users[2].id, JSON.stringify(market.readOrder(o.id, users[0])));
      users[2].role = 'admin'; await assert.rejects(change(o, users[2], 'proposeCase', { outcome: 'resume', reason: '已换出服务者也不能处理自己参与的订单' }), { status: 403 }); users[2].role = 'user';
      assert.ok(market.adminData(users[3]).attention); await assert.rejects(change(o, users[1], 'requestCancel', { reason: '服务已开始不能再走协商取消初次退款' }), { status: 409 });
    });
    let snapshot, file, cookie;
    await t.test('完整备份校验账户、订单、密钥、Mock与私有附件；拒绝路径攻击', async () => {
      const evidence = createEvidence(db, market, providers.storage); file = await evidence.upload(users[0], o.id, market.readOrder(o.id, users[0]).case.id, { name: '测试.png', mime: 'image/png', requestId: randomUUID(), content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrxkAAAAASUVORK5CYII=', 'base64') });
      const login = await auth.api.signInEmail({ body: { email: 'reliability0@example.test', password: 'Reliability-local-password!' }, returnHeaders: true }); cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
      providers.close(); db.close(); providers = db = null; snapshot = createSnapshot(directory, path.join(directory, 'backups', 'snapshot'));
      assert.ok(verifySnapshot(snapshot).files.some(f => f.name.startsWith('storage/')));
      assert.throws(() => createSnapshot(directory, directory)); assert.throws(() => restoreSnapshot(snapshot, directory));
      const manifestPath = path.join(snapshot, 'manifest.json'), original = readFileSync(manifestPath); const bad = JSON.parse(original); bad.files[0].name = '../auth.sqlite'; writeFileSync(manifestPath, JSON.stringify(bad)); assert.throws(() => verifySnapshot(snapshot), /路径|清单/); writeFileSync(manifestPath, original);
    });
    await t.test('恢复到新目录后原会话、业务和附件可读；损坏文件拒绝恢复', async () => {
      const restored = restoreSnapshot(snapshot, path.join(directory, 'restore-drill')); await setup(restored);
      assert.equal((await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) })).user.id, users[0].id);
      assert.equal(market.readOrder(o.id, users[0]).case.stage, 'human'); assert.ok(market.inbox(users[0]).notifications.length);
      const evidence = createEvidence(db, market, providers.storage); assert.equal((await evidence.download(users[1], file.id)).bytes, 68);
      const secret = path.join(snapshot, 'auth-secret'), original = readFileSync(secret); writeFileSync(secret, 'corrupted'); assert.throws(() => restoreSnapshot(snapshot, path.join(directory, 'bad-restore')), /完整性/); writeFileSync(secret, original);
    });
  } finally {
    providers?.close(); db?.close();
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'delta-reliability-')) throw Error('测试清理路径无效'); rmSync(directory, { recursive: true, force: true });
  }
});
