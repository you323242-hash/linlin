import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertIntegrationModes, integrationCapabilities, inspectIntegrationPreparation } from '../server/integrations.mjs';
import { localConfig } from '../server/config.mjs';

test('渠道模式不允许填密钥或开关直接启用真实登录/资金', () => {
  assert.doesNotThrow(() => assertIntegrationModes({}));
  for (const key of ['LOGIN_CHANNEL_MODE', 'PAYMENT_CHANNEL_MODE']) for (const value of ['live', 'true', 'wechat', 'sandbox', 'typo']) assert.throws(() => localConfig({ [key]: value }));
  assert.equal(integrationCapabilities().realMoneyEnabled, false);
});
test('公用能力表不包含私有路径、凭据或未实现的登录能力', () => {
  const view = integrationCapabilities();
  assert.equal(view.login.account.enabled, true);
  for (const key of ['phone', 'wechat', 'qq']) assert.equal(view.login[key].enabled, false);
  assert.equal(view.payment.callbacksEnabled, false);
  assert.equal(view.payment.withdrawalsEnabled, false);
});

test('预检能力与传入配置一致，不串用进程默认手机号模式', () => {
  const previous=process.env.AUTH_PHONE_MODE;
  try {
    process.env.AUTH_PHONE_MODE='disabled';
    const mock=inspectIntegrationPreparation({AUTH_PHONE_MODE:'mock'});
    assert.equal(mock.capabilities.login.phone.enabled,true);
    assert.equal(mock.capabilities.login.phone.mode,'private-mock-inbox');
    assert.equal(mock.capabilities.login.phone.realOwnershipVerified,false);
    process.env.AUTH_PHONE_MODE='mock';
    const disabled=inspectIntegrationPreparation({AUTH_PHONE_MODE:'disabled'});
    assert.equal(disabled.capabilities.login.phone.enabled,false);
    assert.equal(disabled.capabilities.realMoneyEnabled,false);
    assert.equal(disabled.credentialsValidated,false);
  }finally{if(previous===undefined)delete process.env.AUTH_PHONE_MODE;else process.env.AUTH_PHONE_MODE=previous;}
});
test('私有配置预检拒绝源码内凭据与无效文件，不输出值；文件存在不等于鉴权可用', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'delta-channels-'));
  const root = path.join(fixture, 'project'); mkdirSync(root);
  const privateFile = path.join(fixture, 'channel-key'); writeFileSync(privateFile, 'synthetic-secret-never-return', { mode: 0o600 });
  const publicFile = path.join(root, 'public-key'); writeFileSync(publicFile, 'unsafe', { mode: 0o600 });
  try {
    const report = inspectIntegrationPreparation({ SMS_SECRET_FILE: privateFile, PAYMENT_SECRET_FILE: publicFile, QQ_LOGIN_SECRET_FILE: path.join(fixture, 'missing') }, { root });
    assert.equal(report.secretFiles.SMS_SECRET_FILE, 'private-file-present');
    assert.equal(report.secretFiles.PAYMENT_SECRET_FILE, 'invalid-file');
    assert.equal(report.secretFiles.QQ_LOGIN_SECRET_FILE, 'invalid-file');
    assert.equal(report.credentialsValidated, false);
    assert.equal(report.capabilities.login.phone.enabled, false);
    assert.ok(!JSON.stringify(report).includes(fixture));
    assert.ok(!JSON.stringify(report).includes('synthetic-secret'));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
