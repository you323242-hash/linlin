import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { localConfig } from '../server/config.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = name => /^(auth\.sqlite|auth-secret|auth-key\.json|environment\.json|mock-services\.sqlite|storage\/[A-Za-z0-9._-]+)$/.test(name);
function regular(file) { const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw Error('备份拒绝链接和非普通文件。'); }
function dbCheck(file) { const db = new DatabaseSync(file, { readOnly: true }); try { if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw Error('数据库校验失败。'); } finally { db.close(); } }
export function verifySnapshot(directory) {
  if (lstatSync(directory).isSymbolicLink() || lstatSync(path.join(directory, 'storage')).isSymbolicLink()) throw Error('备份目录不得为链接。');
  regular(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || !['auth.sqlite', 'mock-services.sqlite', ...(manifest.auth?.mode === 'external' ? [] : ['auth-secret'])].every(name => manifest.files.some(f => f.name === name)) || new Set(manifest.files.map(f => f.name)).size !== manifest.files.length) throw Error('备份清单无效。');
  if (manifest.version === 1 && manifest.auth) throw Error('备份密钥模式无效。');
  if (manifest.version === 2 && (manifest.auth?.mode !== 'external' || !/^[A-Za-z0-9._/-]{1,100}$/.test(manifest.auth.ref || '') || !/^[a-f0-9]{64}$/.test(manifest.auth.fingerprint || '') || manifest.files.some(f => f.name === 'auth-secret'))) throw Error('外部认证密钥引用无效。');
  for (const f of manifest.files) {
    if (!safe(f.name)) throw Error('备份路径无效。');
    const file = path.join(directory, f.name); regular(file); const bytes = readFileSync(file);
    if (bytes.length !== f.bytes || sha(bytes) !== f.sha256) throw Error('备份文件完整性校验失败。');
  }
  if (manifest.files.some(f => f.name === 'auth-key.json')) {
    const identity = JSON.parse(readFileSync(path.join(directory, 'auth-key.json'), 'utf8'));
    const expected = manifest.auth?.fingerprint || sha(readFileSync(path.join(directory, 'auth-secret'), 'utf8').trim());
    if (identity.version !== 1 || identity.fingerprint !== expected) throw Error('认证密钥标记与备份不一致。');
  }
  for (const file of ['auth.sqlite', 'mock-services.sqlite']) dbCheck(path.join(directory, file));
  const db = new DatabaseSync(path.join(directory, 'auth.sqlite'), { readOnly: true });
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='evidence_files'").get()) for (const row of db.prepare('SELECT storage_key,bytes,sha256 FROM evidence_files').all()) {
      if (!safe('storage/' + row.storage_key)) throw Error('附件路径无效。');
      const f = manifest.files.find(f => f.name === 'storage/' + row.storage_key);
      if (!f || f.bytes !== row.bytes || f.sha256 !== row.sha256) throw Error('附件与元数据不一致。');
    }
  } finally { db.close(); }
  return manifest;
}
// Caller must pause all writers: two databases and immutable storage cannot share one SQLite transaction.
export function createSnapshot(source, target, { authSecret, authKeyRef } = {}) {
  if (process.env.BETTER_AUTH_SECRET && !authSecret) throw Error('环境密钥备份必须使用加密备份与外部密钥引用。');
  if (authSecret && (typeof authSecret !== 'string' || authSecret.trim().length < 32 || !/^[A-Za-z0-9._/-]{1,100}$/.test(authKeyRef || ''))) throw Error('外部认证密钥或 AUTH_KEY_REF 无效。');
  source = path.resolve(source); target = path.resolve(target);
  if (existsSync(target) || source === target || source.startsWith(target + path.sep) || target.startsWith(path.join(source, 'storage') + path.sep)) throw Error('备份目标必须为新的独立目录。');
  mkdirSync(target, { recursive: true, mode: 0o700 }); mkdirSync(path.join(target, 'storage'));
  for (const file of ['auth.sqlite', 'mock-services.sqlite']) {
    regular(path.join(source, file)); const db = new DatabaseSync(path.join(source, file), { readOnly: true });
    try { db.prepare('VACUUM INTO ?').run(path.join(target, file)); } finally { db.close(); }
  }
  if (!authSecret) { regular(path.join(source, 'auth-secret')); copyFileSync(path.join(source, 'auth-secret'), path.join(target, 'auth-secret')); }
  if (existsSync(path.join(source, 'auth-key.json'))) { regular(path.join(source, 'auth-key.json')); copyFileSync(path.join(source, 'auth-key.json'), path.join(target, 'auth-key.json')); }
  if (existsSync(path.join(source, 'environment.json'))) { regular(path.join(source, 'environment.json')); copyFileSync(path.join(source, 'environment.json'), path.join(target, 'environment.json')); }
  const storage = path.join(source, 'storage');
  if (existsSync(storage)) {
    if (lstatSync(storage).isSymbolicLink()) throw Error('存储目录不得为链接。');
    for (const name of readdirSync(storage)) { if (!safe('storage/' + name)) throw Error('存储文件名无效。'); regular(path.join(storage, name)); copyFileSync(path.join(storage, name), path.join(target, 'storage', name)); }
  }
  const names = ['auth.sqlite', ...(!authSecret ? ['auth-secret'] : []), ...(existsSync(path.join(target, 'auth-key.json')) ? ['auth-key.json'] : []), ...(existsSync(path.join(target, 'environment.json')) ? ['environment.json'] : []), 'mock-services.sqlite', ...readdirSync(path.join(target, 'storage')).map(f => 'storage/' + f)];
  const manifest = { version: authSecret ? 2 : 1, ...(authSecret ? { auth: { mode: 'external', ref: authKeyRef, fingerprint: sha(authSecret) } } : {}), createdAt: new Date().toISOString(), files: names.map(name => { const b = readFileSync(path.join(target, name)); return { name, bytes: b.length, sha256: sha(b) }; }) };
  writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  verifySnapshot(target); return target;
}
export function restoreSnapshot(snapshot, target) {
  if (existsSync(target)) throw Error('恢复只允许新目录，不覆盖任何现有数据。');
  const manifest = verifySnapshot(snapshot);
  if (manifest.auth?.mode === 'external') throw Error('外部密钥快照必须通过加密恢复流程核对原密钥。');
  mkdirSync(target, { recursive: true, mode: 0o700 }); mkdirSync(path.join(target, 'storage'));
  for (const f of manifest.files) copyFileSync(path.join(snapshot, f.name), path.join(target, f.name));
  copyFileSync(path.join(snapshot, 'manifest.json'), path.join(target, 'manifest.json')); verifySnapshot(target);
  return path.resolve(target);
}
