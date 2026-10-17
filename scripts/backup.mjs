import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { localConfig } from '../server/config.mjs';
import { createSnapshot, verifySnapshot, restoreSnapshot } from './snapshot.mjs';
export { createSnapshot, verifySnapshot, restoreSnapshot } from './snapshot.mjs';
if (import.meta.main) {
  let release;
  try {
    const command = process.argv[2];
    const { readBackupKey, generateBackupKey, createEncryptedSnapshot, verifyEncryptedSnapshot, restoreEncryptedSnapshot } = await import('./secure-backup.mjs');
    if (command === 'keygen') {
      if (!process.argv[3]) throw Error('请提供独立、未存在的密钥文件路径。');
      generateBackupKey(path.resolve(process.argv[3])); console.log('备份密钥文件已生成，请与备份分开保管；未输出密钥内容。');
    } else if (command === 'create') {
      const config = localConfig();
      const { acquireDataLock } = await import('../server/data-lock.mjs');
      release = await acquireDataLock(config.dataDirectory);
      const target = process.argv[3] ? path.resolve(process.argv[3]) : path.join(config.dataDirectory, 'backups', randomUUID());
      const options = { authSecret: process.env.BETTER_AUTH_SECRET, authKeyRef: process.env.AUTH_KEY_REF };
      if (config.environment === 'staging' && !process.env.BACKUP_KEY_FILE) throw Error('内测环境备份必须设置独立 BACKUP_KEY_FILE 与 AUTH_KEY_REF。');
      console.log(process.env.BACKUP_KEY_FILE ? await createEncryptedSnapshot(config.dataDirectory, target, readBackupKey(process.env.BACKUP_KEY_FILE), options) : createSnapshot(config.dataDirectory, target));
    } else if (['verify', 'restore-copy'].includes(command)) {
      if (!process.argv[3] || (command === 'restore-copy' && !process.argv[4])) throw Error('缺少备份或恢复目录。');
      const source = path.resolve(process.argv[3]), encrypted = existsSync(path.join(source, 'encrypted-manifest.json'));
      const options = { authSecret: process.env.BETTER_AUTH_SECRET, authKeyRef: process.env.AUTH_KEY_REF };
      if (command === 'verify') {
        const m = encrypted ? await verifyEncryptedSnapshot(source, readBackupKey(process.env.BACKUP_KEY_FILE), options) : verifySnapshot(source);
        console.log(`备份校验通过，共${m.files.length}个文件。`);
      } else console.log(encrypted ? await restoreEncryptedSnapshot(source, path.resolve(process.argv[4]), readBackupKey(process.env.BACKUP_KEY_FILE), options) : restoreSnapshot(source, path.resolve(process.argv[4])));
    } else throw Error('命令：keygen <独立密钥文件> | create [新备份目录] | verify <备份目录> | restore-copy <备份目录> <新目录>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await release?.(); }
}
