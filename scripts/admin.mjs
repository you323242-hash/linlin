import { acquireDataLock } from '../server/data-lock.mjs';
import { backupBeforeUpgrade } from '../server/upgrade-backup.mjs';
import { createAuth } from '../server/auth.mjs';
import { localConfig, prepareRuntimeDirectory } from '../server/config.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { createMarket } from '../server/market.mjs';
import { createTeams } from '../server/teams.mjs';
import { createSecurity } from '../server/security.mjs';

// Explicit offline operator grant; registration and role switching cannot grant admin permissions.
const [operation, email] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(operation) || !email) throw new Error('用法：node scripts/admin.mjs grant|revoke 已注册账户邮箱');
const config = localConfig();
const release = await acquireDataLock(config.dataDirectory);
let providers, database;
try {
  prepareRuntimeDirectory(config);
  providers = createLocalProviders({ directory: config.dataDirectory, environment: config.environment, mode: config.providerMode, allowStagingMocks: config.allowStagingMocks });
  await backupBeforeUpgrade(config);
  const initialized = await createAuth(config); database = initialized.database; const auth = initialized.auth;
  createMarket(database, providers);
  createTeams(database); createSecurity(database, auth, config);
  const user = database.prepare('SELECT id,twoFactorEnabled FROM user WHERE email=?').get(email.toLowerCase());
  if (!user) throw new Error('该用户尚未注册。');
  if (config.environment === 'staging' && operation === 'grant' && (!user.twoFactorEnabled || !database.prepare('SELECT 1 FROM twoFactor WHERE userId=? AND verified=1').get(user.id))) throw new Error('内测管理员必须先以普通用户登录，设置并验证二次验证；当前未授权管理权限。');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE user SET role=? WHERE id=?').run(operation === 'grant' ? 'admin' : 'user', user.id);
    database.prepare('DELETE FROM session WHERE userId=?').run(user.id);
    database.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (NULL,?,?,?,?)').run(user.id, config.environment + '_admin_' + operation, '授权操作者在停止本站写入后通过显式CLI调整管理权限；撤销原会话并要求重新登录', Date.now());
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  console.log('管理权限已更新，原登录会话已撤销；请重新登录并按环境要求完成二次验证。');
} finally { providers?.close(); database?.close(); await release(); }
