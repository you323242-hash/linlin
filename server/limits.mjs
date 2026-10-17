import { createHash } from 'node:crypto';
import { migrate } from './migrations.mjs';

export function createPersistentLimiter(database, { namespace, limit, windowMs = 60_000, maxKeys = 10_000, now = Date.now }) {
  if (!/^[a-z-]{1,40}$/.test(namespace) || ![limit, windowMs, maxKeys].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('INVALID_LIMITER');
  migrate(database, '007-runtime-limits', `
CREATE TABLE runtime_limits (
  namespace TEXT NOT NULL, key_hash TEXT NOT NULL, count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(namespace,key_hash)
);
CREATE INDEX runtime_limits_expiry ON runtime_limits(expires_at);
`);
  const get = database.prepare('SELECT count,expires_at FROM runtime_limits WHERE namespace=? AND key_hash=?');
  return key => {
    const time = now(), hash = createHash('sha256').update(String(key)).digest('hex');
    database.exec('BEGIN IMMEDIATE');
    try {
      const row = get.get(namespace, hash);
      let allowed = false;
      if (row && row.expires_at > time) {
        if (row.count < limit) {
          database.prepare('UPDATE runtime_limits SET count=count+1 WHERE namespace=? AND key_hash=?').run(namespace, hash);
          allowed = true;
        }
      } else {
        database.prepare('DELETE FROM runtime_limits WHERE expires_at<=?').run(time);
        if (database.prepare('SELECT count(*) n FROM runtime_limits WHERE namespace=?').get(namespace).n < maxKeys) {
          database.prepare('INSERT INTO runtime_limits VALUES (?,?,1,?)').run(namespace, hash, time + windowMs);
          allowed = true;
        }
      }
      database.exec('COMMIT'); return allowed;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  };
}

export function createLimiter({ limit, windowMs = 60_000, maxKeys = 10_000, now = Date.now }) {
  const buckets = new Map();
  return key => {
    const time = now(); let b = buckets.get(key);
    if (!b || b.until <= time) {
      if (buckets.size >= maxKeys) for (const [id, row] of buckets) if (row.until <= time) buckets.delete(id);
      if (!b && buckets.size >= maxKeys) return false;
      b = { count: 0, until: time + windowMs }; buckets.set(key, b);
    }
    return ++b.count <= limit;
  };
}
