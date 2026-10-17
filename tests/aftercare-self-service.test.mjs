import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAuth} from '../server/auth.mjs';
import {createMarket} from '../server/market.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {aftercareGuide,aftercareMetrics} from '../server/aftercare.mjs';
import {progressHtml,guideHtml} from '../dist/aftercare-ui.mjs';
test('售后指引与时间统计不扩张权限或伪造旧记录',()=>{
 const order={buyerId:'b',providerId:'p',provider:{kd:.8},status:'ready',duration:3600,elapsed:0,runningSince:null,payment:{status:'paid'},rounds:[],firstSwapUsed:false};
 assert.equal(aftercareGuide(order,{id:'stranger'}),null);
 assert.ok(aftercareGuide(order,{id:'b'}).options.some(o=>o.action==='declineKd'));
 assert.ok(!aftercareGuide(order,{id:'p'}).options.some(o=>o.kind==='service'));
 order.status='matching';order.providerId=null;order.firstSwapUsed=true;
 assert.ok(aftercareGuide(order,{id:'b'}).options.some(o=>o.action==='cancel'));
 order.payment.status='processing';assert.equal(aftercareGuide(order,{id:'b'}).options.length,0);
 const m=aftercareMetrics([{cases:[{kind:'service',stage:'closed',openedAt:0}],case:{kind:'time',stage:'human',openedAt:10}}]);
 assert.equal(m.legacy,2); assert.equal(m.averageResolutionSeconds,null);
 const html=progressHtml({stage:'human',openedAt:1000,context:{occurredWhen:'<img src=x>'},materialRequests:[{forRole:'buyer',description:'<svg onload=x>',at:2000}]},'buyer');
 assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<svg'));assert.ok(html.includes('待回应'));
});
test('真实售后补证、回应、复核与指标持久化', async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'delta-aftercare-'));let database,providers,market,clock=Date.now(),users=[];
 const setup=async()=>{const result=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:dir});database=result.database;providers=createLocalProviders({directory:dir});market=createMarket(database,providers,{now:()=>clock});return result.auth;};
 const call=(u,scope,body={})=>market.command(u,scope,{...body,requestId:body.requestId||randomUUID()});
 const act=async(o,u,action,body={})=>(await call(u,o.id+':'+action,{version:action==='accept'?o.version:market.readOrder(o.id,u).version,...body})).order;
 let o,request;
 try {
  const auth=await setup();for(let i=0;i<4;i++) users.push((await auth.api.signUpEmail({body:{name:'售后测试'+i,email:'aftercare'+i+'@example.test',password:'Aftercare-local-2026!',termsAccepted:true}})).user);
  users[2].role='admin';database.prepare('UPDATE user SET role=? WHERE id=?').run('admin',users[2].id);
  await call(users[1],'profile',{adult:true,gameId:'LOCAL',introduction:'仅测试正常沟通与服务资料',modes:['secret'],stats:{secret:{kd:1.2,gear:4}},available:true});
  o=(await call(users[0],'create',{mode:'secret',rulesAccepted:true})).order;
  assert.ok(o.aftercareGuide.options.some(x=>x.action==='cancel'));
  o=await act(o,users[0],'pay');o=await act(o,users[1],'accept');
  await t.test('分类申请保留上下文，重复申请不制造新案例',async()=>{
   o=await act(o,users[0],'request',{kind:'service',description:'仅测试沟通异常，描述发生经过',occurredWhen:'入队后，尚未开始计时',expectation:'refund'});
   assert.equal(o.case.context.expectation,'refund');assert.equal(o.aftercareGuide.options.length,0);assert.ok(guideHtml(o).includes('原售后'));
   await assert.rejects(act(o,users[0],'request',{kind:'complaint',description:'重复提交同一未解决问题'}),/已有/);
  });
  await t.test('非管理员不能请求补证，管理员要求幂等且留痕',async()=>{
   await assert.rejects(act(o,users[1],'requestMaterials',{forRole:'buyer',reason:'请补充问题发生时的相关记录'}),/管理员/);
   const oldRole=users[0].role; users[0].role='admin'; database.prepare('UPDATE user SET role=? WHERE id=?').run('admin',users[0].id);
   await assert.rejects(act(o,users[0],'requestMaterials',{forRole:'provider',reason:'参与订单的管理员不能自行要求对方补证'}),/自己参与/);
   users[0].role=oldRole; database.prepare('UPDATE user SET role=? WHERE id=?').run(oldRole,users[0].id);
   clock+=60_000;const body={version:o.version,requestId:randomUUID(),forRole:'buyer',reason:'请说明发生在第几局，并提供相关聊天摘要'};
   o=(await call(users[2],o.id+':requestMaterials',body)).order;
   const again=(await call(users[2],o.id+':requestMaterials',body)).order;
   assert.equal(again.version,o.version);assert.equal(o.case.humanActions,1);request=o.case.materialRequests[0];
   assert.ok(market.adminData(users[2]).audit.some(x=>x.action==='requestMaterials'));
   await assert.rejects(act(o,users[2],'requestMaterials',{forRole:'admin',reason:'无效对象应拒绝并保持记录不变'}),/对象/);
  });
  await t.test('补证仅本人可回应，材料保留且跨重启恢复',async()=>{
   await assert.rejects(act(o,users[1],'supplement',{description:'其他人不能替消费者回应材料',answeredMaterialRequestId:request.id}),/无权/);
   clock+=60_000;o=await act(o,users[0],'supplement',{description:'问题发生在入队之后，补充沟通经过',answeredMaterialRequestId:request.id});
   assert.equal(o.case.materialRequests[0].respondedAt,clock);
   providers.close();database.close();await setup();o=market.readOrder(o.id,users[0]);assert.equal(o.case.materialRequests.length,1);assert.ok(o.case.notes.length===1);
  });
  await t.test('确认方案后结案，耗时和人工次数不计入用户操作',async()=>{
   clock+=60_000;o=await act(o,users[2],'proposeCase',{outcome:'refund',reason:'仅测试人工核实后按照已确定比例处理'});
   assert.ok(progressHtml(o.case,'buyer').includes('待回应'));
   o=await act(o,users[0],'acceptCase');clock+=60_000;o=await act(o,users[1],'acceptCase');
   assert.equal(o.case.stage,'closed');assert.equal(o.case.closedAt,clock);assert.equal(o.payment.refunded,1088);
   const m=market.adminData(users[2]).aftercareMetrics;assert.equal(m.total,1);assert.equal(m.humanActions,2);assert.equal(m.averageResponseSeconds,60);assert.equal(m.averageResolutionSeconds,240);assert.equal(m.open,0);
   await assert.rejects(Promise.resolve().then(()=>market.adminData(users[0])),/管理员/);
   assert.ok(o.aftercareGuide.options.length===0);
  });
 } finally {providers?.close();database?.close();rmSync(dir,{recursive:true,force:true});}
});
