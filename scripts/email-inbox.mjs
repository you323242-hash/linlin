import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { localConfig } from '../server/config.mjs';

// Deliberate operator-only access. Recovery links are credentials: do not attach
// this output to an audit or post it in chat. No web endpoint reads this inbox.
try {
  const config = localConfig();
  if (!['local', 'test'].includes(config.environment)) throw Error();
  const recipient = process.argv[2];
  if (!recipient) throw Error();
  const folder = path.join(config.dataDirectory, 'email-outbox');
  const messages = readdirSync(folder).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(path.join(folder, name), 'utf8')))
    .filter(row => row.recipient.toLowerCase() === recipient.toLowerCase() && row.expiresAt > Date.now())
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!messages.length) console.log('没有有效的本地测试邮件。');
  else console.log(JSON.stringify(messages.slice(0, 5), null, 2));
} catch { console.error('仅在local/test运行：node scripts/email-inbox.mjs 合成测试邮箱；链接是敏感凭据，请勿转发。'); process.exitCode = 1; }
