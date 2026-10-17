import { createHash } from 'node:crypto';

// Applied migrations are immutable. Better Auth continues to own its own schema.
export function migrate(database, id, sql) {
  database.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const checksum = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
  const previous = database.prepare('SELECT checksum FROM app_migrations WHERE id=?').get(id);
  if (previous) {
    if (previous.checksum !== checksum) throw new Error(`已执行的迁移不可修改：${id}`);
    return false;
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(sql);
    database.prepare('INSERT INTO app_migrations VALUES (?,?,?)').run(id, checksum, Date.now());
    database.exec('COMMIT');
    return true;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
