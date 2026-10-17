import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export function applyRequestContext(req, config) {
  const origin = new URL(config.baseURL);
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
  const proxied = config.trustedProxies.includes(peer);
  const token = req.headers['x-delta-staging-access'];
  const forwardedIP = req.headers['x-forwarded-for'];
  const validProxy = proxied && req.headers['x-forwarded-host'] === origin.host &&
    req.headers['x-forwarded-proto'] === origin.protocol.slice(0, -1) && typeof forwardedIP === 'string' && isIP(forwardedIP);
  // Delete all user-controlled forwarding hints before Better Auth sees this request.
  for (const name of Object.keys(req.headers)) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-') || ['x-real-ip', 'x-delta-client-ip', 'x-delta-staging-access'].includes(name)) delete req.headers[name];
  }
  if (req.headers.host !== origin.host) return { status: 400, message: '请求地址无效。' };
  if (config.trustedProxies.length && !validProxy) return { status: 400, message: '代理来源或转发信息无效。' };
  if (config.environment === 'staging') {
    const expected = Buffer.from(config.stagingAccessToken);
    const actual = Buffer.from(typeof token === 'string' ? token : '');
    if (!validProxy || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { status: 403, message: '此站点仅开放受邀内测。' };
  }
  const clientIP = validProxy ? forwardedIP.replace(/^::ffff:/, '') : peer;
  req.headers['x-delta-client-ip'] = clientIP;
  // The adapter needs the external scheme; only restore validated, canonical values.
  if (validProxy) {
    req.headers['x-forwarded-proto'] = origin.protocol.slice(0, -1);
    req.headers['x-forwarded-host'] = origin.host;
  }
  return { clientIP };
}
