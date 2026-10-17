import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// Bounded operational logs; audit_events and evidence have independent retention and are never deleted here.
export function createLogger(directory, { maximumBytes = 2 * 1024 * 1024, copies = 3 } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 256 || !Number.isSafeInteger(copies) || copies < 1 || copies > 10) throw Error('日志轮转参数无效。');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'operations.jsonl');
  let failed = false;
  function write(input) {
    // Only fixed safe fields. Do not spread input or serialize Error objects.
    const row = { at: new Date().toISOString() };
    for (const key of ['event', 'requestId', 'orderId', 'task', 'code', 'method', 'route']) {
      if (typeof input[key] === 'string' && /^[A-Za-z0-9_:/-]{1,128}$/.test(input[key])) row[key] = input[key];
    }
    for (const key of ['status', 'durationMs']) if (Number.isSafeInteger(input[key]) && input[key] >= 0) row[key] = input[key];
    try {
      if (existsSync(filename) && statSync(filename).size >= maximumBytes) {
        if (existsSync(`${filename}.${copies}`)) unlinkSync(`${filename}.${copies}`);
        for (let i = copies - 1; i >= 1; i--) if (existsSync(`${filename}.${i}`)) renameSync(`${filename}.${i}`, `${filename}.${i + 1}`);
        renameSync(filename, `${filename}.1`);
      }
      appendFileSync(filename, JSON.stringify(row) + '\n', { mode: 0o600 }); failed = false;
    } catch { failed = true; console.error('OPERATION_LOG_WRITE_FAILED'); }
  }
  write.healthy = () => !failed;
  return write;
}
