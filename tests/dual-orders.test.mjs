import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAuth} from '../server/auth.mjs';
import {createMarket} from '../server/market.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {belongsToIdentity,needsRoundConfirmation} from '../dist/orders.mjs';
test('双人订单：同意组队、整数总价、原子接单、三方履约和售后',async t=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(path.join(parent,'delta-dual-'));
  let db,providers,market,clock=Date.now(),users=[];
  async function setup(){const {auth,database}=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:dir});db=database;providers=createLocalProviders({directory:dir});market=createMarket(db,providers,{now:()=>clock});return auth;}
  const cmd=(u,scope,body={})=>market.command(u,scope,{requestId:randomUUID(),...body});
  const act=async(o,u,action,body={})=>(await cmd(u,`${o.id}:${action}`,{version:action==='accept'?o.version:market.readOrder(o.id,u).version,...body})).order;
  const latest=(o,u=users[0])=>market.readOrder(o.id,u);
  const pay=async(count=2,mode='secret')=>act((await cmd(users[0],'create',{mode,providerCount:count,rulesAccepted:true,price:1,unitPrice:1})).order,users[0],'pay');
  const accept=async(o,u=users[1])=>{const q=market.queue(u).find(x=>x.id===o.id);assert.ok(q);return act(o,u,'accept',{offerId:q.offer?.id});};
  try{
    const auth=await setup();for(let i=0;i<5;i++)users.push((await auth.api.signUpEmail({body:{name:'双人测试'+i,email:`dual${i}@example.test`,password:'Dual-only-local-test!',termsAccepted:true}})).user);
    users[4].role='admin';db.prepare('UPDATE user SET role=? WHERE id=?').run('admin',users[4].id);
    for(const u of users.slice(1,4))await cmd(u,'profile',{adult:true,gameId:'LOCAL-'+u.id,introduction:'合成测试服务资料，不是真实玩家',modes:['secret','topsecret'],stats:{secret:{kd:1.3,gear:4},topsecret:{kd:.8,gear:5}},available:true});
    await t.test('需本人同意与有效资料，不能冒名加入、重复加入或超过两人',async()=>{
      await assert.rejects(cmd(users[1],'squadCreate',{}),/同意/);
      const {squad}=await cmd(users[1],'squadCreate',{consent:true});assert.equal(squad.members.length,1);
      await assert.rejects(cmd(users[0],'squadJoin',{consent:true,code:squad.joinCode,userId:users[2].id}),/资料/);
      await cmd(users[2],'squadJoin',{consent:true,code:squad.joinCode});
      assert.equal(market.squads.view(users[2].id).members.length,2);assert.equal(market.squads.view(users[2].id).joinCode,null);
      await assert.rejects(cmd(users[3],'squadJoin',{consent:true,code:squad.joinCode}),/已满/);
      await assert.rejects(cmd(users[1],'squadCreate',{consent:true}),/已有/);
    });
    let order;
    await t.test('人数只允许1或2；金额由服务器计算，双人21.76/41.76，旧单默认一人',async()=>{
      for(const providerCount of [0,3,'2',1.5])await assert.rejects(cmd(users[0],'create',{mode:'secret',rulesAccepted:true,providerCount}),e=>e.status===400);
      order=await pay();assert.equal(order.price,2176);assert.equal(order.unitPrice,1088);assert.equal(order.providerCount,2);
      const top=(await cmd(users[0],'create',{mode:'topsecret',providerCount:2,rulesAccepted:true,price:1})).order;assert.equal(top.price,4176);
      const single=(await cmd(users[0],'create',{mode:'secret',rulesAccepted:true})).order;assert.equal(single.price,1088);
      assert.ok(!market.queue(users[3]).some(o=>o.id===order.id));
    });
    await t.test('两人都在线才派单，任一人接受邀请均原子占用两人；第三人不能读取',async()=>{
      market.heartbeat(users[1]);assert.ok(!market.queue(users[1]).some(o=>o.id===order.id));market.heartbeat(users[2]);
      const results=await Promise.allSettled([accept(order,users[1]),accept(order,users[2])]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);order=results.find(r=>r.status==='fulfilled').value;
      assert.equal(order.providers.length,2);assert.equal(db.prepare('SELECT count(*) n FROM order_providers WHERE live=1').get().n,2);
      for(const u of users.slice(1,3)){assert.equal(market.profile(u.id).state,'serving');assert.ok(market.list(u,'provider').some(o=>o.id===order.id));assert.equal(belongsToIdentity(latest(order,u),'provider',u.id),true);await assert.rejects(cmd(u,'squadLeave'),/服务订单/);}
      assert.throws(()=>latest(order,users[3]),/无权/);
      const other=await pay(1);await assert.rejects(act(other,users[2],'accept'),/条件/);await act(other,users[0],'cancel');
    });
    await t.test('开始计时必须三人确认，对局记录也是三人核对，不能代队友确认',async()=>{
      await act(order,users[1],'start');order=await act(order,users[0],'start');assert.equal(order.status,'ready');assert.equal(order.runningSince,null);
      await assert.rejects(act(order,users[1],'start',{userId:users[2].id}),/不可确认/);
      assert.equal(latest(order,users[2]).start.provider,false);
      order=await act(order,users[2],'start');assert.equal(order.status,'active');
      await act(order,users[1],'beginRound');await act(order,users[1],'endRound',{result:'success'});
      assert.equal(needsRoundConfirmation(latest(order,users[2]),'provider'),true);
      await act(order,users[0],'confirmRound',{index:0,agreed:true});assert.equal(latest(order).rounds[0].normal,false);
      await assert.rejects(act(order,users[1],'confirmRound',{index:0,agreed:true}),/自行/);
      order=await act(order,users[2],'confirmRound',{index:0,agreed:true});assert.equal(order.rounds[0].normal,true);
    });
    await t.test('一小时后三人分别完成；一名服务者不能代全部完成',async()=>{
      clock+=3600_000;order=latest(order);assert.equal(order.status,'confirming');await act(order,users[1],'finish');order=await act(order,users[0],'finish');assert.equal(order.status,'confirming');order=await act(order,users[2],'finish');assert.equal(order.status,'completed');
      await act(order,users[0],'review',{attitude:5,communication:4,experience:5,text:'合成整体服务评价'});
    });
    await t.test('未开始协商取消须全体同意；重复退款和占用不会发生',async()=>{
      market.heartbeat(users[1]);market.heartbeat(users[2]);order=await accept(await pay());await act(order,users[0],'requestCancel',{reason:'合成测试未开始取消完整双人订单'});
      await act(order,users[1],'respondCancel',{agreed:true});assert.equal(latest(order).status,'ready');await assert.rejects(act(order,users[1],'respondCancel',{agreed:true}),/已同意/);
      order=await act(order,users[2],'respondCancel',{agreed:true});assert.equal(order.status,'cancelled');assert.equal(order.payment.refunded,2176);assert.equal(market.profile(users[1].id).state,'available');
      await assert.rejects(act(order,users[0],'cancel'),/不能/);
    });
    await t.test('售后方案需三方接受、参与管理员回避；整体退款保留金额与审计',async()=>{
      market.heartbeat(users[1]);market.heartbeat(users[2]);order=await accept(await pay());await act(order,users[1],'start');await act(order,users[2],'start');await act(order,users[0],'start');
      order=await act(order,users[0],'request',{kind:'service',description:'合成测试服务问题，验证三方售后方案'});
      users[2].role='admin';await assert.rejects(act(order,users[2],'proposeCase',{outcome:'refund',reason:'合成测试参与管理员必须回避'}),/参与/);users[2].role='user';
      await act(order,users[4],'proposeCase',{outcome:'refund',reason:'合成材料核实后按整笔订单全额模拟退回'});await act(order,users[0],'acceptCase');order=await act(order,users[1],'acceptCase');assert.equal(order.case.stage,'proposed');assert.equal(order.payment.refunded,0);
      order=await act(order,users[2],'acceptCase');assert.equal(order.case.stage,'closed');assert.equal(order.payment.refunded,2176);
      assert.equal(db.prepare("SELECT count(*) n FROM payment_jobs WHERE order_id=? AND action='refund'").get(order.id).n,1);
    });
    await t.test('两人KD均须披露；首局整体换队保存两人只读交接，等待期间可全额取消',async()=>{
      market.heartbeat(users[1]);market.heartbeat(users[2]);order=await accept(await pay(2,'topsecret'));
      await act(order,users[1],'start');await act(order,users[2],'start');await assert.rejects(act(order,users[0],'start'),/低 KD/);
      await act(order,users[0],'start',{acceptLowKd:true});await act(order,users[2],'beginRound');await act(order,users[2],'endRound',{result:'failed'});await act(order,users[0],'confirmRound',{index:0,agreed:true});await act(order,users[1],'confirmRound',{index:0,agreed:true});
      order=await act(order,users[0],'firstSwap');assert.equal(order.status,'matching');assert.equal(order.providers.length,0);assert.equal(order.elapsed,0);assert.equal(order.excludedProviders.length,2);
      for(const u of users.slice(1,3))assert.equal(latest(order,u).readOnly,true);
      order=await act(order,users[0],'cancel');assert.equal(order.payment.refunded,4176);
    });
    await t.test('重启保留小队、两名服务者记录与退款；退出后旧邀请码失效',async()=>{
      const old=market.squads.view(users[1].id).joinCode;await market.waitForIdle();providers.close();db.close();await setup();assert.equal(market.squads.view(users[2].id).members.length,2);assert.equal(latest(order).payment.refunded,4176);
      await cmd(users[2],'squadLeave');await assert.rejects(cmd(users[3],'squadJoin',{consent:true,code:old}),/失效/);assert.equal(market.squads.view(users[1].id).members.length,1);
    });
  }finally{await market?.waitForIdle();providers?.close();db?.close();const target=realpathSync(dir);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-dual-'));rmSync(target,{recursive:true});}
});
