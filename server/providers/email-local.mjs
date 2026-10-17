import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Private developer inbox only. Never expose it through HTTP or use it as proof
// of real mailbox ownership. Replace this adapter before inviting real users.
export function createLocalEmail({ dataDirectory, environment }) {
  const closedStaging = environment === 'staging' && process.env.NODE_ENV === 'production' && process.env.ALLOW_STAGING_MOCKS === 'true';
  if (!['local', 'test'].includes(environment) && !closedStaging) return null;
  const directory = path.join(dataDirectory, 'email-outbox');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { async send({ recipient, purpose, url }) {
    if (!['verify', 'reset'].includes(purpose)) throw Error('INVALID_EMAIL_PURPOSE');
    const id = randomUUID();
    writeFileSync(path.join(directory, id + '.json'), JSON.stringify({ id,
      simulated: true, delivered: false, recipient, purpose, url,
      createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000,
    }), { flag: 'wx', mode: 0o600 });
  } };
}
