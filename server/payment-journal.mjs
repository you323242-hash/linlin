import { migrate } from './migrations.mjs';

// Successful channel observations, not a wallet, escrow balance or settlement ledger.
export function createPaymentJournal(db, { now = Date.now } = {}) {
  migrate(db, '006-payment-journal', `
    CREATE TABLE payment_receipts (
      job_id TEXT PRIMARY KEY REFERENCES payment_jobs(id) ON DELETE RESTRICT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      provider TEXT NOT NULL CHECK(provider='local'),
      receipt_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('pay','refund')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
      currency TEXT NOT NULL CHECK(currency='CNY'),
      payment_id TEXT,
      simulated INTEGER NOT NULL CHECK(simulated=1),
      observed_at INTEGER NOT NULL,
      UNIQUE(provider,receipt_id)
    );
    CREATE INDEX payment_receipts_order ON payment_receipts(order_id,observed_at);
    CREATE TABLE payment_journal_legacy (job_id TEXT PRIMARY KEY REFERENCES payment_jobs(id) ON DELETE RESTRICT);
    INSERT INTO payment_journal_legacy SELECT id FROM payment_jobs WHERE status='done';
    CREATE TRIGGER payment_receipts_no_update BEFORE UPDATE ON payment_receipts
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PAYMENT_RECEIPT'); END;
    CREATE TRIGGER payment_receipts_no_delete BEFORE DELETE ON payment_receipts
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PAYMENT_RECEIPT'); END;
  `);
  migrate(db, '012-simulated-ledger', `
    CREATE TABLE simulated_ledger (
      job_id TEXT NOT NULL REFERENCES payment_receipts(job_id) ON DELETE RESTRICT,
      account TEXT NOT NULL CHECK(account IN ('mock_channel_clearing','order_custody')),
      signed_cents INTEGER NOT NULL CHECK(typeof(signed_cents)='integer' AND signed_cents<>0 AND signed_cents BETWEEN -9007199254740991 AND 9007199254740991),
      origin TEXT NOT NULL CHECK(origin IN ('receipt_backfill','new_receipt')),
      PRIMARY KEY(job_id,account)
    );
    INSERT INTO simulated_ledger SELECT job_id,'mock_channel_clearing',CASE WHEN action='pay' THEN amount_cents ELSE -amount_cents END,'receipt_backfill' FROM payment_receipts;
    INSERT INTO simulated_ledger SELECT job_id,'order_custody',CASE WHEN action='pay' THEN -amount_cents ELSE amount_cents END,'receipt_backfill' FROM payment_receipts;
    CREATE TRIGGER simulated_ledger_no_update BEFORE UPDATE ON simulated_ledger
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SIMULATED_LEDGER'); END;
    CREATE TRIGGER simulated_ledger_no_delete BEFORE DELETE ON simulated_ledger
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SIMULATED_LEDGER'); END;
  `);
  function record(job, receipt) {
    // Called inside the same transaction as order update and job completion.
    db.prepare(`INSERT INTO payment_receipts VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      job.id, job.order_id, 'local', receipt.id, job.action, job.amount, 'CNY',
      job.action === 'refund' ? receipt.paymentId : null, 1, now());
    const debit = job.action === 'pay' ? job.amount : -job.amount;
    const insert = db.prepare("INSERT INTO simulated_ledger(job_id,account,signed_cents,origin) VALUES (?,?,?,'new_receipt')");
    insert.run(job.id,'mock_channel_clearing',debit);
    insert.run(job.id,'order_custody',-debit);
  }
  return { record };
}

// Read-only consistency check: never invent receipts for historic completed jobs.
export function inspectPaymentJournal(db) {
  const hasJournal = db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_receipts'").get();
  if (!hasJournal) return { scope:'simulated-only', ok:false, issues:[{code:'MIGRATION_REQUIRED'}], legacyUncovered:0 };
  const issues = []; let legacyUncovered = 0;
  const add = (code, jobId) => issues.push({ code, jobId });
  for (const job of db.prepare('SELECT j.*,r.receipt_id,r.amount_cents,r.action AS receipt_action,r.order_id AS receipt_order FROM payment_jobs j LEFT JOIN payment_receipts r ON r.job_id=j.id').iterate()) {
    if (job.status === 'done' && !job.receipt_id) {
      if (db.prepare('SELECT 1 FROM payment_journal_legacy WHERE job_id=?').get(job.id)) legacyUncovered++;
      else add('DONE_WITHOUT_RECEIPT', job.id);
    }
    if (job.receipt_id && (job.status !== 'done' || job.amount !== job.amount_cents || job.action !== job.receipt_action || job.order_id !== job.receipt_order)) add('JOB_RECEIPT_MISMATCH', job.id);
  }
  // Operator-only reconciliation must inspect every row, but streams one snapshot at a time.
  for (const row of db.prepare('SELECT id,payload FROM orders').iterate()) {
    const order = JSON.parse(row.payload);
    const receipts = db.prepare('SELECT * FROM payment_receipts WHERE order_id=?').all(row.id);
    const pays = receipts.filter(r => r.action === 'pay'), refunds = receipts.filter(r => r.action === 'refund');
    const completedRefunds = db.prepare("SELECT COALESCE(sum(amount),0) amount FROM payment_jobs WHERE order_id=? AND action='refund' AND status='done'").get(row.id).amount;
    if (completedRefunds !== order.payment.refunded) add('REFUND_JOB_TOTAL_MISMATCH', row.id);
    if (pays.length > 1) add('MULTIPLE_PAYMENTS', row.id);
    if (pays.length === 1 && (pays[0].amount_cents !== order.price || pays[0].receipt_id !== order.payment.receiptId)) add('ORDER_PAYMENT_MISMATCH', row.id);
    if (pays.length === 1 && refunds.reduce((sum,r) => sum+r.amount_cents,0) !== order.payment.refunded) add('ORDER_REFUND_MISMATCH', row.id);
    if (refunds.some(r => r.payment_id !== order.payment.receiptId) || refunds.reduce((sum,r)=>sum+r.amount_cents,0) > order.price) add('REFUND_LIMIT_OR_REFERENCE', row.id);
  }
  const ledger = inspectSimulatedLedger(db);
  return { scope:'simulated-only', ok:issues.length === 0 && ledger.ok, receipts:db.prepare('SELECT count(*) n FROM payment_receipts').get().n, legacyUncovered, issues, ledger };
}

// Debit-positive convention; order_custody is an accounting liability, never a withdrawable wallet.
export function inspectSimulatedLedger(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='simulated_ledger'").get()) return {scope:'simulated-only',ok:false,issues:[{code:'LEDGER_MIGRATION_REQUIRED'}]};
  const issues=[],custody=new Map();let balance=0n,paid=0n,refunded=0n,backfilled=0;
  for (const receipt of db.prepare('SELECT job_id,order_id,action,amount_cents FROM payment_receipts').iterate()) {
    const entries=db.prepare('SELECT account,signed_cents,origin FROM simulated_ledger WHERE job_id=?').all(receipt.job_id);
    const amount=BigInt(receipt.amount_cents), debit=receipt.action==='pay'?amount:-amount;
    if(entries.length!==2 || !entries.some(x=>x.account==='mock_channel_clearing'&&BigInt(x.signed_cents)===debit) || !entries.some(x=>x.account==='order_custody'&&BigInt(x.signed_cents)===-debit)) issues.push({code:'LEDGER_RECEIPT_MISMATCH',jobId:receipt.job_id});
    if(entries.some(x=>x.origin==='receipt_backfill'))backfilled++;
    for(const entry of entries) {balance+=BigInt(entry.signed_cents);if(entry.account==='order_custody')custody.set(receipt.order_id,(custody.get(receipt.order_id)||0n)-BigInt(entry.signed_cents));}
    if(receipt.action==='pay')paid+=amount;else refunded+=amount;
  }
  if(balance!==0n)issues.push({code:'LEDGER_UNBALANCED'});
  if([...custody.values()].some(x=>x<0n))issues.push({code:'NEGATIVE_ORDER_CUSTODY'});
  if([...custody.values()].reduce((a,b)=>a+b,0n)!==paid-refunded)issues.push({code:'LEDGER_NET_MISMATCH'});
  for(const row of db.prepare('SELECT l.job_id FROM simulated_ledger l LEFT JOIN payment_receipts r ON r.job_id=l.job_id WHERE r.job_id IS NULL').iterate())issues.push({code:'ORPHAN_LEDGER_ENTRY',jobId:row.job_id});
  return {scope:'simulated-only',ok:issues.length===0,totals:{paidCents:paid.toString(),refundedCents:refunded.toString(),custodyCents:[...custody.values()].reduce((a,b)=>a+b,0n).toString(),debitCreditDifferenceCents:balance.toString()},backfilledReceipts:backfilled,settlementEnabled:false,withdrawalsEnabled:false,issues};
}

export function inspectLocalPaymentChannel(db, channelDb) {
  const issues = []; let pendingConfirmed = 0;
  for (const operation of channelDb.prepare("SELECT request_id,action,result FROM mock_operations WHERE provider='payment'").iterate()) {
    const job = db.prepare('SELECT * FROM payment_jobs WHERE id=?').get(operation.request_id);
    if (!job) { issues.push({code:'ORPHAN_CHANNEL_OPERATION',jobId:operation.request_id}); continue; }
    const receipt = JSON.parse(operation.result);
    const order = JSON.parse(db.prepare('SELECT payload FROM orders WHERE id=?').get(job.order_id).payload);
    const matches = operation.action === (job.action === 'pay' ? 'create' : 'refund') && receipt.simulated === true && receipt.amountCents === job.amount &&
      (job.action === 'pay' ? receipt.reference === job.order_id && receipt.currency === 'CNY' && receipt.status === 'succeeded' : receipt.paymentId === order.payment.receiptId && receipt.status === 'refunded');
    if (!matches) issues.push({code:'CHANNEL_JOB_MISMATCH',jobId:job.id});
    else if (job.status !== 'done') pendingConfirmed++;
    const recorded = db.prepare('SELECT receipt_id FROM payment_receipts WHERE job_id=?').get(job.id);
    if (recorded && recorded.receipt_id !== receipt.id) issues.push({code:'CHANNEL_RECEIPT_MISMATCH',jobId:job.id});
  }
  for (const job of db.prepare("SELECT * FROM payment_jobs WHERE status='done'").iterate()) {
    if (!channelDb.prepare("SELECT 1 FROM mock_operations WHERE provider='payment' AND action=? AND request_id=?").get(job.action === 'pay' ? 'create' : 'refund',job.id)) issues.push({code:'CHANNEL_RECEIPT_MISSING',jobId:job.id});
  }
  return { scope:'local-mock-only',ok:issues.length===0,pendingConfirmed,issues };
}
