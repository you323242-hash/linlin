import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { createSnapshot, verifySnapshot } from './snapshot.mjs';

function keyBytes(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw Error('备份加密密钥必须为32字节。');
  return Buffer.from(key);
}
export function readBackupKey(filename) {
  if (!filename || !lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw Error('请提供独立保存的备份密钥文件。');
  const value = readFileSync(filename, 'utf8').trim();
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw Error('备份密钥文件应包含64位十六进制随机值。');
  return Buffer.from(value, 'hex');
}
export function generateBackupKey(filename) {
  writeFileSync(filename, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
}
function freshTarget(target) {
  target = path.resolve(target);
  if (existsSync(target)) throw Error('目标必须是尚不存在的新目录，不覆盖已有数据。');
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  return target;
}
function scratch(parent) {
  parent = realpathSync(parent);
  const directory = mkdtempSync(path.join(parent, '.delta-backup-work-'));
  return { directory, cleanup() {
    // Delete only the exact private temporary directory created by this invocation.
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('.delta-backup-work-') || lstatSync(directory).isSymbolicLink()) throw Error('临时目录边界无效。');
    rmSync(resolved, { recursive: true });
  } };
}
function mac(manifest, key) { return createHmac('sha256', key).update(JSON.stringify(manifest)).digest('hex'); }
function safeFile(directory, name) {
  const file = path.join(directory, name), info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('备份拒绝链接和非普通文件。');
  return file;
}
async function digestFile(filename) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filename)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
function encryptedManifest(directory, key) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error('备份目录无效。');
  const filename = safeFile(directory, 'encrypted-manifest.json');
  if (lstatSync(filename).size > 16 * 1024 * 1024) throw Error('备份清单过大。');
  const envelope = JSON.parse(readFileSync(filename, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(envelope.mac || '') || !timingSafeEqual(Buffer.from(envelope.mac, 'hex'), Buffer.from(mac(envelope.manifest, key), 'hex'))) throw Error('备份密钥错误或清单被修改。');
  const m = envelope.manifest;
  if (m.version !== 1 || m.algorithm !== 'aes-256-gcm' || !Array.isArray(m.files) || m.files.length > 100000 || !m.files.some(f => f.name === 'manifest.json') || new Set(m.files.map(f => f.name)).size !== m.files.length || new Set(m.files.map(f => f.blob)).size !== m.files.length) throw Error('加密清单无效。');
  for (const f of m.files) {
    if (!/^(manifest\.json|auth\.sqlite|auth-secret|auth-key\.json|environment\.json|mock-services\.sqlite|storage\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(f.name) || !/^[0-9]{1,6}\.enc$/.test(f.blob) || !/^[a-f0-9]{24}$/.test(f.iv) || !/^[a-f0-9]{32}$/.test(f.tag) || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0) throw Error('加密文件记录无效。');
  }
  return m;
}
async function decryptTo(directory, target, key) {
  const manifest = encryptedManifest(directory, key);
  mkdirSync(target, { mode: 0o700 }); mkdirSync(path.join(target, 'storage'), { mode: 0o700 });
  for (const f of manifest.files) {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'hex'));
    decipher.setAAD(Buffer.from('delta-backup-v1:' + f.name)); decipher.setAuthTag(Buffer.from(f.tag, 'hex'));
    try { await pipeline(createReadStream(safeFile(directory, f.blob)), decipher, createWriteStream(path.join(target, f.name), { flags: 'wx', mode: 0o600 })); }
    catch { throw Error('备份文件解密校验失败。'); }
    const check = await digestFile(path.join(target, f.name));
    if (check.bytes !== f.bytes || check.sha256 !== f.sha256) throw Error('解密后的文件完整性校验失败。');
  }
  const result = verifySnapshot(target);
  if (manifest.files.length !== result.files.length + 1 || !result.files.every(file => manifest.files.some(f => f.name === file.name))) throw Error('备份内外清单不一致。');
  return result;
}
// Caller holds the data-directory OS lock. Snapshots contain SQLite VACUUM copies, never live WAL files.
export async function createEncryptedSnapshot(source, target, key, options = {}) {
  key = keyBytes(key); target = freshTarget(target);
  const work = scratch(path.dirname(target));
  try {
    const plain = path.join(work.directory, 'plain');
    createSnapshot(source, plain, options);
    const snapshot = verifySnapshot(plain), output = path.join(work.directory, 'encrypted');
    mkdirSync(output, { mode: 0o700 });
    const files = [];
    for (const [index, name] of [...snapshot.files.map(f => f.name), 'manifest.json'].entries()) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), blob = `${index}.enc`;
      cipher.setAAD(Buffer.from('delta-backup-v1:' + name));
      await pipeline(createReadStream(path.join(plain, name)), cipher, createWriteStream(path.join(output, blob), { flags: 'wx', mode: 0o600 }));
      files.push({ name, blob, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ...await digestFile(path.join(plain, name)) });
    }
    const manifest = { version: 1, algorithm: 'aes-256-gcm', createdAt: new Date().toISOString(), files };
    writeFileSync(path.join(output, 'encrypted-manifest.json'), JSON.stringify({ manifest, mac: mac(manifest, key) }, null, 2), { flag: 'wx', mode: 0o600 });
    await decryptTo(output, path.join(work.directory, 'verified'), key);
    renameSync(output, target);
    return target;
  } finally { key.fill(0); work.cleanup(); }
}
export async function verifyEncryptedSnapshot(source, key, options = {}) {
  key = keyBytes(key);
  const work = scratch(path.dirname(path.resolve(source)));
  try {
    const result = await decryptTo(path.resolve(source), path.join(work.directory, 'plain'), key);
    verifyExternalSecret(result, options);
    return result;
  } finally { key.fill(0); work.cleanup(); }
}
function verifyExternalSecret(manifest, { authSecret, authKeyRef } = {}) {
  if (manifest.auth?.mode !== 'external') return;
  if (typeof authSecret !== 'string' || authSecret.trim().length < 32 || authKeyRef !== manifest.auth.ref || createHash('sha256').update(authSecret).digest('hex') !== manifest.auth.fingerprint) throw Error('恢复需要原环境认证密钥和匹配的密钥引用，不能自动生成新密钥。');
}
export async function restoreEncryptedSnapshot(source, target, key, options = {}) {
  key = keyBytes(key); target = freshTarget(target);
  const work = scratch(path.dirname(target));
  try {
    const plain = path.join(work.directory, 'plain');
    const manifest = await decryptTo(path.resolve(source), plain, key);
    verifyExternalSecret(manifest, options);
    // The external authentication secret stays external. Restore environment.json with the data.
    renameSync(plain, target); return target;
  } finally { key.fill(0); work.cleanup(); }
}
