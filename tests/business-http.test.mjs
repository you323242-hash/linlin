import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

test('浏览器所用真实业务 HTTP API 与跨用户完整闭环', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-business-http-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child, database, logs = '';
  async function start() {
    child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../server/index.mjs')], { env: { ...process.env, PORT: String(port), BETTER_AUTH_URL: base, AUTH_DATA_DIR: directory, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', value => logs += value.toString());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('启动超时')), 15000);
      child.stdout.on('data', value => { if (value.toString().includes('已启动')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('启动失败 ' + code)); });
    });
    database = new DatabaseSync(path.join(directory, 'auth.sqlite'));
  }
  async function stop() { database?.close(); database = null; if (child?.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); }
  async function req(route, user, body, origin = base) {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { ...(user ? { Cookie: user.cookie } : {}), ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ') };
  }
  const post = (route, user, fields) => req(route, user, { ...fields, requestId: randomUUID() });
  const action = async (o, user, name, fields = {}) => {
    const latest = name === 'accept' ? o : (await req('/api/orders/' + o.id, user)).data.order;
    const invitation = name === 'accept' ? (await req('/api/queue', user)).data.orders.find(q => q.id === o.id)?.offer : null;
    const result = await post(`/api/orders/${o.id}/actions/${name}`, user, { version: latest.version, ...(invitation ? { offerId: invitation.id } : {}), ...fields });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.order;
  };
  const users = []; let order, attachment;
  try {
    await start();
    for (let i = 0; i < 4; i++) {
      const result = await req('/api/auth/sign-up/email', null, { name: `HTTP测试${i}`, email: `http${i}@example.test`, password: 'Http-local-password!', termsAccepted: true });
      assert.equal(result.status, 200); users.push({ ...result.data.user, cookie: result.cookie });
    }
    database.prepare("UPDATE user SET role='admin' WHERE id=?").run(users[3].id);
    await t.test('渠道状态、后台权限及未接入支付回调拒绝；不生成支付任务', async () => {
      const before = database.prepare('SELECT count(*) n FROM payment_jobs').get().n;
      const publicView = await req('/api/integrations');
      assert.equal(publicView.status, 200); assert.equal(publicView.data.realMoneyEnabled, false);
      assert.equal(publicView.data.login.phone.enabled, false);
      assert.equal((await req('/api/admin/integrations')).status, 401);
      assert.equal((await req('/api/admin/integrations', users[0])).status, 403);
      const admin = await req('/api/admin/integrations', users[3]);
      assert.equal(admin.status, 200); assert.equal(admin.data.credentialsValidated, false);
      for (const provider of ['wechat', 'alipay']) {
        const forged = await req('/api/payment-callbacks/' + provider, null, { verified: true, amountCents: 1088, status: 'SUCCESS' });
        assert.equal(forged.status, 503); assert.equal(forged.data.code, 'CHANNEL_NOT_READY');
        assert.equal((await req('/api/payment-callbacks/' + provider)).status, 405);
      }
      assert.equal(database.prepare('SELECT count(*) n FROM payment_jobs').get().n, before);
    });
    await t.test('超限业务JSON关闭连接，下一请求新建连接正常读取', async () => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const probe = (route, body) => new Promise((resolve, reject) => {
        const request = http.request(base + route, { agent, method: body ? 'POST' : 'GET', headers: { Cookie: users[0].cookie, ...(body ? { Origin: base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 5000 }, response => {
          response.resume(); response.on('end', () => resolve({ status: response.statusCode, connection: response.headers.connection, reused: request.reusedSocket }));
        });
        request.on('error', reject); request.on('timeout', () => request.destroy(new Error('连接恢复超时'))); request.end(body);
      });
      try {
        const oversized = await probe('/api/orders/DF00000000000000000000/actions/message', 'x'.repeat(204800));
        assert.equal(oversized.status, 413); assert.equal(oversized.connection, 'close');
        const recovered = await probe('/api/health'); assert.equal(recovered.status, 200); assert.equal(recovered.reused, false);
      } finally { agent.destroy(); }
    });
    await t.test('匹配偏好API鉴权、本人隔离与非法标签', async () => {
      assert.equal((await req('/api/preferences')).status,401);
      assert.equal((await post('/api/preferences',users[0],{desiredTags:['<img>']})).status,400);
      assert.equal((await req('/api/preferences',users[0],{requestId:randomUUID(),desiredTags:['耐心沟通']},'https://untrusted.example')).status,403);
      const saved=await post('/api/preferences',users[0],{desiredTags:['耐心沟通'],matchNote:'轻松交流',preferTrial:true}); assert.equal(saved.status,200);
      assert.deepEqual((await req('/api/preferences',users[1])).data.preferences.desiredTags,[]);
      assert.deepEqual((await req('/api/preferences',users[0])).data.preferences.desiredTags,['耐心沟通']);
    });
    await t.test('未登录、越权、伪造 role、跨站请求都被拒绝', async () => {
      assert.equal((await req('/api/orders')).status, 401);
      assert.equal((await req('/api/admin', users[0])).status, 403);
      assert.equal((await fetch(base + '/admin.html', { redirect: 'manual' })).status, 303);
      assert.equal((await fetch(base + '/admin.html', { headers: { Cookie: users[0].cookie } })).status, 403);
      assert.equal((await fetch(base + '/api/orders', { method: 'POST', headers: { Cookie: users[0].cookie, Origin: base, 'Content-Type': 'application/json' }, body: '[]' })).status, 400);
      assert.equal((await fetch(base + '/api/orders', { method: 'POST', headers: { Cookie: users[0].cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ preference: 'x'.repeat(66000) }) })).status, 413);
      assert.equal((await post('/api/admin/product', users[0], { id: 'secret', role: 'admin', price: 1, status: 'available', reason: '客户端不能伪造管理员权限' })).status, 403);
      assert.equal((await req('/api/orders', users[0], { requestId: randomUUID(), mode: 'secret', rulesAccepted: true }, 'https://untrusted.example')).status, 403);
    });
    await t.test('真实用户直接保存服务资料并开启接单', async () => {
      const result = await post('/api/provider', users[1], { gameId: 'LOCAL-HTTP-TEST', introduction: '仅本地测试的服务者介绍', adult: true, modes: ['secret'], stats: { secret: { kd: 1.1, gear: 4 } }, available: true });
      assert.equal(result.status, 200); assert.equal(result.data.profile.state, 'available');
    });
    await t.test('下单与模拟支付持久化，越权访问拒绝且队列保护隐私', async () => {
      const result = await post('/api/orders', users[0], { mode: 'secret', rulesAccepted: true, price: 1, duration: 1 }); assert.equal(result.status, 200); order = result.data.order;
      assert.equal(order.price, 1088); assert.equal(order.duration, 3600);
      assert.equal((await req('/api/orders/' + order.id, users[2])).status, 404);
      order = await action(order, users[0], 'pay'); assert.equal(order.status, 'matching');
      const queue = (await req('/api/queue', users[1])).data.orders; assert.equal(queue.length, 1); assert.ok(!JSON.stringify(queue).includes(users[0].id));
      order = await action(order, users[1], 'accept'); assert.equal(order.providerId, users[1].id);
    });
    await t.test('双方开始、登记对局、尾局结束、双方确认与评价走通', async () => {
      order = await action(order, users[1], 'start'); assert.equal(order.runningSince, null);
      order = await action(order, users[0], 'start'); assert.equal(order.status, 'active');
      order = await action(order, users[1], 'beginRound');
      // Only the isolated test database changes time; there is no browser/API bypass.
      const row = database.prepare('SELECT payload FROM orders WHERE id=?').get(order.id); const payload = JSON.parse(row.payload); payload.runningSince = Date.now() - 3600001;
      database.prepare('UPDATE orders SET payload=?,version=version+1 WHERE id=?').run(JSON.stringify(payload), order.id);
      order = (await req('/api/orders/' + order.id, users[0])).data.order; assert.equal(order.status, 'finishing');
      order = await action(order, users[1], 'endRound', { result: 'success' });
      order = await action(order, users[0], 'confirmRound', { index: 0, agreed: true });
      order = await action(order, users[1], 'finish'); order = await action(order, users[0], 'finish'); assert.equal(order.status, 'completed');
      order = await action(order, users[0], 'review', { attitude: 5, communication: 5, experience: 4, text: '仅测试评价持久化' }); assert.equal(order.review.experience, 4);
    });
    await t.test('已完成订单仍可售后，重复接受拒绝且双方同意后恢复完成', async () => {
      order = await action(order, users[0], 'request', { kind: 'complaint', description: '仅测试已完成订单售后不被前端遗漏。' });
      assert.equal(order.status, 'completed'); assert.equal(order.case.stage, 'human');
      assert.ok((await req('/api/admin', users[3])).data.cases.some(o => o.id === order.id));
      order = await action(order, users[3], 'proposeCase', { outcome: 'resume', reason: '仅测试双方同意后恢复完成，不涉及退款。' });
      order = await action(order, users[0], 'acceptCase');
      const version = order.version;
      assert.equal((await post(`/api/orders/${order.id}/actions/acceptCase`, users[0], { version })).status, 409);
      assert.equal((await req('/api/orders/' + order.id, users[0])).data.order.version, version);
      order = await action(order, users[1], 'acceptCase');
      assert.equal(order.case.stage, 'closed'); assert.equal(order.status, 'completed');
      assert.equal(order.payment.refunded, 0); assert.equal(order.review.experience, 4);
    });
    await t.test('协商取消与站内消息真实HTTP连通，拒绝陌生用户消息操作', async () => {
      let c = (await post('/api/orders', users[0], { mode: 'secret', rulesAccepted: true })).data.order; c = await action(c, users[0], 'pay'); c = await action(c, users[1], 'accept');
      c = await action(c, users[0], 'requestCancel', { reason: '仅测试未开始的初次服务，经双方同意取消' });
      c = await action(c, users[1], 'respondCancel', { agreed: true }); assert.equal(c.payment.refunded, 1088);
      assert.equal((await req('/api/notifications')).status, 401);
      assert.equal((await req('/api/notifications?summary=1')).status, 401);
      const summary = (await req('/api/notifications?summary=1', users[0])).data;
      assert.deepEqual(Object.keys(summary), ['unread']);
      assert.equal(summary.unread, (await req('/api/notifications', users[0])).data.unread);
      const n = (await req('/api/notifications', users[0])).data.notifications[0]; assert.equal(n.role, 'buyer');
      assert.equal((await req('/api/notifications', users[2], { id: n.id })).status, 404);
      assert.equal((await req('/api/notifications', users[0], { id: n.id }, 'https://untrusted.example')).status, 403);
      assert.equal((await req('/api/notifications', users[0], { id: n.id })).status, 200);
    });
    await t.test('在线接口验证权限和Origin，派单邀请只向本人开放；取消即撤回', async () => {
      assert.equal((await req('/api/provider/presence', null, {})).status, 401);
      assert.equal((await req('/api/provider/presence', users[1], {}, 'https://untrusted.example')).status, 403);
      assert.equal((await req('/api/provider/presence', users[2], {})).status, 409);
      assert.equal((await req('/api/provider/presence', users[1], { userId: users[2].id })).status, 200);
      let invited = (await post('/api/orders', users[0], { mode: 'secret', rulesAccepted: true })).data.order;
      invited = await action(invited, users[0], 'pay');
      const offer = (await req('/api/queue', users[1])).data.orders.find(q => q.id === invited.id).offer; assert.ok(offer.id);
      assert.equal((await post(`/api/orders/${invited.id}/actions/accept`, users[1], {})).status, 409);
      assert.equal((await post(`/api/orders/${invited.id}/actions/accept`, users[2], { offerId: offer.id })).status, 409);
      await action(invited, users[0], 'cancel');
      assert.equal((await req('/api/queue', users[1])).data.orders.some(q => q.id === invited.id), false);
      assert.equal((await post(`/api/orders/${invited.id}/actions/accept`, users[1], { offerId: offer.id })).status, 409);
    });
    await t.test('客诉提交、举证、管理方案、双方接受及模拟退款走通', async () => {
      let c = (await post('/api/orders', users[0], { mode: 'secret', rulesAccepted: true })).data.order;
      c = await action(c, users[0], 'pay'); c = await action(c, users[1], 'accept'); c = await action(c, users[1], 'start'); c = await action(c, users[0], 'start');
      c = await action(c, users[0], 'request', { kind: 'service', description: '仅验收：提交服务质量问题说明', evidence: '仅测试的聊天记录材料摘要' }); assert.equal(c.case.stage, 'human');
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrxkAAAAASUVORK5CYII=', 'base64');
      const route = `/api/orders/${c.id}/cases/${c.case.id}/attachments`;
      const headers = { Cookie: users[0].cookie, Origin: base, 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('仅测试截图.png'), 'X-Upload-Id': randomUUID() };
      assert.equal((await fetch(base + route, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: bytes })).status, 403);
      assert.equal((await fetch(base + route, { method: 'POST', headers: { ...headers, Cookie: users[2].cookie }, body: bytes })).status, 404);
      assert.equal((await fetch(base + route, { method: 'POST', headers, body: Buffer.alloc(5 * 1024 * 1024 + 1) })).status, 413);
      const uploaded = await fetch(base + route, { method: 'POST', headers, body: bytes }); assert.equal(uploaded.status, 200); attachment = (await uploaded.json()).file;
      assert.equal((await (await fetch(base + route, { method: 'POST', headers, body: bytes })).json()).file.id, attachment.id);
      assert.equal((await fetch(base + attachment.url)).status, 401);
      assert.equal((await fetch(base + attachment.url, { headers: { Cookie: users[2].cookie } })).status, 404);
      const download = await fetch(base + attachment.url, { headers: { Cookie: users[1].cookie } });
      assert.equal(download.headers.get('content-type'), 'image/png'); assert.equal(download.headers.get('cache-control'), 'no-store'); assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      assert.equal((await req(route, users[3])).data.files.length, 1);
      c = await action(c, users[1], 'supplement', { description: '仅验收：服务者补充自己的说明' });
      const admin = await req('/api/admin', users[3]); assert.equal(admin.status, 200); assert.equal(admin.data.cases.length, 1);
      assert.equal((await post('/api/orders/'+c.id+'/actions/requestMaterials',users[0],{version:c.version,forRole:'buyer',reason:'普通用户不能要求另一方补充证据'})).status,403);
      assert.equal((await req('/api/orders/'+c.id+'/actions/requestMaterials',users[3],{version:c.version,requestId:randomUUID(),forRole:'buyer',reason:'外站请求不得写入管理员补证要求'},'https://untrusted.example')).status,403);
      c = await action(c, users[3], 'requestMaterials', {forRole:'buyer',reason:'仅测试：请补充问题发生时间与相关经过'});
      const materialId=c.case.materialRequests[0].id;
      c = await action(c,users[0],'supplement',{description:'仅测试：补充服务质量问题发生的详细经过',answeredMaterialRequestId:materialId});
      assert.ok(c.case.materialRequests[0].respondedAt);
      c = await action(c, users[3], 'proposeCase', { outcome: 'refund', reason: '仅测试：人工核实后提出处理方案' });
      c = await action(c, users[0], 'acceptCase'); assert.equal(c.payment.refunded, 0);
      c = await action(c, users[1], 'acceptCase'); assert.equal(c.payment.refunded, 1088); assert.equal(c.case.stage, 'closed');
    });
    await t.test('重启后原用户会话、订单、评价、材料与审计仍保持', async () => {
      await stop(); await start();
      const restored = await req('/api/orders/' + order.id, users[0]); assert.equal(restored.status, 200); assert.equal(restored.data.order.review.text, '仅测试评价持久化');
      const admin = await req('/api/admin', users[3]); assert.ok(admin.data.audit.length > 10); assert.ok(admin.data.aftercareMetrics.closedSamples>=1); assert.ok(admin.data.aftercareMetrics.humanActions>=2);
      assert.equal((await fetch(base + attachment.url, { headers: { Cookie: users[0].cookie } })).status, 200);
      assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(logs, '');
    });
  } finally { await stop(); assert.ok(directory.startsWith(path.join(tmpdir(), 'delta-business-http-'))); rmSync(directory, { recursive: true, force: true }); }
});
