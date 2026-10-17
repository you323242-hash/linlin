import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayStatus, orderStatusLabel, matchesOrderFilter, canRequestAftercare, eventText, nextOrderStep, orderAttentionPriority, resolveOrderAction, caseGuidance, providerFactsHtml, serviceProviderNames, messageAuthor } from '../dist/orders.mjs';
import { progressHtml } from '../dist/aftercare-ui.mjs';

test('双人订单展示双方游戏ID、标签与发言者；售后个人接受不能冒称整队接受',()=>{
  const order={providers:[{id:'p1',name:'甲',gameId:'game-one',tags:['报点']},{id:'p2',name:'乙<script>',gameId:'game-two',tags:['任务']} ]};
  const facts=providerFactsHtml(order);
  assert.match(facts,/game-one/);assert.match(facts,/game-two/);assert.match(facts,/报点/);assert.match(facts,/任务/);assert.doesNotMatch(facts,/<script>/);
  assert.equal(serviceProviderNames(order),'甲 / 乙<script>');
  assert.equal(messageAuthor({role:'provider',actorName:'乙'}),'服务者 · 乙');
  const c={stage:'proposed',openedAt:0,proposal:{accepted:{buyer:true,provider:true,providers:{p1:true,p2:false}}}};
  const html=progressHtml(c,'provider',order);
  assert.match(html,/消费者：已接受/);assert.match(html,/甲：已接受/);assert.match(html,/乙&lt;script&gt;：待回应/);assert.doesNotMatch(html,/服务者：已接受/);
});

test('售后引导区分申请方和回应方，复核不把原接受记录当作新方案确认',()=>{
  const order={case:{stage:'human',openedBy:'p2'},viewerId:'p2'};
  assert.match(caseGuidance(order),/你的申请/);
  order.viewerId='p1';assert.match(caseGuidance(order),/对方已提交/);
  order.viewerId='b';assert.match(caseGuidance(order),/不代表.*认定违规/);
  order.case.stage='appeal';assert.match(caseGuidance(order),/历史记录.*重新确认/);
  assert.match(caseGuidance({case:{stage:'human'},viewerId:'b'}),/补充/);
});

test('售后回应必须明确选择，缺失或篡改字段不默认为接受且不能改写其他操作', () => {
  for (const caseAction of [undefined, '', 'cancel', 'proposeCase']) assert.throws(() => resolveOrderAction('acceptCase', {caseAction}), /明确选择/);
  assert.equal(resolveOrderAction('acceptCase', {caseAction:'acceptCase'}), 'acceptCase');
  assert.equal(resolveOrderAction('acceptCase', {caseAction:'appealCase'}), 'appealCase');
  assert.equal(resolveOrderAction('pay', {caseAction:'cancel'}), 'pay');
});

test('退款结案不冒称正常完成服务，处理中争议仍优先展示售后',()=>{
  const order={status:'completed',payment:{status:'refunded',refunded:1088},case:{stage:'closed'}};
  assert.equal(orderStatusLabel(order),'已退款');
  assert.match(nextOrderStep(order,'buyer').title,/已退款/);
  assert.equal(nextOrderStep(order,'buyer').action,'view');
  assert.equal(orderStatusLabel({...order,payment:{status:'partially_refunded'}}),'已部分退款');
  order.case.stage='appeal';
  assert.equal(orderStatusLabel(order),'售后中');
  assert.match(nextOrderStep(order,'buyer').title,/复核/);
});

test('订单下一步按实际参与者和核对状态展示，不诱导重复开始或过早完成',()=>{
  const order={status:'ready',buyerId:'b',providerId:'p',start:{buyer:true,provider:false},rounds:[],payment:{status:'paid'}};
  assert.equal(nextOrderStep(order,'buyer').action,null);
  assert.equal(nextOrderStep(order,'provider').action,'start');
  assert.match(nextOrderStep({...order,status:'matching'},'provider').title,/自主接单/);
  assert.match(nextOrderStep({...order,status:'matching',offer:{expiresAt:1}},'provider').title,/邀请/);
  order.status='confirming';order.complete={buyer:false,provider:false};order.rounds=[{normal:false,reportedRole:'buyer',result:'failed'}];
  assert.equal(nextOrderStep(order,'buyer').action,null);
  assert.equal(nextOrderStep(order,'provider').action,'confirmRound');
  order.rounds[0].normal=true;
  assert.equal(nextOrderStep(order,'buyer').action,'finish');
  order.complete.buyer=true;
  assert.equal(nextOrderStep(order,'buyer').action,null);
  order.status='finishing';order.currentRound=false;
  assert.notEqual(nextOrderStep(order,'provider').action,'endRound');
});
test('售后优先于旧服务进度，已接受者不再被引导重复接受；历史仅查看',()=>{
  const order={status:'active',rounds:[],case:{stage:'proposed',proposal:{accepted:{buyer:true,provider:false}}}};
  assert.match(nextOrderStep(order,'buyer').title,/等待对方/);
  assert.match(nextOrderStep(order,'provider').title,/请回应/);
  assert.equal(nextOrderStep({...order,readOnly:true},'provider').action,'view');
  order.case.stage='appeal';order.case.materialRequests=[{forRole:'provider',respondedAt:null}];
  assert.match(nextOrderStep(order,'provider').title,/补证/);
  assert.match(nextOrderStep(order,'buyer').title,/复核/);
  assert.ok(orderAttentionPriority(order,'buyer')<orderAttentionPriority({status:'cancelled'},'buyer'));
  assert.ok(orderAttentionPriority({status:'active'},'buyer')<orderAttentionPriority({status:'pending'},'buyer'));
});

test('服务记录显示已记录身份，旧事件和未知身份不猜测操作者',()=>{
  assert.equal(eventText({label:'确认开始服务',actorRole:'buyer'}),'消费者 · 确认开始服务');
  assert.equal(eventText({label:'确认开始服务',actorRole:'provider'}),'服务者 · 确认开始服务');
  assert.equal(eventText({label:'确认开始服务',actorRole:'provider',actorName:'砚川'}),'服务者 · 砚川 · 确认开始服务');
  assert.equal(eventText({label:'支付成功',actorRole:'system'}),'系统 · 支付成功');
  assert.equal(eventText({label:'旧记录'}),'旧记录');
  assert.equal(eventText({label:'说明',actorRole:'<img>'}),'说明');
});

test('未支付与售后订单不计入待服务筛选',()=>{
  assert.equal(matchesOrderFilter({status:'pending'},'waiting'),false);
  assert.equal(matchesOrderFilter({status:'pending'},'pending'),true);
  assert.equal(matchesOrderFilter({status:'matching'},'waiting'),true);
  assert.equal(matchesOrderFilter({status:'ready',case:{stage:'human'}},'waiting'),false);
});

test('已完成订单的处理中售后仍进入售后筛选，关闭后恢复已完成', () => {
  const order = { status: 'completed', providerId: 'provider', payment: { status: 'paid' }, case: { stage: 'human' } };
  for (const stage of ['human','proposed','appeal']) {
    order.case.stage = stage;
    assert.equal(displayStatus(order), 'aftercare');
    assert.equal(matchesOrderFilter(order, 'aftercare'), true);
    assert.equal(matchesOrderFilter(order, 'completed'), false);
    assert.equal(canRequestAftercare(order), false);
  }
  order.case.stage = 'closed';
  assert.equal(displayStatus(order), 'completed');
  assert.equal(matchesOrderFilter(order, 'completed'), true);
  assert.equal(matchesOrderFilter(order, 'aftercare'), false);
  assert.equal(canRequestAftercare(order), true);
});
test('新服务者已接单的保障换人订单保留售后，退款中和只读历史不可重新申请', () => {
  const order = { status: 'ready', firstSwapUsed: true, providerId: 'provider', payment: { status: 'paid' } };
  assert.equal(canRequestAftercare(order), true);
  for (const status of ['refund_pending','refunded','partially_refunded']) assert.equal(canRequestAftercare({ ...order, payment: { status } }), false);
  assert.equal(canRequestAftercare({ ...order, readOnly: true }), false);
  assert.equal(displayStatus({ ...order, status: 'released', readOnly: true, case: { stage: 'human' } }), 'released');
  for (const status of ['pending','matching','cancelled']) assert.equal(canRequestAftercare({ ...order, status }), false);
  assert.equal(canRequestAftercare({ ...order, providerId: null }), false);
});
