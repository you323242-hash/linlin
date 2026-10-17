import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createMarket } from '../server/market.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { createPaymentJournal, inspectPaymentJournal, inspectLocalPaymentChannel, inspectSimulatedLedger } from '../server/payment-journal.mjs';

test('支付回执与状态同事务、不可改删、跨库对账和异常拒绝', async t => {
  const parent = realpathSync(tmpdir()), directory = mkdtempSync(path.join(parent,'delta-journal-'));
  const {auth,database:db} = await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:directory});
  const providers = createLocalProviders({directory});
  const market = createMarket(db,providers);
  const user = (await auth.api.signUpEmail({body:{name:'资金测试',email:'journal@example.test',password:'Journal-local-test-2026!',termsAccepted:true}})).user;
  const call = (scope,body={}) => market.command(user,scope,{requestId:randomUUID(),...body});
  const create = async () => (await call('create',{mode:'secret',rulesAccepted:true})).order;
  const act = (order,action) => call(order.id+':'+action,{version:market.readOrder(order.id,user).version});
  const channelDb = new DatabaseSync(path.join(directory,'mock-services.sqlite'),{readOnly:true});
  t.after(()=>{channelDb.close();providers.close();db.close();const target=realpathSync(directory);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-journal-'));rmSync(target,{recursive:true});});
  let paid;
  await t.test('支付/全退各一条回执，重复调度不重复累计，回执不可修改删除',async()=>{
    paid=await create();await act(paid,'pay');await act(paid,'cancel');await market.drainPayments();
    assert.equal(db.prepare('SELECT count(*) n FROM payment_receipts').get().n,2);
    assert.equal(inspectPaymentJournal(db).ok,true);assert.equal(inspectLocalPaymentChannel(db,channelDb).ok,true);
    assert.throws(()=>db.exec('UPDATE payment_receipts SET amount_cents=1'),/IMMUTABLE/);
    assert.throws(()=>db.exec('DELETE FROM payment_receipts'),/IMMUTABLE/);
    assert.equal(market.readOrder(paid.id,user).payment.refunded,1088);
    assert.equal(db.prepare('SELECT count(*) n FROM simulated_ledger').get().n,4);
    assert.deepEqual(inspectSimulatedLedger(db).totals,{paidCents:'1088',refundedCents:'1088',custodyCents:'0',debitCreditDifferenceCents:'0'});
    assert.throws(()=>db.exec('UPDATE simulated_ledger SET signed_cents=1'),/IMMUTABLE/);
    assert.throws(()=>db.exec('DELETE FROM simulated_ledger'),/IMMUTABLE/);
  });
  await t.test('二陪一总额守恒；入账失败回滚回执和订单，重试只记一次',async()=>{
    const order=(await call('create',{mode:'secret',providerCount:2,rulesAccepted:true})).order;
    assert.equal(order.price,2176);
    db.exec("CREATE TRIGGER fail_ledger_test BEFORE INSERT ON simulated_ledger WHEN NEW.account='order_custody' BEGIN SELECT RAISE(ABORT,'LEDGER_TEST_FAILURE'); END");
    await act(order,'pay');
    assert.equal(db.prepare('SELECT count(*) n FROM payment_receipts WHERE order_id=?').get(order.id).n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM simulated_ledger WHERE job_id IN (SELECT id FROM payment_jobs WHERE order_id=?)').get(order.id).n,0);
    assert.equal(market.readOrder(order.id,user).payment.status,'processing');
    db.exec('DROP TRIGGER fail_ledger_test');
    db.prepare('UPDATE payment_jobs SET next_at=0 WHERE order_id=?').run(order.id);
    await market.drainPayments();await market.drainPayments();
    assert.equal(market.readOrder(order.id,user).payment.status,'paid');
    assert.equal(inspectSimulatedLedger(db).totals.custodyCents,'2176');
    await act(order,'cancel');await market.drainPayments();
    assert.equal(inspectSimulatedLedger(db).totals.custodyCents,'0');
    assert.equal(inspectSimulatedLedger(db).ok,true);
  });
  await t.test('快照篡改退款额能够查出，不自动修正金额',()=>{
    const row=db.prepare('SELECT payload FROM orders WHERE id=?').get(paid.id), order=JSON.parse(row.payload);
    order.payment.refunded=1;db.prepare('UPDATE orders SET payload=? WHERE id=?').run(JSON.stringify(order),paid.id);
    assert.ok(inspectPaymentJournal(db).issues.some(i=>i.code==='ORDER_REFUND_MISMATCH'));
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM orders WHERE id=?').get(paid.id).payload).payment.refunded,1);
    db.prepare('UPDATE orders SET payload=? WHERE id=?').run(row.payload,paid.id);
  });
  const original = providers.payment.createPayment;
  await t.test('伪造真实回执、金额/币种/订单不符均拒绝记账',async()=>{
    for (const override of [{simulated:false},{amountCents:1},{currency:'USD'},{reference:'other-order'}]) {
      const order=await create();
      providers.payment.createPayment=async input=>({id:'fake_'+randomUUID(),simulated:true,status:'succeeded',reference:input.reference,amountCents:input.amountCents,currency:'CNY',...override});
      await act(order,'pay');
      assert.equal(market.readOrder(order.id,user).payment.status,'processing');
      assert.equal(db.prepare('SELECT status,last_error FROM payment_jobs WHERE order_id=?').get(order.id).last_error,'INVALID_RECEIPT');
      assert.equal(db.prepare('SELECT count(*) n FROM payment_receipts WHERE order_id=?').get(order.id).n,0);
    }
    providers.payment.createPayment=original;
  });
  await t.test('复用其他订单回执被拒，状态与回执均不半提交',async()=>{
    const id=db.prepare("SELECT receipt_id FROM payment_receipts WHERE action='pay'").get().receipt_id;
    providers.payment.createPayment=async input=>({id,simulated:true,status:'succeeded',reference:input.reference,amountCents:input.amountCents,currency:'CNY'});
    const order=await create();await act(order,'pay');
    assert.equal(market.readOrder(order.id,user).payment.status,'processing');
    assert.equal(db.prepare('SELECT last_error FROM payment_jobs WHERE order_id=?').get(order.id).last_error,'RECEIPT_REUSED');
    assert.equal(db.prepare('SELECT count(*) n FROM payment_receipts WHERE order_id=?').get(order.id).n,0);
    providers.payment.createPayment=original;
  });
  await t.test('无效支付任务在调用通道之前暂停；查出缺失回执与孤立通道操作',async()=>{
    const order=await create();let sends=0;
    db.prepare("INSERT INTO payment_jobs(id,order_id,action,amount,reason) VALUES (?,?,?,?,?)").run('invalid-task',order.id,'pay',1,'test');
    providers.payment.createPayment=async input=>{sends++;return original(input);};
    await market.drainPayments();assert.equal(sends,0);
    assert.equal(db.prepare('SELECT last_error FROM payment_jobs WHERE id=?').get('invalid-task').last_error,'PAYMENT_STATE_CONFLICT');
    assert.equal(inspectPaymentJournal(db).ok,true);
    await original({reference:'orphan-order',amountCents:100,requestId:'orphan-operation'});
    assert.ok(inspectLocalPaymentChannel(db,channelDb).issues.some(i=>i.code==='ORPHAN_CHANNEL_OPERATION'));
    db.prepare("UPDATE payment_jobs SET status='done' WHERE id='invalid-task'").run();
    assert.ok(inspectPaymentJournal(db).issues.some(i=>i.code==='DONE_WITHOUT_RECEIPT'));
  });
});

test('历史已完成任务仅标记覆盖范围，不伪造旧支付回执',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE orders(id TEXT PRIMARY KEY,payload TEXT); CREATE TABLE payment_jobs(id TEXT PRIMARY KEY,order_id TEXT,action TEXT,amount INTEGER,status TEXT,updated_at INTEGER); INSERT INTO payment_jobs VALUES ('old','legacy','pay',1088,'done',0)");
    createPaymentJournal(db);
    const report=inspectPaymentJournal(db);assert.equal(report.legacyUncovered,1);assert.equal(report.receipts,0);assert.equal(report.ok,true);
    db.exec("INSERT INTO payment_jobs VALUES ('new','new-order','pay',1088,'done',0)");
    assert.ok(inspectPaymentJournal(db).issues.some(i=>i.code==='DONE_WITHOUT_RECEIPT'&&i.jobId==='new'));
  }finally{db.close();}
});

test('账本从真实已留存模拟回执回填；半退、篡改检测和超安全整数汇总',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE orders(id TEXT PRIMARY KEY,payload TEXT); CREATE TABLE payment_jobs(id TEXT PRIMARY KEY,order_id TEXT,action TEXT,amount INTEGER,status TEXT,updated_at INTEGER); INSERT INTO orders VALUES ('duo','{}')");
    let journal=createPaymentJournal(db);
    const record=(id,action,amount)=>{db.prepare("INSERT INTO payment_jobs VALUES (?,'duo',?,?, 'done',0)").run(id,action,amount);db.exec('BEGIN IMMEDIATE');try{journal.record({id,order_id:'duo',action,amount},{id:'receipt_'+id,paymentId:'receipt_pay'});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}};
    record('pay','pay',2176);record('half','refund',1088);
    assert.equal(inspectSimulatedLedger(db).totals.custodyCents,'1088');
    db.exec("DROP TRIGGER simulated_ledger_no_update; DROP TRIGGER simulated_ledger_no_delete; DROP TABLE simulated_ledger; DELETE FROM app_migrations WHERE id='012-simulated-ledger'");
    journal=createPaymentJournal(db);
    assert.equal(inspectSimulatedLedger(db).backfilledReceipts,2);
    assert.equal(inspectSimulatedLedger(db).totals.custodyCents,'1088');
    createPaymentJournal(db);assert.equal(db.prepare('SELECT count(*) n FROM simulated_ledger').get().n,4);
    db.exec('DROP TRIGGER simulated_ledger_no_update');
    db.exec("UPDATE simulated_ledger SET signed_cents=-signed_cents WHERE job_id='pay'");
    const bad=inspectSimulatedLedger(db);assert.equal(bad.ok,false);assert.ok(bad.issues.some(x=>x.code==='LEDGER_RECEIPT_MISMATCH'));assert.ok(bad.issues.some(x=>x.code==='NEGATIVE_ORDER_CUSTODY'));
    db.exec("UPDATE simulated_ledger SET signed_cents=-signed_cents WHERE job_id='pay'");
    record('large1','pay',Number.MAX_SAFE_INTEGER);record('large2','pay',Number.MAX_SAFE_INTEGER);
    assert.equal(inspectSimulatedLedger(db).totals.paidCents,(2176n+2n*BigInt(Number.MAX_SAFE_INTEGER)).toString());
    assert.equal(inspectSimulatedLedger(db).ok,true);
  } finally {db.close();}
});
