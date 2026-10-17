import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createMarket } from '../server/market.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';

test('真实数据库业务闭环与权限、退款和恢复', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-market-'));
  let database, providers, market;
  let clock = Date.now();
  const setup = async () => {
    const auth = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: directory }); database = auth.database;
    providers = createLocalProviders({ directory }); market = createMarket(database, providers, { now: () => clock }); return auth.auth;
  };
  const users = [];
  const call = (user, scope, fields = {}) => market.command(user, scope, { ...fields, requestId: fields.requestId || randomUUID() });
  const change = async (order, user, action, fields = {}) => (await call(user, `${order.id}:${action}`, { version: action === 'accept' ? order.version : market.readOrder(order.id, user).version, ...fields })).order;
  const profile = user => call(user, 'profile', { adult: true, gameId: 'LOCAL-' + user.name, introduction: '正常语音交流，配合团队行动', modes: ['secret', 'topsecret'], stats: { secret: { kd: 1.4, gear: 4 }, topsecret: { kd: .8, gear: 5 } }, available: true });
  const create = async mode => (await call(users[0], 'create', { mode, rulesAccepted: true, price: 1, duration: 1 })).order;
  const paid = async mode => change(await create(mode), users[0], 'pay');
  const accept = async (o, user = users[1]) => change(o, user, 'accept');
  const start = async (o, consent = true) => { await change(o, users[1], 'start'); return change(o, users[0], 'start', { acceptLowKd: consent }); };
  let order;
  try {
    const auth = await setup();
    for (let i = 0; i < 4; i++) {
      const result = await auth.api.signUpEmail({ body: { name: `测试${i}`, email: `market${i}@example.test`, password: 'Market-local-password!', termsAccepted: true } }); users.push(result.user);
    }
    users[3].role = 'admin'; database.prepare('UPDATE user SET role=? WHERE id=?').run('admin', users[3].id);
    await t.test('资料直接保存，无审批；装备不合格和伪造管理权限拒绝', async () => {
      await assert.rejects(call(users[1], 'profile', { adult: false }), /18/);
      await assert.rejects(call(users[1], 'profile', { adult: true, gameId: 'LOW-GEAR', introduction: '测试装备不能满足服务要求', modes: ['secret'], stats: { secret: { kd: 1, gear: 3 } }, available: true }), /装备/);
      for (const stats of [{secret:{gear:4}},{secret:{kd:1}},{secret:{kd:'',gear:4}},{secret:{kd:null,gear:4}}]) {
        await assert.rejects(call(users[1],'profile',{adult:true,gameId:'MISSING-STATS',introduction:'验证后端拒绝未填写或非数字的资料',modes:['secret'],stats}),error=>error.status===400);
      }
      await profile(users[1]); await profile(users[2]);
      assert.equal(market.profile(users[1].id).state, 'available');
      await assert.rejects(call(users[1], 'admin:suspend', { userId: users[2].id, suspended: true, reason: '测试原因内容满足最低长度' }), /管理员/);
    });
    await t.test('建单金额与时长由服务器确定，重复请求只创建一单', async () => {
      const fields = { mode: 'secret', rulesAccepted: true, requestId: randomUUID(), price: 1, duration: 1 };
      const first = await call(users[0], 'create', fields), second = await call(users[0], 'create', fields);
      assert.equal(first.order.id, second.order.id); assert.equal(first.order.price, 1088); assert.equal(first.order.duration, 3600);
      await assert.rejects(call(users[0], 'create', { ...fields, mode: 'topsecret' }), /不一致/);
      order = first.order;
    });
    await t.test('模拟支付幂等，陌生用户无订单权限；队列不泄漏私密资料', async () => {
      await assert.rejects(change(order, users[2], 'pay'), /无权/);
      order = await change(order, users[0], 'pay'); assert.equal(order.status, 'matching'); assert.equal(order.payment.simulated, true);
      const queued = market.queue(users[1])[0]; assert.ok(!('buyerId' in queued)); assert.equal(queued.customer, '消费者');
      await assert.rejects(change(order, users[0], 'accept'), /自己/);
    });
    await t.test('两人并发接同一单只能一人成功，身份切换不能冒充消费者', async () => {
      const results = await Promise.allSettled([accept(order, users[1]), accept(order, users[2])]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); order = results.find(r => r.status === 'fulfilled').value;
      assert.equal(order.providerId, users[1].id);
      assert.ok(!('receiptId' in order.payment));
      assert.ok(market.readOrder(order.id,users[0]).payment.receiptId);
      assert.ok(!('receiptId' in market.list(users[1],'provider')[0].payment));
      assert.ok(!('receiptId' in market.readOrder(order.id,users[1]).payment));
      await assert.rejects(change(order, users[2], 'start'), /无权/);
      assert.equal(market.queue(users[1]).length, 0);
    });
    await t.test('双方确认后才计时，自报结果须消费者确认', async () => {
      order = await change(order, users[1], 'start'); assert.equal(order.runningSince, null);
      order = await change(order, users[0], 'start'); assert.equal(order.status, 'active');
      order = await change(order, users[1], 'beginRound'); clock += 300000;
      await assert.rejects(change(order, users[1], 'endRound', {result:''}), /有效结果/);
      order = await change(order, users[1], 'endRound', { result: 'failed' }); assert.equal(order.rounds[0].normal, false);
      await assert.rejects(change(order, users[0], 'firstSwap'), /条件/);
      order = await change(order, users[0], 'confirmRound', { index: 0, agreed: true }); assert.equal(order.rounds[0].normal, true);
    });
    await t.test('已登记消息与订单跨数据库关闭重启恢复', async () => {
      order = await change(order, users[0], 'message', { text: '请正常配合，消息应该能恢复' });
      providers.close(); database.close(); await setup();
      order = market.readOrder(order.id, users[0]); assert.equal(order.messages[0].text, '请正常配合，消息应该能恢复'); assert.equal(order.status, 'active');
      assert.equal(order.events.find(e=>e.label==='订单创建，商品与规则版本已保存').actorRole,'buyer');
      assert.equal(order.events.find(e=>e.label==='模拟支付成功，等待接单（无真实扣款）').actorRole,'system');
      assert.deepEqual(order.events.filter(e=>e.label==='确认开始服务').map(e=>e.actorRole),['provider','buyer']);
    });
    await t.test('时长到期只完成已有尾局，禁止提前结束或再开一局', async () => {
      await assert.rejects(change(order, users[0], 'finish'), /时长/);
      order = await change(order, users[1], 'beginRound'); clock += 3600000;
      order = market.readOrder(order.id, users[0]); assert.equal(order.status, 'finishing');
      await assert.rejects(change(order, users[1], 'beginRound'), /对局/);
      order = await change(order, users[1], 'endRound', { result: 'success' }); assert.equal(order.status, 'confirming');
      await assert.rejects(change(order,users[1],'finish'), /核对/);
      order = await change(order, users[0], 'confirmRound', { index: 1, agreed: true });
      order = await change(order, users[1], 'finish'); assert.equal(order.status, 'confirming');
      order = await change(order, users[0], 'finish'); assert.equal(order.status, 'completed');
    });
    await t.test('完成后可评价一次，未完成及陌生用户无法评价', async () => {
      await assert.rejects(change(order, users[0], 'review', {communication:4,experience:5}),error=>error.status===409&&/评分无效/.test(error.message));
      await assert.rejects(change(order, users[0], 'review', {attitude:0,communication:4,experience:5}),error=>error.status===409&&/评分无效/.test(error.message));
      order = await change(order, users[0], 'review', { attitude: 5, communication: 4, experience: 5, text: '配合良好' }); assert.equal(order.review.text, '配合良好');
      await assert.rejects(change(order, users[0], 'review', { attitude: 5, communication: 5, experience: 5 }), /已提交/);
    });
    await t.test('商品下架阻止新订单，旧订单快照不随调价变化', async () => {
      await call(users[3], 'admin:product', { id: 'secret', price: 1388, status: 'offline', reason: '测试下架和历史订单价格隔离' });
      await assert.rejects(create('secret'), /下架/);
      assert.equal(market.readOrder(order.id, users[0]).snapshot.price, 1088);
      await call(users[3], 'admin:product', { id: 'secret', price: 1088, status: 'available', reason: '测试恢复原价与商品可售状态' });
    });
    await t.test('低 KD 披露需消费者明确同意，拒绝时免费更换', async () => {
      let low = await accept(await paid('topsecret'));
      await change(low, users[1], 'start'); await assert.rejects(change(low, users[0], 'start'), /KD/);
      low = await change(low, users[0], 'declineKd'); assert.equal(low.status, 'matching'); assert.equal(low.elapsed, 0);
      low = await change(low, users[0], 'cancel'); assert.equal(low.payment.refunded, 2088);
    });
    await t.test('首局换人只一次、重新计满时长、原服务者不再接回', async () => {
      let swap = await start(await accept(await paid('secret')));
      swap = await change(swap, users[1], 'beginRound'); clock += 600000;
      swap = await change(swap, users[1], 'endRound', { result: 'failed' }); swap = await change(swap, users[0], 'confirmRound', { index: 0, agreed: true });
      swap = await change(swap, users[0], 'firstSwap'); assert.equal(swap.elapsed, 0); assert.equal(swap.firstSwapUsed, true);
      const history = market.readOrder(swap.id, users[1]); assert.equal(history.readOnly, true); assert.equal(history.status, 'released');
      assert.ok(!('receiptId' in history.payment));
      assert.ok(!('receiptId' in market.list(users[1],'provider').find(o=>o.id===swap.id).payment));
      await assert.rejects(accept(swap, users[1]), /接单条件/);
      swap = await accept(swap, users[2]); await change(swap, users[2], 'start'); swap = await change(swap, users[0], 'start');
      swap = await change(swap, users[0], 'request', { kind: 'serious', description: '测试严重服务违规申请与双方核实' });
      swap = await change(swap, users[3], 'proposeCase', { outcome: 'refund', reason: '仅测试核实严重问题处理方案说明' });
      swap = await change(swap, users[0], 'acceptCase'); swap = await change(swap, users[2], 'acceptCase'); assert.equal(swap.payment.refunded, 1088);
    });
    await t.test('首局换人等待期间消费者取消全额退，旧服务者无权且不能重复退款', async () => {
      let waiting = await start(await accept(await paid('secret')));
      waiting = await change(waiting, users[1], 'beginRound'); clock += 600000;
      waiting = await change(waiting, users[1], 'endRound', { result: 'failed' });
      waiting = await change(waiting, users[0], 'confirmRound', { index: 0, agreed: true });
      waiting = await change(waiting, users[0], 'firstSwap');
      const oldSnapshot = waiting.snapshot;
      await assert.rejects(change(waiting, users[1], 'cancel'));
      const fields = { version: waiting.version, requestId: randomUUID() };
      const first = await call(users[0], waiting.id + ':cancel', fields);
      const again = await call(users[0], waiting.id + ':cancel', fields);
      assert.equal(first.order.status, 'cancelled'); assert.equal(first.order.payment.refunded, 1088);
      assert.deepEqual(first, again); assert.deepEqual(first.order.snapshot, oldSnapshot);
      assert.equal(first.order.cancelRuleVersion, '2026-10-01-preview');
      await assert.rejects(change(first.order, users[0], 'cancel'));
      assert.equal(database.prepare("SELECT count(*) AS n FROM payment_jobs WHERE order_id=? AND action='refund'").get(waiting.id).n, 1);
      await assert.rejects(accept(first.order, users[2]));
    });
    await t.test('服务质量投诉不自动处罚；前半小时退款需核实及双方接受', async () => {
      let c = await start(await accept(await paid('secret'))); clock += 600000;
      c = await change(c, users[0], 'request', { kind: 'service', description: '服务沟通长时间无响应，请人工核实', evidence: '聊天记录发生于服务第5分钟' });
      assert.equal(c.case.percent, 100); assert.equal(c.case.stage, 'human'); assert.equal(c.payment.refunded, 0);
      await assert.rejects(change(c, users[1], 'proposeCase', { outcome: 'refund', reason: '服务者不能自己裁决退款金额' }), /管理员/);
      c = await change(c, users[1], 'supplement', { description: '补充自己的陈述供管理员核实判断' });
      c = await change(c, users[3], 'proposeCase', { outcome: 'refund', reason: '经双方资料核实为服务者责任' });
      c = await change(c, users[0], 'acceptCase'); assert.equal(c.payment.refunded, 0);
      c = await change(c, users[1], 'acceptCase'); assert.equal(c.payment.refunded, 1088); assert.equal(c.case.stage, 'closed');
      await assert.rejects(change(c, users[0], 'request', { kind: 'serious', description: '不允许同一订单退款重复叠加' }), /不重复/);
    });
    await t.test('达到30分钟按50%；异议转人工，不自动接受方案', async () => {
      let c = await start(await accept(await paid('secret'))); clock += 1800000;
      c = await change(c, users[0], 'request', { kind: 'service', description: '服务满半小时后发生态度问题' }); assert.equal(c.case.percent, 50);
      c = await change(c, users[3], 'proposeCase', { outcome: 'refund', reason: '按半小时边界提出退款方案' });
      c = await change(c, users[1], 'appealCase', { description: '不同意该处理，请重新人工核实' }); assert.equal(c.case.stage, 'appeal'); assert.equal(c.payment.refunded, 0);
      c = await change(c, users[3], 'proposeCase', { outcome: 'refund', final: true, reason: '申诉人工复核后确认责任与金额' }); assert.equal(c.payment.refunded, 544);
    });
    await t.test('暂停只禁止新接单，不影响消费；恢复必须管理权限与原因', async () => {
      await call(users[3], 'admin:suspend', { userId: users[1].id, suspended: true, reason: '测试核实后暂停新接单不封消费' });
      const p = await paid('secret'); await assert.rejects(accept(p), /条件/); assert.equal(market.queue(users[1]).length, 0);
      const own = (await call(users[1], 'create', { mode: 'secret', rulesAccepted: true })).order; assert.equal(own.buyerId, users[1].id);
      await call(users[3], 'admin:suspend', { userId: users[1].id, suspended: false, reason: '测试申诉核实后恢复接单能力' });
      await change(p, users[0], 'cancel');
    });
    await t.test('模拟支付异常任务持久化并能重启重试，不重复付款', async () => {
      const pay = providers.payment.createPayment; providers.payment.createPayment = async () => { throw new Error('test failure'); };
      let failed = await change(await create('secret'), users[0], 'pay'); assert.equal(failed.payment.status, 'processing');
      assert.ok(database.prepare("SELECT id FROM payment_jobs WHERE status='pending'").get());
      providers.payment.createPayment = pay; providers.close(); database.close(); await setup();
      await market.drainPayments(); assert.equal(market.readOrder(failed.id, users[0]).payment.status, 'processing');
      clock += 5000; await market.drainPayments();
      failed = market.readOrder(failed.id, users[0]); assert.equal(failed.status, 'matching');
      await market.drainPayments(); const receipt = await providers.payment.getPayment(failed.payment.receiptId); assert.equal(receipt.amountCents, 1088);
      assert.ok(market.adminData(users[3]).audit.length > 0);
      await change(failed, users[0], 'cancel');
    });
    await t.test('零撤离必须满一小时且双方确认对局，适用50%且不叠加', async () => {
      let zero = await start(await accept(await paid('secret')));
      await assert.rejects(change(zero, users[0], 'request', { kind: 'zero', description: '不足一小时不能提前申请零撤离退款' }), /一小时/);
      zero = await change(zero, users[1], 'beginRound'); zero = await change(zero, users[1], 'endRound', { result: 'failed' });
      clock += 3600000; zero = market.readOrder(zero.id, users[0]);
      await assert.rejects(change(zero, users[0], 'request', { kind: 'zero', description: '未确认自报记录不能直接触发保障' }), /双方确认/);
      zero = await change(zero, users[0], 'confirmRound', { index: 0, agreed: true });
      zero = await change(zero, users[0], 'request', { kind: 'zero', description: '完成一小时且双方确认未撤离，申请保障' }); assert.equal(zero.case.percent, 50);
      zero = await change(zero, users[3], 'proposeCase', { outcome: 'refund', reason: '已核对时长与双方确认的对局记录' });
      zero = await change(zero, users[0], 'acceptCase'); zero = await change(zero, users[1], 'acceptCase'); assert.equal(zero.payment.refunded, 544);
    });
    await t.test('时长异议由人工提出校正，双方接受后才更新计时', async () => {
      let timing = await start(await accept(await paid('secret'))); clock += 100000;
      timing = await change(timing, users[0], 'request', { kind: 'time', description: '平台计时期间有一分钟未实际服务，请核实' }); assert.equal(timing.elapsed, 100);
      timing = await change(timing, users[3], 'proposeCase', { outcome: 'adjustTime', deltaSeconds: -60, reason: '仅测试：核实双方陈述后补还一分钟' }); assert.equal(timing.elapsed, 100);
      timing = await change(timing, users[0], 'acceptCase'); timing = await change(timing, users[1], 'acceptCase'); assert.equal(timing.elapsed, 40); assert.equal(timing.status, 'active');
      // Consumer can report too; only the counterparty can confirm this record.
        timing = await change(timing, users[0], 'beginRound');
        await assert.rejects(change(timing, users[1], 'beginRound'), /不能开始/);
        timing = await change(timing, users[0], 'endRound', {result:'failed'});
        assert.equal(timing.rounds[0].reportedRole, 'buyer');
        await assert.rejects(change(timing, users[0], 'confirmRound', {index:0, agreed:true}), /另一方/);
        await assert.rejects(change(timing, users[0], 'firstSwap'), /条件/);
        await assert.rejects(change(timing, users[3], 'confirmRound', {index:0, agreed:true}), /另一方/);
        timing = await change(timing, users[1], 'confirmRound', {index:0, agreed:true});
        timing = await change(timing, users[0], 'firstSwap');
        assert.equal(timing.status,'matching'); assert.equal(timing.elapsed,0);
        timing = await change(timing, users[0], 'cancel');
        assert.equal(timing.payment.status,'refunded');
    });
  } finally {
    providers?.close(); database?.close(); assert.ok(directory.startsWith(path.join(tmpdir(), 'delta-market-'))); rmSync(directory, { recursive: true, force: true });
  }
});
