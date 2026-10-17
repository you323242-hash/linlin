import path from 'node:path';
import { isIP } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { assertIntegrationModes } from './integrations.mjs';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export function localConfig(env = process.env) {
  assertIntegrationModes(env);
  const environment = env.APP_ENV || (env.NODE_ENV === 'test' ? 'test' : 'local');
  if (!['local', 'test', 'staging', 'production'].includes(environment)) throw new Error('APP_ENV 无效。');
  if (env.AUTH_REQUIRE_EMAIL_VERIFICATION !== undefined && !['true', 'false'].includes(env.AUTH_REQUIRE_EMAIL_VERIFICATION)) throw new Error('AUTH_REQUIRE_EMAIL_VERIFICATION 必须是 true 或 false。');
  if (['staging', 'production'].includes(environment) !== (env.NODE_ENV === 'production')) throw new Error('staging/production 必须使用 NODE_ENV=production；本地不能使用该组合。');
  // Real adapters are not implemented. Fail before opening a database or running any jobs.
  if (environment === 'production') throw new Error('production 尚未开放：禁止使用模拟资金及当前 Local 适配器。');
  const port = Number(env.PORT || 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数。');
  const baseURL = env.BETTER_AUTH_URL || `http://127.0.0.1:${port}`;
  let origin;
  try { origin = new URL(baseURL); } catch { throw new Error('BETTER_AUTH_URL 必须是完整站点地址。'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.href !== origin.origin + '/' || origin.username || origin.password) throw new Error('BETTER_AUTH_URL 不得包含路径、参数或凭据。');
  const trustedProxies = env.TRUSTED_PROXY_IPS ? env.TRUSTED_PROXY_IPS.split(',').map(ip => ip.trim()) : [];
  // First deployment is a single host; do not silently trust a subnet or arbitrary proxy chain.
  if (trustedProxies.some(ip => !isIP(ip) || !['127.0.0.1', '::1'].includes(ip))) throw new Error('TRUSTED_PROXY_IPS 仅支持明确的同机回环地址。');
  const canonical = target => existsSync(target) ? realpathSync(target) : path.join(canonical(path.dirname(target)), path.basename(target));
  const dataDirectory = canonical(path.resolve(PROJECT_ROOT, env.AUTH_DATA_DIR || (environment === 'test' ? '.local/test' : '.local')));
  const sameCase = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const inside = (target, root) => { target = sameCase(target); root = sameCase(canonical(root)); return target === root || target.startsWith(root + path.sep); };
  if (inside(dataDirectory, path.join(PROJECT_ROOT, 'dist')) || dataDirectory === PROJECT_ROOT) throw new Error('AUTH_DATA_DIR 不得指向源码根目录或静态目录。');
  if (environment === 'test' && sameCase(dataDirectory) === sameCase(canonical(path.join(PROJECT_ROOT, '.local')))) throw new Error('test 必须使用独立 AUTH_DATA_DIR。');
  const providerMode = env.EXTERNAL_SERVICE_MODE || 'local';
  if (providerMode !== 'local') throw new Error('EXTERNAL_SERVICE_MODE 尚不支持该适配器。');
  const stagingAccessToken = env.STAGING_ACCESS_TOKEN || '';
  const staging = environment === 'staging';
  if (staging) {
    if (!env.BETTER_AUTH_URL || origin.protocol !== 'https:') throw new Error('staging 必须显式配置 HTTPS BETTER_AUTH_URL。');
    if (!env.AUTH_DATA_DIR || inside(dataDirectory, path.join(PROJECT_ROOT, '.local'))) throw new Error('staging 必须使用独立 AUTH_DATA_DIR，不能复用 .local。');
    if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.trim().length < 32) throw new Error('staging 必须配置独立 BETTER_AUTH_SECRET（至少32字符）。');
    if (stagingAccessToken.trim().length < 32 || stagingAccessToken === env.BETTER_AUTH_SECRET) throw new Error('STAGING_ACCESS_TOKEN 至少32字符，且必须与认证密钥不同。');
    if (!trustedProxies.includes('127.0.0.1')) throw new Error('staging 必须信任同机 IPv4 代理 TRUSTED_PROXY_IPS=127.0.0.1。');
    if (env.ALLOW_STAGING_MOCKS !== 'true') throw new Error('staging 必须显式确认 ALLOW_STAGING_MOCKS=true。');
    const localSecret = path.join(PROJECT_ROOT, '.local/auth-secret');
    if (existsSync(localSecret) && readFileSync(localSecret, 'utf8').trim() === env.BETTER_AUTH_SECRET) throw new Error('staging 不得复用本地认证密钥。');
  } else if (stagingAccessToken || env.ALLOW_STAGING_MOCKS) throw new Error('内测开关只能用于 APP_ENV=staging。');
  return { port, baseURL: origin.origin, dataDirectory, providerMode, environment, trustedProxies, stagingAccessToken, allowStagingMocks: staging, requireEmailVerification: staging || env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'true', phoneMode: env.AUTH_PHONE_MODE || 'disabled', paidOrdersEnabled: env.PAID_ORDERS_MODE !== 'disabled' };
}

// Bind a directory to one environment. In staging, only a fresh directory may be adopted.
export function prepareRuntimeDirectory({ dataDirectory, environment }) {
  const marker = path.join(dataDirectory, 'environment.json');
  if (existsSync(marker)) {
    if (JSON.parse(readFileSync(marker, 'utf8')).environment !== environment) throw new Error('数据目录属于其他 APP_ENV，拒绝混用。');
    return;
  }
  if (environment === 'staging' && existsSync(dataDirectory) && readdirSync(dataDirectory).length) throw new Error('staging 首次启动需要空数据目录，不能导入本地种子库。');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(marker, JSON.stringify({ version: 1, environment }), { flag: 'wx', mode: 0o600 });
}
