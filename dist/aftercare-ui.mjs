import {escapeHtml as esc} from './business-api.mjs';
const stageText={human:'等待核实',proposed:'等待参与者确认',appeal:'等待人工复核',closed:'已处理'};
const expectations={refund:'申请退款',replace:'更换服务者',adjustTime:'校正时长',explanation:'核实并说明'};
export const materialHelp={service:'说明发生在哪局、服务态度或配合出现了什么问题，可补充相关聊天或录音。',serious:'说明挂机、辱骂等具体行为、发生时间及影响，可补充截图或录音。',zero:'核对服务时长及已确认的对局记录；正常失败本身不等于违规。',replace:'说明希望换人的原因；符合首局保障时优先使用免费换人入口。',time:'说明你认为的开始、暂停或结束时间，与平台记录有何差异。',complaint:'说明具体行为及相关经过，避免只给结论；可以先提交文字，再补相关材料。'};
export function proposalResponses(c,order) {
  const accepted=c.proposal?.accepted;
  if(!accepted)return '';
  const people=order?.providers || [];
  return '消费者：'+(accepted.buyer?'已接受':'待回应')+' · '+(people.length===2?people.map(p=>esc(p.name)+'：'+(accepted.providers?.[p.id]?'已接受':'待回应')).join(' · '):'服务者：'+(accepted.provider?'已接受':'待回应'));
}
export function progressHtml(c,role,order) {
  if(!c) return '';
  const requests=(c.materialRequests||[]), pending=requests.filter(r=>r.respondedAt==null), mine=pending.filter(r=>r.forRole===role);
  return '<section class="aftercare-progress"><h3>售后进度 · '+esc(stageText[c.stage]||'处理中')+'</h3><p>申请时间：'+esc(new Date(c.openedAt).toLocaleString('zh-CN'))+(c.closedAt!=null?' · 处理时间：'+esc(new Date(c.closedAt).toLocaleString('zh-CN')):'')+'</p><ol class="aftercare-steps"><li>已提交</li><li>'+(['proposed','closed'].includes(c.stage)?'已核实':c.stage==='appeal'?'复核中':'核实中')+'</li><li>'+(c.proposal?'已提出方案':'待出方案')+'</li><li>'+(c.stage==='closed'?'已处理':'待确认 / 处理')+'</li></ol>'+(c.context?.occurredWhen?'<p>发生时间或对局：'+esc(c.context.occurredWhen)+'</p>':'')+(c.context?.expectation?'<p>申请诉求：'+esc(expectations[c.context.expectation])+'（不代表处理结果）</p>':'')+(c.stage==='proposed'?'<p>'+proposalResponses(c,order)+'。有异议可申请复核；不会因未回应自动认责。</p>':'')+(c.stage==='human'||c.stage==='appeal'?'<p>'+(mine.length?'你有待回应的补证要求，请在原售后补充说明。':pending.length?(role==='admin'?'有待回应的补证要求，可查看双方提交情况。':'对方有待回应的补证要求，你仍可陈述与举证。'):'如有相关材料，可继续补充；无需重复发起申请。')+'</p>':'')+requests.map(r=>'<div class="material-request"><strong>'+esc(r.forRole==='buyer'?'消费者补证要求':'服务者补证要求')+'</strong><p>'+esc(r.description)+'</p><small>'+(r.respondedAt!=null?'已提交回应':'尚未回应')+' · 提出于'+esc(new Date(r.at).toLocaleString('zh-CN'))+'</small></div>').join('')+'<p class="evidence-note">材料用于核实，不自动认责；缺少录音不影响提交文字申请。附件请遮盖无关隐私。</p></section>';
}
export function guideHtml(order) {
  const g=order.aftercareGuide;
  if(!g) return '<p>历史或非本人订单只供查看；不能发起新的售后。</p>';
  return '<p>'+esc(g.message)+'</p>'+ (g.caseId?progressHtml(order.case,g.role,order)+'<button type="button" class="order-button primary" data-order-action="case" data-order-id="'+order.id+'">查看原售后与处理方案</button>':'<div class="aftercare-options">'+g.options.map(o=>'<button type="button" class="aftercare-option" data-order-action="'+esc(o.action)+'" data-order-id="'+esc(order.id)+'"'+(o.kind?' data-case-kind="'+esc(o.kind)+'"':'')+'><strong>'+esc(o.label)+'</strong><span>'+esc(o.description)+'</span></button>').join('')+'</div>')+(g.zeroHint?'<p class="evidence-note">'+esc(g.zeroHint)+'</p>':'')+'<p><a href="./rules.html#order-notice" data-document="order-notice">已确认的点单须知</a> · <a href="./rules.html#aftercare-draft" data-document="aftercare-draft">售后草案（新增建议待确认）</a></p>';
}

