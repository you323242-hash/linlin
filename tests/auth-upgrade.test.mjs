import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createAuth } from '../server/auth.mjs';
import { seedLocalUsers } from '../scripts/seed-local.mjs';

test('种子CLI升级旧认证库前备份，不丢旧账户、哈希或原密钥', async t => {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(path.join(parent, 'delta-auth-upgrade-'));
  t.after(() => { const target = realpathSync(dir); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('delta-auth-upgrade-')); rmSync(target, { recursive: true }); });
  const { auth, database } = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: dir });
  const user = (await auth.api.signUpEmail({ body: { email: 'old-auth@example.test', name: '旧认证库验收', password: 'Old-auth-upgrade-test-2026!', termsAccepted: true } })).user;
  const hash = database.prepare('SELECT password FROM account WHERE userId=?').get(user.id).password;
  const secret = readFileSync(path.join(dir, 'auth-secret'));
  // Emulate the preceding Better Auth schema, before the built-in two-factor plugin was added.
  database.exec('DROP TABLE twoFactor; ALTER TABLE user DROP COLUMN twoFactorEnabled'); database.close();
  await seedLocalUsers(dir);
  const db = new DatabaseSync(path.join(dir, 'auth.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM user').get().n, 3);
    assert.equal(db.prepare('SELECT password FROM account WHERE userId=?').get(user.id).password, hash);
    assert.equal(db.prepare('SELECT twoFactorEnabled FROM user WHERE id=?').get(user.id).twoFactorEnabled, 0);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { db.close(); }
  assert.deepEqual(readFileSync(path.join(dir, 'auth-secret')), secret);
  const backups = readdirSync(path.join(dir, 'backups')); assert.equal(backups.length, 1);
  const old = new DatabaseSync(path.join(dir, 'backups', backups[0], 'auth.sqlite'), { readOnly: true });
  try { assert.equal(old.prepare("SELECT count(*) n FROM sqlite_master WHERE name='twoFactor'").get().n, 0); assert.equal(old.prepare('SELECT count(*) n FROM user').get().n, 1); }
  finally { old.close(); }
});
