import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSnapshot } from '../scripts/snapshot.mjs';
import { createEncryptedSnapshot, readBackupKey } from '../scripts/secure-backup.mjs';

// Keep this list in step with immutable application migrations. Better Auth manages its own migrations.
export const REQUIRED_MIGRATIONS = ['001-market-baseline', '002-evidence-baseline', '003-reliable-jobs', '004-free-teams', '005-account-security', '006-payment-journal', '007-runtime-limits', '008-team-history', '009-persona-presentation','010-paid-squads','011-persona-space','012-simulated-ledger','013-site-feedback','014-privacy-requests','015-free-team-profiles'];
export async function backupBeforeUpgrade(config) {
  const filename = path.join(config.dataDirectory, 'auth.sqlite');
  if (!existsSync(filename)) return null;
  const db = new DatabaseSync(filename, { readOnly: true });
  let pending;
  try {
    const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE name='app_migrations'").get()
      ? new Set(db.prepare('SELECT id FROM app_migrations').all().map(row => row.id)) : new Set();
    const userColumns = db.prepare('PRAGMA table_info(user)').all();
    pending = REQUIRED_MIGRATIONS.some(id => !installed.has(id)) || !userColumns.some(column => column.name === 'isAnonymous') || (config.phoneMode === 'mock' && !userColumns.some(column => column.name === 'phoneNumber'));
  } finally { db.close(); }
  if (!pending) return null;
  const target = path.join(config.dataDirectory, 'backups', `before-migration-${randomUUID()}`);
  if (process.env.BETTER_AUTH_SECRET && !process.env.BACKUP_KEY_FILE) throw Error('升级现有环境密钥数据库前，必须配置独立 BACKUP_KEY_FILE 和 AUTH_KEY_REF；尚未修改用户库。');
  if (process.env.BACKUP_KEY_FILE) return createEncryptedSnapshot(config.dataDirectory, target, readBackupKey(process.env.BACKUP_KEY_FILE), { authSecret: process.env.BETTER_AUTH_SECRET, authKeyRef: process.env.AUTH_KEY_REF });
  return createSnapshot(config.dataDirectory, target);
}

