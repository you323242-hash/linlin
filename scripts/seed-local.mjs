import { acquireDataLock } from '../server/data-lock.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createAuth } from '../server/auth.mjs';
import { backupBeforeUpgrade } from '../server/upgrade-backup.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';

// Public, disposable test credentials. Never use these accounts/passwords in production.
export const TEST_USERS = [
  { email: 'dev-buyer@example.test', name: '本地测试消费者' },
  { email: 'dev-provider@example.test', name: '本地测试服务者' },
];
export const TEST_PASSWORD = 'Local-demo-only-2026!';
export async function seedLocalUsers(directory) {
  if (process.env.NODE_ENV === 'production' || ['staging', 'production'].includes(process.env.APP_ENV)) throw new Error('禁止在内测或生产环境创建公开示例账号。');
  const release = await acquireDataLock(directory);
  let database, providers;
  try {
  providers = createLocalProviders({ directory });
  await backupBeforeUpgrade({ dataDirectory: directory });
  const initialized = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: directory });
  database = initialized.database; const auth = initialized.auth;
    const results = [];
    for (const user of TEST_USERS) {
      const existing = database.prepare('SELECT id FROM user WHERE email=?').get(user.email);
      if (existing) { results.push({ email: user.email, created: false }); continue; }
      await auth.api.signUpEmail({ body: { ...user, password: TEST_PASSWORD, termsAccepted: true } });
      results.push({ email: user.email, created: true });
    }
    return results;
  } finally { database?.close(); providers?.close(); await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = path.resolve(import.meta.dirname, '../.local');
  console.log(JSON.stringify(await seedLocalUsers(directory), null, 2));
  console.log('仅创建普通测试用户；不自动创建管理员、陪玩资料或真实订单。');
}
