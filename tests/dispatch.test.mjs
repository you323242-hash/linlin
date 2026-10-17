import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { createMarket } from '../server/market.mjs';

test('本地自动派单、邀请租约与重启恢复', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-dispatch-'));
  let database, providers, market, clock = Date.now(); const users = [];
  async function setup() {
    const result = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: directory }); database = result.database;
    providers = createLocalProviders({ directory }); market = createMarket(database, providers, { now: () => clock, offerMs: 2000, presenceMs: 10000 }); return result.auth;
  }
  const call = (u, scope, body = {}) => market.command(u, scope, { requestId: randomUUID(), ...body });
  const action = (u, o, name, fields = {}) => call(u, `${o.id}:${name}`, { version: market.readOrder(o.id, users[0]).version, ...fields });
  const offer = o => database.prepare("SELECT * FROM dispatch_offers WHERE order_id=? AND status='pending'").get(o.id);
  const saveProfile = (u, available = true, modes = ['secret'], kd = 1) => call(u, 'profile', { adult: true, gameId: 'LOCAL-DISPATCH', introduction: '仅本机派单验收', available, modes, stats: Object.fromEntries(modes.map(m => [m, { kd, gear: m === 'secret' ? 4 : 5 }])) });
  async function paid(buyer = users[0]) { const o = (await call(buyer, 'create', { mode: 'secret', rulesAccepted: true, preference: '不可向未接单者泄漏的私有需求' })).order; return (await action(buyer, o, 'pay')).order; }
  async function cancel(o) { await action(users[0], o, 'cancel'); }
  async function complete(o, provider) { await action(provider, o, 'start'); await action(users[0], o, 'start', { acceptLowKd: true }); clock += 3600000; await action(provider, o, 'finish'); await action(users[0], o, 'finish'); }
  async function reset() { clock += 20000; market.dispatch(); for (const u of [users[1], users[2], users[4]]) await saveProfile(u, false); }
  try {
    const auth = await setup();
    for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `派单测试${i}`, email: `dispatch${i}@example.test`, password: 'Dispatch-local-password!', termsAccepted: true } })).user);
    users[3].role = 'admin'; database.prepare("UPDATE user SET role='admin' WHERE id=?").run(users[3].id);
    await t.test('保存开关不等于在线；邀请只向在线合格者，未接单不泄漏资料', async () => {
      await saveProfile(users[1]); await saveProfile(users[2], true, ['topsecret']); await saveProfile(users[4], false);
      const o = await paid(); assert.equal(offer(o), undefined);
      market.heartbeat(users[2]); market.heartbeat(users[4]); assert.equal(offer(o), undefined);
      market.heartbeat(users[1]); const invitation = offer(o); assert.equal(invitation.user_id, users[1].id);
      const q = market.queue(users[1]).find(q => q.id === o.id); assert.equal(q.offer.id, invitation.id); assert.equal(q.offer.expiresAt, clock + 2000);
      assert.ok(!JSON.stringify(q).includes(users[0].id)); assert.equal(q.preference, ''); assert.equal(market.queue(users[2]).length, 0);
      await assert.rejects(action(users[4], o, 'accept', { offerId: invitation.id }), { status: 409 });
      await assert.rejects(action(users[1], o, 'accept'), { status: 409 }); await cancel(o); await reset();
    });
    await t.test('跳过后邀请另一人；重复请求不重复执行，不能冒领或跨单使用', async () => {
      await saveProfile(users[1]); await saveProfile(users[2]); market.heartbeat(users[1]); market.heartbeat(users[2]);
      const o = await paid(), first = offer(o), owner = users.find(u => u.id === first.user_id), other = owner.id === users[1].id ? users[2] : users[1];
      await assert.rejects(action(other, o, 'declineOffer', { offerId: first.id }), { status: 409 });
      const body = { offerId: first.id, requestId: randomUUID() };
      await call(owner, `${o.id}:declineOffer`, body); const second = offer(o); assert.equal(second.user_id, other.id);
      await call(owner, `${o.id}:declineOffer`, body); assert.equal(offer(o).id, second.id);
      await assert.rejects(action(owner, o, 'accept', { offerId: first.id }), { status: 409 });
      await assert.rejects(action(other, o, 'accept', { offerId: first.id }), { status: 409 }); await cancel(o); await reset();
    });
    await t.test('截止时刻严格失效并重派，旧邀请不能迟到接受', async () => {
      for (const u of [users[1], users[2]]) { await saveProfile(u); market.heartbeat(u); }
      const o = await paid(), first = offer(o); clock = first.expires_at; market.dispatch(); const second = offer(o);
      assert.notEqual(second.user_id, first.user_id); assert.equal(database.prepare('SELECT status FROM dispatch_offers WHERE id=?').get(first.id).status, 'expired');
      await assert.rejects(action(users.find(u => u.id === first.user_id), o, 'accept', { offerId: first.id }), { status: 409 }); await cancel(o); await reset();
    });
    await t.test('全部候选跳过后保留等待、自主接单与取消，不罚分或重复邀请', async () => {
      await saveProfile(users[1]); market.heartbeat(users[1]); const o = await paid(), first = offer(o);
      await action(users[1], o, 'declineOffer', { offerId: first.id }); market.dispatch(); assert.equal(offer(o), undefined);
      assert.equal(market.profile(users[1].id).suspended, false); assert.equal(market.queue(users[1]).find(q => q.id === o.id).offer, undefined);
      await cancel(o); assert.equal(market.readOrder(o.id, users[0]).payment.refunded, 1088); await reset();
    });
    await t.test('并发接受只成功一次，仍需双方确认才计时；无邀请时自主接单保留', async () => {
      await saveProfile(users[1]); market.heartbeat(users[1]); const o = await paid(), invitation = offer(o);
      const results = await Promise.allSettled([action(users[1], o, 'accept', { offerId: invitation.id }), action(users[1], o, 'accept', { offerId: invitation.id })]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(market.readOrder(o.id, users[0]).runningSince, null);
      await complete(o, users[1]); await reset(); await saveProfile(users[1]); const manual = await paid(); assert.equal(offer(manual), undefined);
      await action(users[1], manual, 'accept'); await complete(manual, users[1]); await reset();
    });
    await t.test('暂停或停止接单撤回邀请，恢复不直接接受旧邀请', async () => {
      for (const u of [users[1], users[2]]) { await saveProfile(u); market.heartbeat(u); }
      const o = await paid(), first = offer(o), u = users.find(u => u.id === first.user_id);
      await call(users[3], 'admin:suspend', { userId: u.id, suspended: true, reason: '仅测试暂停后撤回未接受邀请的功能' }); assert.notEqual(offer(o).user_id, u.id);
      await assert.rejects(action(u, o, 'accept', { offerId: first.id }), { status: 409 });
      await call(users[3], 'admin:suspend', { userId: u.id, suspended: false, reason: '仅测试恢复功能，不影响已有其他订单' }); await saveProfile(users.find(x => x.id === offer(o).user_id), false); assert.equal(offer(o), undefined);
      await cancel(o); await reset();
    });
    await t.test('失去在线状态撤回邀请，不把保存的可接单状态视为持续在线', async () => {
      await saveProfile(users[1]); market.heartbeat(users[1]); const o = await paid(), first = offer(o);
      clock += 10000; market.dispatch(); assert.equal(offer(o), undefined); await assert.rejects(action(users[1], o, 'accept', { offerId: first.id }), { status: 409 });
      await cancel(o); await reset();
    });
    await t.test('每人最多一个邀请；消费者已有服务后撤回其他匹配，禁止重叠接单', async () => {
      for (const u of [users[1], users[2]]) { await saveProfile(u); market.heartbeat(u); }
      const a = await paid(), b = await paid(), ia = offer(a), ib = offer(b); assert.notEqual(ia.user_id, ib.user_id);
      const provider = users.find(u => u.id === ia.user_id), another = users.find(u => u.id === ib.user_id);
      await assert.rejects(action(provider, b, 'accept', { offerId: ia.id }), { status: 409 });
      await action(provider, a, 'accept', { offerId: ia.id }); assert.equal(offer(b), undefined);
      await assert.rejects(action(another, b, 'accept', { offerId: ib.id }), { status: 409 }); await cancel(b); await complete(a, provider); await reset();
    });
    await t.test('重启保持邀请标识与截止时间，重启后到期不复活', async () => {
      await saveProfile(users[1]); market.heartbeat(users[1]); const o = await paid(), first = offer(o);
      providers.close(); database.close(); await setup(); market.dispatch(); assert.equal(offer(o).id, first.id); assert.equal(offer(o).expires_at, first.expires_at);
      clock = first.expires_at; market.dispatch(); assert.equal(offer(o), undefined); await cancel(o); await reset();
    });
    await t.test('低KD仍需消费者明确同意；更换后不再邀请原服务者', async () => {
      await saveProfile(users[1], true, ['secret'], 0.5); market.heartbeat(users[1]); const o = await paid(); await action(users[1], o, 'accept', { offerId: offer(o).id });
      await assert.rejects(action(users[0], o, 'start'), { status: 409 }); await action(users[0], o, 'declineKd'); market.heartbeat(users[1]); assert.equal(offer(o), undefined);
      await saveProfile(users[2]); market.heartbeat(users[2]); assert.equal(offer(o).user_id, users[2].id); await action(users[2], o, 'accept', { offerId: offer(o).id }); await complete(o, users[2]); await reset();
    });
    await t.test('自接、装备不符及未支付订单不进入派单；关键变更保留原因与审计', async () => {
      await saveProfile(users[0]); market.heartbeat(users[0]); const o = await paid(); assert.equal(offer(o), undefined);
      await saveProfile(users[1]); const p = market.profile(users[1].id); p.stats.secret.gear = 3;
      database.prepare('UPDATE provider_profiles SET payload=? WHERE user_id=?').run(JSON.stringify(p), users[1].id); market.heartbeat(users[1]); assert.equal(offer(o), undefined); await cancel(o);
      const pending = (await call(users[0], 'create', { mode: 'secret', rulesAccepted: true })).order; market.dispatch(); assert.equal(offer(pending), undefined); await cancel(pending);
      assert.ok(database.prepare("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'dispatch_%' AND length(reason)>0").get().n > 0);
      assert.throws(() => createMarket(database, providers, { offerMs: 0 }));
    });
  } finally {
    providers?.close(); database?.close();
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'delta-dispatch-')) throw Error('测试清理路径无效');
    rmSync(directory, { recursive: true, force: true });
  }
});
