import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { createMarket } from '../server/market.mjs';
import { createEvidence, FILE_LIMIT } from '../server/evidence.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrxkAAAAASUVORK5CYII=', 'base64');
function wave(size = 48) {
  const b = Buffer.alloc(size); b.write('RIFF'); b.writeUInt32LE(size - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size - 44, 40); return b;
}
test('本地私有售后附件、权限和持久化', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-evidence-'));
  let database, providers, market, evidence, users = [], order, screenshot, buyerFile;
  async function setup() {
    const result = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: directory }); database = result.database;
    providers = createLocalProviders({ directory, storageMaxBytes: FILE_LIMIT }); market = createMarket(database, providers); evidence = createEvidence(database, market, providers.storage); return result.auth;
  }
  const call = (user, scope, body = {}) => market.command(user, scope, { ...body, requestId: randomUUID() });
  const action = async (user, name, fields = {}) => { order = (await call(user, `${order.id}:${name}`, { version: name === 'accept' ? order.version : market.readOrder(order.id, user).version, ...fields })).order; return order; };
  const upload = (user, fields = {}) => evidence.upload(user, order.id, order.case.id, { name: '测试截图.png', requestId: randomUUID(), content: png, mime: 'image/png', ...fields });
  async function openCase() { await action(users[0], 'request', { kind: 'complaint', description: '仅测试售后材料保存，不涉及真实争议。' }); }
  try {
    const auth = await setup();
    for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `附件测试${i}`, email: `evidence${i}@example.test`, password: 'Evidence-local-password!', termsAccepted: true } })).user);
    users[3].role = 'admin'; database.prepare("UPDATE user SET role='admin' WHERE id=?").run(users[3].id);
    for (const user of [users[1], users[2]]) await call(user, 'profile', { adult: true, gameId: 'TEST-' + user.name, introduction: '仅本机附件权限验收测试', modes: ['secret'], stats: { secret: { kd: 1, gear: 4 } }, available: true });
    order = (await call(users[0], 'create', { mode: 'secret', rulesAccepted: true })).order;
    await action(users[0], 'pay'); await action(users[1], 'accept'); await action(users[1], 'start'); await action(users[0], 'start'); await openCase();
    await t.test('PNG和WAV真实存储，元数据不暴露私有路径；重复上传只保留一份', async () => {
      const oldVersion = market.readOrder(order.id, users[1]).version;
      const requestId = randomUUID(); screenshot = await upload(users[1], { requestId, summary: '服务者提交的测试截图' });
      assert.equal(screenshot.orderVersion, oldVersion + 1);
      assert.equal((await upload(users[1], { requestId, summary: '服务者提交的测试截图' })).id, screenshot.id);
      assert.equal(market.readOrder(order.id, users[1]).version, screenshot.orderVersion);
      await assert.rejects(upload(users[1], { requestId, name: '不同文件名.png', summary: '服务者提交的测试截图' }), { status: 409 });
      buyerFile = await upload(users[0], { name: '测试录音.wav', mime: 'audio/wav', content: wave() });
      assert.equal(evidence.list(users[0], order.id, order.case.id).length, 2);
      assert.ok(!('storage_key' in screenshot)); assert.ok(!('uploader_id' in screenshot));
      assert.deepEqual((await evidence.download(users[3], screenshot.id)).content, png);
    });
    await t.test('拒绝陌生用户、错误售后、管理员冒充提交者；未写入存储', async () => {
      const before = providers.health().operations;
      await assert.rejects(upload(users[2]), { status: 404 }); await assert.rejects(upload(users[3]), { status: 409 });
      assert.throws(() => evidence.list(users[0], order.id, randomUUID()), { status: 404 });
      await assert.rejects(evidence.download(users[2], screenshot.id), { status: 404 });
      assert.equal(providers.health().operations, before);
    });
    await t.test('文件名、后缀、签名、声明类型、空文件与大小均由服务端检查', async () => {
      const before = providers.health().operations;
      for (const name of ['../a.png', 'evil:stream.png', 'a.svg', 'a.html', '.hidden.png', 'a.exe.png']) {
        if (name === 'a.exe.png') await assert.rejects(upload(users[0], { name, content: Buffer.from('MZ executable') }), { status: 415 });
        else await assert.rejects(upload(users[0], { name }));
      }
      await assert.rejects(upload(users[0], { content: Buffer.from('<html>fake PNG</html>') }), { status: 415 });
      await assert.rejects(upload(users[0], { mime: 'audio/wav' }), { status: 415 });
      const hugeImage = Buffer.from(png); hugeImage.writeUInt32BE(100000, 16); hugeImage.writeUInt32BE(100000, 20);
      await assert.rejects(upload(users[0], { content: hugeImage }), { status: 415 });
      await assert.rejects(upload(users[0], { content: Buffer.alloc(0) }), { status: 413 });
      await assert.rejects(upload(users[0], { content: Buffer.alloc(FILE_LIMIT + 1) }), { status: 413 });
      assert.equal(providers.health().operations, before);
    });
    await t.test('数据库与存储重启后，附件、原始字节和审计保持', async () => {
      providers.close(); database.close(); await setup();
      assert.deepEqual((await evidence.download(users[0], screenshot.id)).content, png);
      assert.equal(evidence.list(users[3], order.id, order.case.id).length, 2);
      assert.ok(database.prepare("SELECT count(*) AS n FROM audit_events WHERE action='evidence_uploaded'").get().n >= 2);
    });
    await t.test('缺失或被改写的文件不能冒充原始附件', async () => {
      const row = database.prepare('SELECT storage_key FROM evidence_files WHERE id=?').get(screenshot.id);
      const filename = path.join(directory, 'storage', row.storage_key), original = readFileSync(filename);
      writeFileSync(filename, Buffer.from('tampered')); await assert.rejects(evidence.download(users[0], screenshot.id), { status: 409 }); writeFileSync(filename, original);
    });
    await t.test('新附件使旧处理版本失效；方案确认期间先异议再补交', async () => {
      const oldVersion = market.readOrder(order.id, users[3]).version;
      await upload(users[0]);
      await assert.rejects(call(users[3], `${order.id}:proposeCase`, { version: oldVersion, outcome: 'resume', reason: '测试旧版本不能忽略新提交的附件' }), { status: 409 });
      await action(users[3], 'proposeCase', { outcome: 'resume', reason: '仅测试方案确认期间材料保持一致' });
      const before = providers.health().operations;
      await assert.rejects(upload(users[0]), { status: 409 });
      await assert.rejects(action(users[0], 'supplement', { description: '新增说明应先提出异议再补交材料' }), { status: 409 });
      assert.equal(providers.health().operations, before);
      await action(users[0], 'appealCase', { description: '仅测试新材料触发异议后继续补充流程' });
      await upload(users[0]);
      assert.equal(market.readOrder(order.id, users[0]).case.stage, 'appeal');
    });
    await t.test('换出服务者仅保留自己的旧材料，不能看后续材料或上传', async () => {
      const oldCase = order.case.id;
      await action(users[3], 'proposeCase', { outcome: 'replace', reason: '仅测试人工换人，保留剩余时长与材料边界' });
      await action(users[0], 'acceptCase'); await action(users[1], 'acceptCase');
      assert.deepEqual(evidence.list(users[1], order.id, oldCase).map(f => f.id), [screenshot.id]);
      await assert.rejects(evidence.download(users[1], buyerFile.id), { status: 404 });
      await action(users[2], 'accept'); await action(users[2], 'start'); await action(users[0], 'start'); await openCase();
      const later = await upload(users[0]); await assert.rejects(evidence.download(users[1], later.id), { status: 404 }); await assert.rejects(upload(users[1]), { status: 404 });
    });
    await t.test('单个售后总大小与附件数量限额均生效', async () => {
      // New independent case: use time restoration to close the current one, then file quotas.
      await action(users[3], 'proposeCase', { outcome: 'resume', reason: '仅测试材料数量限额前的流程恢复操作' }); await action(users[0], 'acceptCase'); await action(users[2], 'acceptCase'); await openCase();
      for (let i = 0; i < 2; i++) await upload(users[0], { name: `容量${i}.wav`, content: wave(FILE_LIMIT), mime: 'audio/wav' });
      await assert.rejects(upload(users[0]), { status: 413 });
      for (let i = 0; i < 2; i++) await upload(users[2], { name: `对方容量${i}.wav`, content: wave(FILE_LIMIT), mime: 'audio/wav' });
      await assert.rejects(upload(users[0]), { status: 413 });
      await action(users[3], 'proposeCase', { outcome: 'resume', reason: '仅测试下一组附件数量限额的流程恢复' }); await action(users[0], 'acceptCase'); await action(users[2], 'acceptCase'); await openCase();
      for (let i = 0; i < 5; i++) await upload(users[0], { name: `数量${i}.png` });
      await assert.rejects(upload(users[0]), { status: 413 });
      for (let i = 0; i < 5; i++) await upload(users[2], { name: `对方数量${i}.png` });
      await assert.rejects(upload(users[0]), { status: 413 });
    });
    await t.test('售后关闭后只能查看已存附件，禁止继续补交', async () => {
      const c = order.case.id, before = evidence.list(users[0], order.id, c);
      await action(users[3], 'proposeCase', { outcome: 'resume', reason: '仅测试已处理售后不能再添加原始附件' }); await action(users[0], 'acceptCase'); await action(users[2], 'acceptCase');
      assert.equal(evidence.list(users[0], order.id, c).length, before.length);
      await assert.rejects(upload(users[0]), { status: 409 });
    });
  } finally {
    providers?.close(); database?.close();
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'delta-evidence-')) throw new Error('测试清理路径无效');
    rmSync(directory, { recursive: true, force: true });
  }
});
