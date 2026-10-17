import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { localConfig } from '../server/config.mjs';
import { acquireDataLock } from '../server/data-lock.mjs';
import { inspectPaymentJournal, inspectLocalPaymentChannel } from '../server/payment-journal.mjs';

// Stop the app first: compare both DBs at a stable point; no migration/repair/channel calls.
let release, db, channel;
try {
  const config = localConfig();
  release = await acquireDataLock(config.dataDirectory);
  db = new DatabaseSync(path.join(config.dataDirectory,'auth.sqlite'), {readOnly:true});
  channel = new DatabaseSync(path.join(config.dataDirectory,'mock-services.sqlite'), {readOnly:true});
  const journal = inspectPaymentJournal(db);
  const provider = journal.issues.some(i=>i.code==='MIGRATION_REQUIRED') ? null : inspectLocalPaymentChannel(db,channel);
  console.log(JSON.stringify({productionReady:false,journal,provider},null,2));
  if (!journal.ok || !provider?.ok || provider.pendingConfirmed > 0) process.exitCode=1;
} catch { console.error('支付检查失败；先停止本站并核对数据目录。没有修改或补偿任何资金记录。'); process.exitCode=1; }
finally { channel?.close(); db?.close(); await release?.(); }
