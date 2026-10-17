import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
export const validPhone = value => typeof value === 'string' && /^\+861[3-9]\d{9}$/.test(value);
// Test-only secrets, never exposed over HTTP. Not proof of real phone ownership.
export function createLocalPhone({ dataDirectory, environment }) {
  if (!['local', 'test'].includes(environment) && !(environment === 'staging' && process.env.NODE_ENV === 'production' && process.env.ALLOW_STAGING_MOCKS === 'true')) throw Error('PHONE_MOCK_NOT_ALLOWED');
  const directory = path.join(dataDirectory, 'phone-outbox');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { async send({ phoneNumber, code }) {
    if (!validPhone(phoneNumber) || !/^\d{6}$/.test(code)) throw Error('INVALID_PHONE_DELIVERY');
    writeFileSync(path.join(directory, randomUUID() + '.json'), JSON.stringify({ phoneNumber, code, simulated: true, delivered: false, expiresAt: Date.now() + 300000 }), { flag: 'wx', mode: 0o600 });
  } };
}
