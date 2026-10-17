import test from 'node:test';
import assert from 'node:assert/strict';

test('登录状态异常与未登录分开，故障恢复不丢失身份判断', async t => {
  const saved = Object.fromEntries(['document', 'location', 'fetch', 'BroadcastChannel'].map(key => [key, globalThis[key]]));
  const elements = new Map();
  let destination = null;
  let reloads = 0;
  let retry;
  const workspace = { hidden: true, before: notice => elements.set('#auth-connection-error', notice) };
  elements.set('#account-workspace', workspace);
  elements.set('.profile-card h2', {}); elements.set('.workspace-preview', {});
  try {
    globalThis.BroadcastChannel = undefined;
    globalThis.location = { href: 'http://local.test/account.html?role=provider', search: '?role=provider', replace: url => { destination = url; }, reload: () => { reloads++; } };
    globalThis.document = {
      querySelector: selector => elements.get(selector), querySelectorAll: () => [],
      createElement: () => ({ querySelector: () => ({ addEventListener(event, callback) { retry = callback; } }), remove() { elements.delete('#' + this.id); } }),
    };
    const { refreshSession, accountPanel } = await import('../dist/auth-ui.js');
    const success = name => ({ ok: true, status: 200, json: async () => ({ user: { id: name, name, email: name + '@example.test' } }) });
    await t.test('确认有效身份后展示账户', async () => {
      globalThis.fetch = async () => success('甲'); await refreshSession();
      assert.equal(workspace.hidden, false); assert.match(accountPanel(), /已登录为/);
    });
    await t.test('网络、500与无效响应显示重试，不跳回登录或展示过期账户', async () => {
      for (const response of [() => { throw Error('offline'); }, () => ({ ok: false, status: 500 }), () => ({ ok: true, json: async () => ({}) })]) {
        globalThis.fetch = async () => response(); await refreshSession();
        assert.equal(destination, null); assert.equal(workspace.hidden, true);
        assert.match(accountPanel(), /暂时无法确认登录状态/); assert.doesNotMatch(accountPanel(), /已登录为|id="auth-form"/);
        assert.ok(elements.get('#auth-connection-error'));
      }
    });
    await t.test('恢复后清除故障提示，401才跳转登录且保留身份视角', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 500 }); await retry();
      assert.equal(reloads, 0);
      globalThis.fetch = async () => success('乙'); await retry();
      assert.equal(reloads, 1);
      assert.equal(workspace.hidden, false); assert.equal(elements.get('#auth-connection-error'), undefined);
      globalThis.fetch = async () => ({ ok: false, status: 401 }); await refreshSession();
      assert.equal(workspace.hidden, true); assert.match(accountPanel(), /id="auth-form"/);
      assert.equal(new URL(destination, 'http://local.test').searchParams.get('returnTo'), '/account.html?role=provider');
    });
    await t.test('迟到的旧请求不能覆盖最新身份或造成错误跳转', async () => {
      destination = null; let resolve;
      globalThis.fetch = () => new Promise(done => { resolve = done; });
      const old = refreshSession();
      globalThis.fetch = async () => success('最新身份'); await refreshSession();
      resolve({ ok: false, status: 401 }); await old;
      assert.equal(destination, null); assert.equal(workspace.hidden, false); assert.match(accountPanel(), /最新身份/);
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
