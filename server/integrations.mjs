import { realpathSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';

// Preparation is not activation: credentials never turn an unimplemented adapter on.
export function assertIntegrationModes(env = process.env) {
  if (!['enabled', 'disabled'].includes(env.PAID_ORDERS_MODE ?? 'enabled')) throw Error('PAID_ORDERS_MODE 只能为 enabled 或 disabled。');
  if (!['disabled', 'mock'].includes(env.AUTH_PHONE_MODE || 'disabled')) throw Error('AUTH_PHONE_MODE 只能为 disabled 或 mock。');
  if ((env.LOGIN_CHANNEL_MODE || 'disabled') !== 'disabled') throw Error('真实登录渠道尚未验收，LOGIN_CHANNEL_MODE 只能为 disabled。');
  if ((env.PAYMENT_CHANNEL_MODE || 'mock') !== 'mock') throw Error('真实资金渠道尚未验收，PAYMENT_CHANNEL_MODE 只能为 mock。');
}
export function integrationCapabilities(env = process.env) {
  return { version: 1, scope: 'restricted-test', realMoneyEnabled: false, paidOrdersEnabled: env.PAID_ORDERS_MODE !== 'disabled',
    login: { account: { enabled: true, mode: 'test-account' },
      phone: { enabled: env.AUTH_PHONE_MODE === 'mock', mode: env.AUTH_PHONE_MODE === 'mock' ? 'private-mock-inbox' : 'disabled', realOwnershipVerified: false },
      wechat: { enabled: false, reason: 'CHANNEL_NOT_READY' },
      qq: { enabled: false, reason: 'CHANNEL_NOT_READY' } },
    payment: { mode: 'mock', callbacksEnabled: false, settlementEnabled: false, withdrawalsEnabled: false } };
}
export function inspectIntegrationPreparation(env = process.env, { root = path.resolve(import.meta.dirname, '..') } = {}) {
  assertIntegrationModes(env);
  const secretFiles = Object.fromEntries(['SMS_SECRET_FILE', 'WECHAT_LOGIN_SECRET_FILE', 'QQ_LOGIN_SECRET_FILE', 'PAYMENT_SECRET_FILE'].map(key => {
    let status = 'not-configured';
    if (env[key]) {
      status = 'invalid-file';
      try {
        const file = path.resolve(env[key]), target = realpathSync(file), project = realpathSync(root);
        const relative = path.relative(project, target), outside = relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative);
        const metadata = statSync(file);
        if (path.isAbsolute(env[key]) && !lstatSync(file).isSymbolicLink() && outside && metadata.isFile() && metadata.size > 0 && metadata.size <= 65536 && (process.platform !== 'linux' || (metadata.mode & 0o077) === 0)) status = 'private-file-present';
      } catch { /* Never print paths, contents or filesystem errors. */ }
    }
    return [key, status];
  }));
  return { capabilities: integrationCapabilities(env), configurationOnly: true, credentialsValidated: false,
    secretFiles, activationBlocked: ['official-channel-approval', 'adapter-implementation', 'sandbox-acceptance', 'production-gate-review'] };
}
