import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/security-ui.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
async function renderRecovery(eligible) {
  const errors = [];
  const form = { querySelector: () => ({}), querySelectorAll: () => [] };
  const panel = { querySelector: () => form };
  const root = { innerHTML: '', querySelector: selector => ['[data-password-change]', '#security-factor'].includes(selector) ? panel : {}, querySelectorAll: () => [], replaceChildren() {}, append() {} };
  vm.runInNewContext(source, {
    document: { querySelector: () => root, addEventListener() {}, createElement: () => ({}) },
    window: { addEventListener() {} }, BroadcastChannel: undefined,
    location: { href: 'http://local.test/account.html' }, URL, Date,
    api: async () => ({ sessions: [], twoFactorEnabled: false, emailRecoveryEligible: eligible }),
    esc: String, showError: error => errors.push(error), mountPrivacyCopy() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 0);
  return root.innerHTML;
}

test('手机号-only安全区不提供邮箱恢复，邮件账户保留原恢复路径，未知能力默认不开放', async () => {
  for (const value of [false, undefined]) {
    const html = await renderRecovery(value);
    assert.doesNotMatch(html, /href="\.\/recovery\.html"/);
    assert.match(html, /手机号密码找回暂未开放/);
    assert.match(html, /模拟验证码不能重置已有密码/);
  }
  const email = await renderRecovery(true);
  assert.match(email, /href="\.\/recovery\.html"/);
  assert.match(email, /当前为私有测试邮件/);
  assert.doesNotMatch(email, /手机号密码找回暂未开放/);
});
