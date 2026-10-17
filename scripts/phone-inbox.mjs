import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { localConfig } from '../server/config.mjs';
import { validPhone } from '../server/providers/phone-local.mjs';
// Operator terminal only. Never wire this script or directory into an HTTP route.
try {
  const config = localConfig(), phone = process.argv[2];
  if (config.phoneMode !== 'mock' || !validPhone(phone) || process.argv[3] !== '--show-code') throw Error();
  const directory = path.join(config.dataDirectory, 'phone-outbox');
  const records = readdirSync(directory).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => JSON.parse(readFileSync(path.join(directory, f), 'utf8'))).filter(r => r.phoneNumber === phone && r.expiresAt > Date.now() && r.simulated === true).sort((a, b) => b.expiresAt - a.expiresAt);
  if (!records.length) throw Error();
  console.log(JSON.stringify({ scope: 'synthetic-private-mock-only', code: records[0].code, expiresAt: records[0].expiresAt, delivered: false }));
} catch { console.error('未找到有效模拟验证码，或模式/参数无效。用法：phone-inbox.mjs +86手机号 --show-code；仅允许私有操作终端。'); process.exitCode = 1; }
