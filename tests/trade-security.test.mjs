import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createMarket } from '../server/market.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { inspectPaymentJournal } from '../server/payment-journal.mjs';

test('取消与接单竞争、支付身份、订单跳步与重复退款',async t=>{
  const parent=realpathSync(tmpdir()),directory=mkdtempSync(path.join(parent,'delta-trade-safe-'));
  const {auth,database:db}=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:directory});
  const providers=createLocalProviders({directory}),market=createMarket(db,providers),users=[];
  t.after(()=>{providers.close();db.close();const target=realpathSync(directory);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-trade-safe-'));rmSync(target,{recursive:true});});
  for(let i=0;i<3;i++)users.push((await auth.api.signUpEmail({body:{name:'交易测试'+i,email:`trade${i}@example.test`,password:'Trade-security-test-2026!',termsAccepted:true}})).user);
  const [buyer,provider,other]=users;
  const call=(user,scope,body={})=>market.command(user,scope,{requestId:randomUUID(),...body});
  const action=(user,order,name,body={})=>call(user,order.id+':'+name,{version:market.readOrder(order.id,buyer).version,...body});
  const create=async()=> (await call(buyer,'create',{mode:'secret',rulesAccepted:true,price:1,duration:1,quantity:999,coupon:'FREE',payment:{status:'paid'}})).order;
  await call(provider,'profile',{adult:true,gameId:"' OR 1=1 --",introduction:'<img src=x onerror=alert(1)>',modes:['secret'],stats:{secret:{kd:1.2,gear:4}},available:true});
  await t.test('前端价格/数量/优惠/支付状态不能覆盖后台快照，非购买者不能模拟支付',async()=>{
    const order=await create();assert.equal(order.price,1088);assert.equal(order.duration,3600);assert.equal(order.payment.status,'unpaid');
    await assert.rejects(action(other,order,'pay'),{status:404});await assert.rejects(action(provider,order,'pay'),{status:404});
    await assert.rejects(action(buyer,order,'finish'),{status:409});await assert.rejects(action(buyer,order,'review',{attitude:5,communication:5,experience:5}),{status:409});
    assert.equal(db.prepare('SELECT count(*) n FROM user').get().n,3);assert.equal(market.profile(provider.id).gameId,"' OR 1=1 --");
    await action(buyer,order,'cancel');
  });
  await t.test('两种到达顺序均只能取消或接单之一成功；退款与履约不能同时成功',async()=>{
    for(const cancelFirst of [true,false]) {
      const order=await create();await action(buyer,order,'pay');const version=market.readOrder(order.id,buyer).version;
      const cancel=()=>call(buyer,order.id+':cancel',{version}),accept=()=>call(provider,order.id+':accept',{version});
      const results=await Promise.allSettled(cancelFirst?[cancel(),accept()]:[accept(),cancel()]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const current=market.readOrder(order.id,buyer);
      if(cancelFirst){assert.equal(current.status,'cancelled');assert.equal(current.providerId,null);assert.equal(current.payment.refunded,1088);}
      else {
        assert.equal(current.status,'ready');assert.equal(current.providerId,provider.id);assert.equal(current.payment.refunded,0);
        await action(buyer,current,'requestCancel',{reason:'本地竞争验收完成，双方同意结束未开始订单'});
        await action(provider,current,'respondCancel',{agreed:true});
      }
      await assert.rejects(action(buyer,order,'cancel'),{status:409});await assert.rejects(action(buyer,order,'pay'),{status:409});
      await market.drainPayments();assert.equal(market.readOrder(order.id,buyer).payment.refunded,1088);
      assert.equal(db.prepare("SELECT count(*) n FROM payment_receipts WHERE order_id=? AND action='refund'").get(order.id).n,1);
    }
    assert.equal(inspectPaymentJournal(db).ok,true);
  });
  await t.test('订单幂等缓存不复制私有偏好，重放仍鉴权返回同一单且不重建',async()=>{
    const requestId=randomUUID(),fields={requestId,mode:'secret',rulesAccepted:true,preference:'测试私有偏好，不复制到幂等缓存'};
    const first=await market.command(buyer,'create',fields);
    const cached=db.prepare('SELECT result FROM business_requests WHERE user_id=? AND request_id=?').get(buyer.id,requestId).result;
    assert.ok(!cached.includes(fields.preference));assert.ok(!cached.includes('messages'));
    const repeated=await market.command(buyer,'create',fields);assert.equal(repeated.order.id,first.order.id);assert.equal(repeated.order.preference,fields.preference);
    assert.equal(db.prepare('SELECT count(*) n FROM orders WHERE id=?').get(first.order.id).n,1);
    await action(buyer,first.order,'cancel');
  });
});
