import { statfsSync } from 'node:fs';
import { migrate } from './migrations.mjs';

// Never persist vendor error messages, request bodies, credentials or evidence in operational logs.
const codes = new Set(['TIMEOUT', 'INVALID_RECEIPT', 'IDEMPOTENCY_CONFLICT', 'PAYMENT_NOT_FOUND', 'REFUND_EXCEEDS_PAYMENT', 'INVALID_AMOUNT', 'MOCK_NOT_ALLOWED', 'LOOKUP_UNAVAILABLE', 'PAYMENT_STATE_CONFLICT', 'RECEIPT_REUSED', 'SQLITE_BUSY', 'SQLITE_FULL', 'ENOSPC', 'EIO', 'ECONNRESET', 'ECONNREFUSED', 'NOTIFICATION_FAILED']);
export const safeErrorCode = error => codes.has(error?.code) ? error.code : 'OPERATION_FAILED';
export const retryDelay = attempt => Math.min(300_000, 5000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
export async function boundedCall(operation, timeoutMs = 10_000) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function createOperations(database, { now = Date.now } = {}) {
  migrate(database, '003-reliable-jobs', `
    ALTER TABLE payment_jobs ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE payment_jobs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE payment_jobs ADD COLUMN retry_base INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX payment_jobs_due ON payment_jobs(status,next_at);
    CREATE TABLE notification_jobs (id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE RESTRICT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, retry_base INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX notification_jobs_due ON notification_jobs(status,next_at);
    CREATE TABLE runtime_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, next_at INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '');
    CREATE TABLE operation_alerts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL, code TEXT NOT NULL, opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER, occurrences INTEGER NOT NULL DEFAULT 1);
  `);
  function alert(id, kind, target, code) {
    database.prepare(`INSERT INTO operation_alerts(id,kind,target_id,code,opened_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,updated_at=excluded.updated_at,opened_at=CASE WHEN resolved_at IS NULL THEN opened_at ELSE excluded.opened_at END,occurrences=occurrences+CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END,resolved_at=NULL`).run(id, kind, target, code, now(), now());
  }
  const resolve = id => database.prepare('UPDATE operation_alerts SET resolved_at=?,updated_at=? WHERE id=? AND resolved_at IS NULL').run(now(), now(), id);
  const snapshot = () => ({
    tasks: database.prepare('SELECT * FROM runtime_tasks ORDER BY id').all(),
    alerts: database.prepare('SELECT * FROM operation_alerts WHERE resolved_at IS NULL ORDER BY opened_at LIMIT 100').all(),
    alertCount: database.prepare('SELECT count(*) AS n FROM operation_alerts WHERE resolved_at IS NULL').get().n,
    payment: database.prepare('SELECT id,order_id,action,amount,status,attempts,next_at,last_error FROM payment_jobs WHERE status<>\'done\' ORDER BY rowid LIMIT 100').all(),
    notification: database.prepare('SELECT id,status,attempts,next_at,last_error FROM notification_jobs WHERE status<>\'done\' ORDER BY rowid LIMIT 100').all(),
    counts: {
      payments: database.prepare("SELECT count(*) AS n FROM payment_jobs WHERE status<>'done'").get().n,
      notifications: database.prepare("SELECT count(*) AS n FROM notification_jobs WHERE status<>'done'").get().n,
    },
  });
  return { alert, resolve, snapshot };
}

export function createWorker(database, operations, tasks, { now = Date.now, intervalMs = 5000, logger = () => {} } = {}) {
  let running = null, timer, stopped = true;
  for (const task of tasks) {
    database.prepare("INSERT OR IGNORE INTO runtime_tasks(id,state) VALUES (?,'idle')").run(task.id);
    database.prepare("UPDATE runtime_tasks SET state='idle' WHERE id=? AND state='running'").run(task.id);
  }
  function tick() {
    if (running) return running;
    running = (async () => {
      for (const task of tasks) {
        const row = database.prepare('SELECT * FROM runtime_tasks WHERE id=?').get(task.id);
        if (row.next_at > now()) continue;
        database.prepare("UPDATE runtime_tasks SET state='running',started_at=?,runs=runs+1 WHERE id=?").run(now(), task.id);
        try {
          await task.run();
          database.prepare("UPDATE runtime_tasks SET state='idle',finished_at=?,next_at=?,failures=0,last_error='' WHERE id=?").run(now(), now() + intervalMs, task.id);
          operations.resolve('worker:' + task.id);
        } catch (error) {
          const failures = row.failures + 1, code = safeErrorCode(error);
          database.prepare("UPDATE runtime_tasks SET state='retry',finished_at=?,next_at=?,failures=?,last_error=? WHERE id=?").run(now(), now() + retryDelay(failures), failures, code, task.id);
          operations.alert('worker:' + task.id, 'worker', task.id, code);
          logger({ event: 'worker_error', task: task.id, code });
        }
      }
    })().finally(() => { running = null; });
    return running;
  }
  async function loop() {
    try { await tick(); } catch (error) { logger({ event: 'worker_error', code: safeErrorCode(error) }); }
    if (!stopped) { timer = setTimeout(loop, intervalMs); timer.unref(); }
  }
  return {
    tick,
    async start() { if (!stopped) return; stopped = false; await loop(); },
    async stop() { stopped = true; clearTimeout(timer); await running; },
    health() {
      const rows = database.prepare('SELECT * FROM runtime_tasks').all();
      const stale = rows.some(row => row.state === 'running' ? now() - row.started_at > 180_000 : now() > row.next_at + 180_000);
      const failed = rows.some(row => row.failures > 0);
      if (stale) operations.alert('runtime:heartbeat', 'runtime', 'worker', 'WORKER_STALE');
      else operations.resolve('runtime:heartbeat');
      return { status: stopped || stale || failed ? 'degraded' : 'ok', active: !stopped, stale };
    },
  };
}

export function checkDisk(directory, operations, { minimumBytes = 256 * 1024 * 1024, statfs = statfsSync } = {}) {
  const stats = statfs(directory);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(available) || available < minimumBytes) operations.alert('runtime:disk', 'runtime', 'disk', 'LOW_DISK');
  else operations.resolve('runtime:disk');
  return available >= minimumBytes;
}
