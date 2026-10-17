import {isProvider,lowKd} from '../dist/order-participants.mjs';
export const CASE_LABELS = {service:'服务质量问题',serious:'挂机、辱骂等严重问题',zero:'全程未撤离',replace:'更换服务者',time:'服务时长异议',complaint:'其他投诉或举报'};
export function aftercareChecks(order, now=Date.now()) {
  const seconds = Math.min(order.duration,order.elapsed+(order.runningSince===null?0:Math.max(0,Math.floor((now-order.runningSince)/1000))));
  return {
    firstSwap:order.status==='active'&&!order.firstSwapUsed&&order.rounds.length===1&&order.rounds[0].normal&&order.rounds[0].result==='failed'&&!order.currentRound,
    zero:['confirming','completed'].includes(order.status)&&seconds>=3600&&!order.currentRound&&order.rounds.length>0&&order.rounds.every(r=>r.normal&&r.result==='failed')
  };
}
export function aftercareGuide(order,user,now=Date.now()) {
  const role=user.id===order.buyerId?'buyer':isProvider(order,user.id)?'provider':null;
  if(!role||order.readOnly) return null;
  const open=order.case&&order.case.stage!=='closed', checks=aftercareChecks(order,now), options=[];
  if(open) return {role,options,caseId:order.case.id,message:'本单已有处理中售后，请在原申请补充材料或查看方案，避免重复提交。'};
  if(role==='buyer'&&['pending','matching'].includes(order.status)&&order.elapsed===0&&['paid','unpaid'].includes(order.payment.status)) options.push({action:'cancel',label:order.payment.status==='paid'?'取消并全额模拟退款':'取消未支付订单',description:'系统校验状态后处理，无需提交责任证明。'});
  if(['ready','active','finishing','confirming','completed'].includes(order.status)&&order.providerId&&!['refund_pending','refunded','partially_refunded'].includes(order.payment.status)) {
    if(order.status==='ready'&&order.elapsed===0&&!order.firstSwapUsed&&!order.cancelRequest) options.push({action:'requestCancel',label:'尚未开始，协商取消',description:'对方同意后全额模拟退款；未回应不视为同意。'});
    if(role==='buyer'&&order.status==='ready'&&lowKd(order)) options.push({action:'declineKd',label:'不同意低KD，免费更换',description:'对应模式KD低于1.0，开始前可选择更换。'});
    if(role==='buyer'&&checks.firstSwap) options.push({action:'firstSwap',label:'首局未撤离，免费换人',description:'本单首局失败记录已确认；更换后完整时长重计，仅一次。'});
    for(const [kind,label] of Object.entries(CASE_LABELS)) if((role==='buyer'||['time','complaint'].includes(kind))&&(kind!=='zero'||checks.zero)) options.push({action:'request',kind,label,description:kind==='zero'?'记录满足申请条件，可申请50%体验退款；仍按现有售后方案确认流程处理。':'提交经过与材料，核实后提出方案，不自动认责。'});
  }
  return {role,options,message:options.length?'选择遇到的问题，系统将引导至可用的处理入口。':'当前没有可发起的新售后操作。支付或退款处理中请查看进度；历史售后仍可查看。',zeroHint:role==='buyer'&&['active','finishing','confirming','completed'].includes(order.status)&&!checks.zero?'零撤离体验退款需完成一小时、结束尾局，并确认全部正常对局均未撤离；当前记录尚不满足。':''};
}
export function aftercareMetrics(orders,now=Date.now()) {
  const cases=orders.flatMap(o=>[...(o.cases||[]),...(o.case?[o.case]:[])]);
  const known=cases.filter(c=>c.metricsVersion===1), closed=known.filter(c=>Number.isFinite(c.closedAt)), responded=known.filter(c=>Number.isFinite(c.firstReviewedAt));
  const avg=(items,key)=>items.length?Math.round(items.reduce((sum,c)=>sum+Math.max(0,c[key]-c.openedAt),0)/items.length/1000):null;
  return {total:cases.length,open:cases.filter(c=>c.stage!=='closed').length,tracked:known.length,legacy:cases.length-known.length,closedSamples:closed.length,responseSamples:responded.length,averageResponseSeconds:avg(responded,'firstReviewedAt'),averageResolutionSeconds:avg(closed,'closedAt'),humanActions:known.reduce((n,c)=>n+(c.humanActions||0),0),byKind:Object.entries(CASE_LABELS).map(([kind,label])=>({kind,label,total:cases.filter(c=>c.kind===kind).length,open:cases.filter(c=>c.kind===kind&&c.stage!=='closed').length})),asOf:now};
}

// Aggregate only case fields in SQLite: never pull every order's messages,
// private preferences or evidence payloads into a dashboard metrics scan.
export function aftercareMetricsFromDatabase(db, now=Date.now()) {
  const groups = db.prepare(`WITH cases(value) AS (
    SELECT j.value FROM orders o,json_each(json_extract(o.payload,'$.cases')) j
    UNION ALL SELECT json_extract(payload,'$.case') FROM orders WHERE json_type(payload,'$.case')='object'
  ), fields AS (
    SELECT json_extract(value,'$.kind') kind,json_extract(value,'$.stage') stage,
      json_extract(value,'$.metricsVersion') tracked,json_extract(value,'$.openedAt') opened,
      json_extract(value,'$.firstReviewedAt') responded,json_extract(value,'$.closedAt') closed,
      coalesce(json_extract(value,'$.humanActions'),0) actions FROM cases
  ) SELECT kind,count(*) total,sum(stage IS NULL OR stage<>'closed') open,
    sum(tracked=1) tracked,
    sum(tracked=1 AND typeof(closed) IN ('integer','real')) closedSamples,
    sum(tracked=1 AND typeof(responded) IN ('integer','real')) responseSamples,
    sum(CASE WHEN tracked=1 AND typeof(responded) IN ('integer','real') THEN max(0,responded-opened) ELSE 0 END) responseMs,
    sum(CASE WHEN tracked=1 AND typeof(closed) IN ('integer','real') THEN max(0,closed-opened) ELSE 0 END) resolutionMs,
    sum(CASE WHEN tracked=1 THEN actions ELSE 0 END) humanActions FROM fields GROUP BY kind`).all();
  const sum = field => groups.reduce((n,row)=>n+(row[field]||0),0);
  const total=sum('total'), tracked=sum('tracked'), closedSamples=sum('closedSamples'), responseSamples=sum('responseSamples');
  return {total,open:sum('open'),tracked,legacy:total-tracked,closedSamples,responseSamples,
    averageResponseSeconds:responseSamples?Math.round(sum('responseMs')/responseSamples/1000):null,
    averageResolutionSeconds:closedSamples?Math.round(sum('resolutionMs')/closedSamples/1000):null,
    humanActions:sum('humanActions'),byKind:Object.entries(CASE_LABELS).map(([kind,label])=>({kind,label,total:groups.find(row=>row.kind===kind)?.total||0,open:groups.find(row=>row.kind===kind)?.open||0})),asOf:now};
}
