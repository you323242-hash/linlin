import {isProvider,providerCount,lowKd} from './order-participants.mjs';
import {guideHtml, progressHtml, materialHelp} from './aftercare-ui.mjs?v=2';
import { demandSummary, demandPreview } from './matching-ui.mjs';
import { mountEvidence } from './evidence-ui.mjs';
import { api, showError } from './business-api.mjs';
import {readIdentityView,saveIdentityView} from './identity-view.mjs';
import { PRODUCTS } from './catalog.mjs?v=4';
export const MODES = Object.fromEntries(PRODUCTS.map(product => [product.id, { name: product.title, short: product.shortTitle, price: product.price, gear: product.gear, art: product.image.split('/').pop() }]));
const STATUS = { pending: '待支付', matching: '待匹配', ready: '待开始', active: '服务中', finishing: '完成尾局中', confirming: '待确认', aftercare: '售后中', completed: '已完成', cancelled: '已取消', released: '已交接' };
const FILTERS = [['all', '全部'], ['pending', '待支付'], ['waiting', '待服务'], ['serving', '进行中'], ['confirming', '待确认'], ['aftercare', '售后'], ['completed', '已完成'], ['cancelled', '已取消']];
const REQUESTS = { service: '服务质量退款', serious: '严重违规退款', zero: '零撤离体验退款', replace: '申请更换陪玩', time: '申请时长调整', complaint: '服务投诉 / 举报' };
const money = cents => `¥${(cents / 100).toFixed(2)}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const serviceProviders = order => order.providers?.length ? order.providers : order.provider ? [order.provider] : [];
export const serviceProviderNames = order => serviceProviders(order).map(p=>p.name).join(' / ');
export function providerFactsHtml(order) {
  return serviceProviders(order).map(p=>'<dt>'+escapeHtml(serviceProviders(order).length>1?p.name+' · 游戏 ID':'服务者游戏 ID')+'</dt><dd>'+escapeHtml(p.gameId)+'</dd>'+(p.tags?.length?'<dt>'+escapeHtml(p.name)+' · 服务标签</dt><dd>'+p.tags.map(escapeHtml).join(' · ')+'</dd>':'')).join('');
}
export const messageAuthor = message => (message.role === 'buyer' ? '消费者' : '服务者') + (message.actorName ? ' · '+message.actorName : '');
export const eventText = event => (({buyer:'消费者',provider:'服务者',system:'系统',admin:'平台管理'})[event.actorRole] ? ({buyer:'消费者',provider:'服务者',system:'系统',admin:'平台管理'})[event.actorRole]+' · ' : '') + (event.actorName ? event.actorName+' · ' : '') + (event.label || '');
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const timeText = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

let serverOffset = 0;
export function elapsedSeconds(o, now = Date.now()+serverOffset) { return Math.min(o.duration, o.elapsed+(o.runningSince===null?0:Math.max(0,Math.floor((now-o.runningSince)/1000)))); }
export function eligibility(o) { return { firstSwap:o.status==='active'&&!o.firstSwapUsed&&o.rounds.length===1&&o.rounds[0].normal&&o.rounds[0].result==='failed'&&!o.currentRound, zeroRefund:['confirming','completed'].includes(o.status)&&elapsedSeconds(o)>=3600&&!o.currentRound&&o.rounds.length>0&&o.rounds.every(r=>r.normal&&r.result==='failed') }; }
export const hasOpenCase = order => !order.readOnly && !!order.case && order.case.stage !== 'closed';
export const displayStatus = order => hasOpenCase(order) ? 'aftercare' : order.status;
export const orderStatusLabel = order => !hasOpenCase(order) && order.payment?.status === 'refunded' ? '已退款' : !hasOpenCase(order) && order.payment?.status === 'partially_refunded' ? '已部分退款' : STATUS[displayStatus(order)];
export const canRequestAftercare = order => !order.readOnly && !!order.providerId && !hasOpenCase(order) && ['ready','active','finishing','confirming','completed'].includes(order.status) && !['refund_pending','refunded','partially_refunded'].includes(order.payment.status);
export const matchesOrderFilter = (order, filter) => filter === 'all' || (filter === 'waiting' ? ['matching','ready'].includes(displayStatus(order)) : filter === 'serving' ? ['active','finishing'].includes(displayStatus(order)) : displayStatus(order) === filter);
const roundNeedsConfirmation=(order,round,role)=>!round.normal&&(providerCount(order)===2 ? !!order.viewerId && !(round.confirmedIds||[round.reportedBy]).includes(order.viewerId) : role!==(round.reportedRole||'provider'));
export const needsRoundConfirmation = (order, role) => order.rounds.some(r => roundNeedsConfirmation(order,r,role));
export const belongsToIdentity = (order, role, userId) => !!userId && (role === 'provider' ? isProvider(order,userId) : role === 'buyer' && order.buyerId === userId);
export function resolveOrderAction(action, fields) {
  if (action !== 'acceptCase') return action;
  if (!['acceptCase', 'appealCase'].includes(fields.caseAction)) throw new Error('请明确选择接受方案或提出异议。');
  return fields.caseAction;
}
export function caseGuidance(order) {
  const c = order.case;
  if (c?.stage === 'appeal') return '原方案正在复核；此前回应仅保留为历史记录，新方案需重新确认。';
  if (c?.stage === 'human' && c.openedBy && order.viewerId) return c.openedBy === order.viewerId
    ? '你的申请已提交，可在原申请补充说明和附件，无需重复投诉。'
    : '对方已提交售后申请，请查看具体经过并陈述、举证；申请本身不代表你已被认定违规。';
  return '可在原申请补充说明和附件，无需重复投诉。';
}
// Guidance follows the server snapshot; it never grants permission or changes order state.
export function nextOrderStep(order, role) {
  const step = (title, description, action = null, label = '') => ({title, description, action, label});
  if (order.readOnly) return step('历史服务记录', '本段服务已交接，仅保留记录。', 'view', '查看记录');
  if (hasOpenCase(order)) {
    const c = order.case;
    if (c.stage === 'proposed') return c.proposal?.accepted?.[role]
      ? step('等待对方回应方案', '你已接受；如有异议，仍可申请复核。', 'case', '查看处理方案')
      : step('请回应售后方案', '先阅读处理依据，再选择接受或提出异议。', 'case', '查看并回应');
    const mine = (c.materialRequests || []).some(r => r.forRole === role && r.respondedAt == null);
    return step(mine ? '请回应补证要求' : c.stage === 'appeal' ? '等待售后复核' : '等待核实售后', caseGuidance(order), 'case', mine ? '补充材料' : '查看售后进度');
  }
  if (order.payment?.status === 'refund_pending') return step('模拟退款处理中', '状态由后台更新，请稍后刷新订单。');
  if (order.payment?.status === 'refunded') return step('售后已处理 · 已退款', '本单已全额模拟退款，服务已经结束；详情保留处理依据和记录。', 'view', '查看退款记录');
  if (order.payment?.status === 'partially_refunded') return step('售后已处理 · 部分退款', '已退款金额与处理依据可在详情查看。', 'view', '查看退款记录');
  if (order.status === 'cancelled') return step('订单已取消', order.payment?.refunded ? '模拟退款记录可在详情查看。' : '本单已结束，不再推进服务。', 'view', '查看记录');
  if (order.status === 'pending') return order.payment?.status === 'processing'
    ? step('模拟支付处理中', '请等待结果，不要重复付款。')
    : step('请确认模拟支付', '金额以订单为准；当前测试不产生真实扣款。', 'pay', '查看金额并确认');
  if (order.status === 'matching') return role === 'provider'
    ? step(order.offer ? '收到接单邀请' : '可自主接单', order.offer ? '请核对需求，并在邀请有效期内回应。' : '请核对模式与服务需求，确认能够履约后接单。', 'accept', '查看需求并接单')
    : step('等待服务者接单', order.firstSwapUsed ? '换人匹配中；也可取消并全额模拟退款。' : '系统按模式与需求匹配在线服务者。');
  if (order.status === 'ready') {
    if (order.cancelRequest) {
      const mine = order.viewerId || (role === 'buyer' ? order.buyerId : order.providerId);
      return (order.cancelRequest.by === mine || order.cancelRequest.accepted?.includes(mine)) ? step('等待对方回应取消', '服务尚未开始；协商一致后取消并模拟退款。') : step('请回应取消申请', '先查看原因，再决定同意或继续沟通。', 'respondCancel', '查看取消申请');
    }
    return order.start?.[role] ? step('等待对方确认开始', '你已确认；全体参与者确认后才开始计时。') : step('入队后确认开始', '先在游戏内组队，全体参与者分别确认后起算。', 'start', '确认已入队');
  }
  if (['active','finishing','confirming'].includes(order.status)) {
    if (needsRoundConfirmation(order, role)) return step('请核对对方的对局记录', '确认准确再提交；有异议可直接进入售后。', 'confirmRound', '核对对局结果');
    if (order.rounds.some(r => !r.normal)) return step('等待对方核对结果', '单方提交不认定结果，也不自动判定退款。');
    if (order.currentRound) return step(order.status === 'finishing' ? '完成当前尾局' : '正在对局中', '对局结束后，一人提交结果，另一人核对。', 'endRound', '提交对局结果');
    if (order.status === 'confirming') return order.complete?.[role] ? step('等待对方确认完成', '你已确认，全部参与者确认后订单完成。') : step('请确认服务完成', '服务时长与对局已核对，请确认本次履约。', 'finish', '确认服务完成');
    if (order.status === 'active') return step('下一局开始时登记', '每局一人登记即可，其余参与者无需重复操作。', 'beginRound', '登记开始对局');
    return step('服务时长已满', '请刷新查看当前尾局和确认状态。');
  }
  if (order.status === 'completed') return role === 'buyer' && !order.review ? step('服务已完成', '根据本次真实体验评价，不预设评分。', 'review', '评价本次服务') : step('服务已完成', '服务记录与评价可随时查看。', 'view', '查看订单详情');
  return step('请查看订单状态', '按最新订单详情继续操作。', 'view', '查看订单');
}
export const orderAttentionPriority = (order, role) => hasOpenCase(order) ? 0 : ['active','finishing','confirming'].includes(order.status) ? 1 : order.status === 'ready' ? 2 : order.status === 'matching' && role === 'provider' && order.offer ? 2 : order.status === 'matching' ? 3 : order.status === 'pending' ? 4 : 5;
if (typeof document !== 'undefined') startOrders();
export async function startOrders() {
  let orders = [];
  const identity=(await api('/api/me').catch(()=>null))?.user;
  let role = readIdentityView(identity?.id,new URL(location.href).searchParams.get('role')), filter = 'all', selectedId = new URL(location.href).searchParams.get('order');
  let detailId = null, actionId = null, toastTimer, refreshSequence = 0, orderLoadError = null;
  const $ = selector => document.querySelector(selector);
  const aftercareDrafts = new Map();
  const detailDialog = $('#order-detail'), actionDialog = $('#order-action');
  const matches = order => matchesOrderFilter(order, filter);
  const badge = order => `<span class="status-badge status-${displayStatus(order)}">${orderStatusLabel(order)}</span>`;
  const button = (action, label, order, className = '', disabled = false) => `<button type="button" class="order-button ${className}" data-order-action="${action}" data-order-id="${order.id}"${disabled ? ' disabled' : ''}>${label}</button>`;
  function toast(message) {
    const target = $('#order-toast'); target.textContent = message; target.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { target.hidden = true; }, 4500);
  }
  function currentInfo(order) {
    if (order.readOnly) return '此段服务已交接，保留你的历史记录；后续沟通与服务由当前服务者处理。';
    if (hasOpenCase(order) && ['human','appeal'].includes(order.case.stage) && (order.case.materialRequests||[]).some(r=>r.forRole===role&&r.respondedAt==null)) return '你有待回应的补证要求，请查看原售后并补充说明。';
    if (hasOpenCase(order)) return order.case.stage === 'proposed' ? '处理方案待全体确认；有异议可申请人工复核。' : caseGuidance(order);
    if (order.payment.status === 'refunded') return '已全额模拟退款，本单服务已结束；处理依据保留在详情中。';
    if (order.payment.status === 'partially_refunded') return '已部分模拟退款，金额和处理记录可在详情查看。';
    if (order.status === 'ready' && order.cancelRequest) return '协商取消待回应：'+escapeHtml(order.cancelRequest.reason);
    if (order.status === 'pending') return order.payment.status === 'processing' ? '模拟支付处理中，请稍后刷新。' : '订单已保存，请完成模拟支付。';
    if (order.status === 'matching' && order.offer) return '已收到接单邀请，请在 '+new Date(order.offer.expiresAt).toLocaleTimeString('zh-CN')+' 前接受或跳过。';
    if (order.status === 'matching') return order.firstSwapUsed ? '正在重新匹配，确认后完整时长重计。' : '等待符合模式要求的陪玩接单。';
    if (order.status === 'ready') return lowKd(order) ? '对应模式 KD 已披露，请确认或免费更换。' : '入队并完成全部参与者确认后开始计时。';
    if (order.status === 'active' && order.rounds.some(r=>!r.normal)) return needsRoundConfirmation(order,role) ? '对方提交了对局结果，请核对。记录有异议时请提交售后，不要误确认。' : '对局结果已提交，等待对方核对；未核对的记录不用于保障判断。';
    if (order.status === 'active') return eligibility(order).firstSwap ? '首局未撤离，免费换人权益可用。' : order.currentRound ? '正在对局中，按已确认时长服务。' : '服务进行中，请保持正常沟通与配合。';
    if (order.status === 'finishing') return '完成当前对局后结束，合理延续不加收费用。';
    if (order.status === 'confirming') return '请核对服务记录并确认完成。';
    if (order.status === 'aftercare') return order.case.stage === 'human' ? '等待人工复核，可继续补充材料。' : order.case.stage === 'proposed' ? '处理方案待全体确认，有异议可申请复核。' : '异议已提交，等待人工复核。';
    if (order.status === 'completed') return order.review ? '已完成服务评价，感谢你的反馈。' : '服务已完成，留下本次真实体验。';
    return '订单已取消，可重新选择服务。';
  }
  function actions(order, compact = false, excludedAction = null) {
    return primaryActions(order, compact, excludedAction) + (order.aftercareGuide ? button('guide',hasOpenCase(order)?'售后指引':'售后 / 自助处理',order) : canRequestAftercare(order) ? button('request','申请售后 / 投诉',order) : '');
  }
  function primaryActions(order, compact = false, excludedAction = null) {
    const actionButton = (action, ...args) => action === excludedAction ? '' : button(action, ...args);
    if (order.readOnly) return actionButton('view', '历史服务记录', order);
    if (hasOpenCase(order)) return actionButton('case',order.case.stage === 'proposed' ? '查看处理方案' : '查看售后进度',order,'primary') + (!compact && ['human','appeal'].includes(order.case.stage) ? actionButton('supplement',role === 'buyer' ? '补充材料' : '陈述与举证',order) : '');
    if (order.status === 'pending') return (order.newPaymentAllowed === false ? '<span class="order-tip">暂不接受新的付款；如已提交付款，系统将继续处理。</span>' : actionButton('pay', '模拟支付（不扣款）', order, 'primary', order.payment.status === 'processing')) + actionButton('cancel', '取消订单', order);
    if (order.status === 'matching') return role === 'provider' ? actionButton('accept', order.offer ? '接受邀请' : '接受订单', order, 'primary') + (order.offer ? actionButton('declineOffer', '跳过邀请', order) : '') : actionButton('cancel', order.firstSwapUsed ? '取消换人并退款' : '取消匹配', order);
    if (order.status === 'ready') { const mine = order.viewerId || (role === 'buyer' ? order.buyerId : order.providerId); return order.cancelRequest ? ((order.cancelRequest.by === mine || order.cancelRequest.accepted?.includes(mine)) ? actionButton('remind','提醒对方',order) : actionButton('respondCancel','回应取消申请',order,'primary')) : actionButton('start',order.start[role] ? '已确认，等待对方' : '确认开始',order,'primary',order.start[role]) + actionButton('contact','联系对方',order) + (!order.firstSwapUsed && order.elapsed === 0 ? actionButton('requestCancel','协商取消',order) : '') + (role === 'buyer' && lowKd(order) ? actionButton('declineKd','低KD免费更换',order) : ''); }
    if (order.status === 'active') return (needsRoundConfirmation(order, role) ? actionButton('confirmRound', '核对对局结果', order, 'primary') : '') + actionButton(order.currentRound ? 'endRound' : 'beginRound', order.currentRound ? '提交对局结果' : '登记开始对局', order, 'primary') + actionButton('contact', '订单沟通', order) + (role === 'buyer' ? actionButton('swap', eligibility(order).firstSwap ? '首局免费换人' : '申请换人', order) : '');
    if (order.status === 'finishing') return (needsRoundConfirmation(order, role) ? actionButton('confirmRound', '核对对局结果', order, 'primary') : '') + (order.currentRound ? actionButton('endRound', '提交尾局结果', order, 'primary') : '') + actionButton('contact', '订单沟通', order);
    if (order.status === 'confirming') return actionButton('remind','提醒确认',order) + (needsRoundConfirmation(order, role) ? actionButton('confirmRound', '核对对局结果', order) : '') + actionButton('finish', order.complete[role] ? '等待对方确认' : '确认完成', order, 'primary', order.complete[role] || order.rounds.some(r=>!r.normal)) + (role === 'buyer' && eligibility(order).zeroRefund ? actionButton('zero', '体验退款', order) : '');
    if (order.status === 'aftercare') return actionButton('case', '查看售后', order, 'primary') + (!compact ? actionButton('supplement', role === 'buyer' ? '补充材料' : '陈述与举证', order) : '');
    if (order.status === 'completed' && order.case && order.case.stage !== 'closed') return actionButton('case', '查看售后', order, 'primary');
    if (order.status === 'completed') return role === 'buyer' && !order.review ? actionButton('review', '评价服务', order, 'primary') : actionButton('view', role === 'provider' ? '查看订单详情' : '查看评价', order);
    return `<a class="order-button" href="./index.html#services">重新选购</a>`;
  }
  function providerRow(order) {
    const list=order.providers?.length?order.providers:order.provider?[order.provider]:[];
    if(list.length===2)return list.map(p=>`<div class="provider-row"><span class="initial-avatar">${escapeHtml(Array.from(p.name)[0])}</span><div><strong>${escapeHtml(p.name)}</strong><small>${order.case?.stage==='proposed'?(order.case.proposal.accepted.providers?.[p.id]?'已接受方案':'待本人回应方案'):order.status==='confirming'?(order.complete.providers?.[p.id]?'已确认完成':'待本人确认完成'):order.start?.providers?.[p.id]?'已确认开始':'待本人确认开始'} · 游戏ID ${escapeHtml(p.gameId)}</small></div><div class="provider-meta">KD ${p.kd.toFixed(2)}<br>${p.gear} 套装备</div></div>`).join('');
    const p = order.provider;
    return p ? `<div class="provider-row"><span class="initial-avatar" aria-hidden="true">${escapeHtml(Array.from(p.name)[0])}</span><div><strong>${escapeHtml(p.name)}</strong><small>服务者自报资料 · 非平台认证${p.tags?.length ? " · "+p.tags.map(escapeHtml).join(" / ") : ""}${p.trialAvailable ? " · 愿意自愿试音" : ""}</small></div><div class="provider-meta">${order.snapshot.shortTitle} KD ${p.kd.toFixed(2)}<br>${p.gear} 套装备</div></div>` : `<div class="provider-row"><span class="initial-avatar">${icon('headset')}</span><div><strong>${order.status === 'cancelled' ? '本单已取消' : order.status === 'pending' ? '尚未分配服务者' : '等待服务者接单'}</strong><small>${order.status === 'cancelled' ? '退款进度可在订单详情查看' : '接单速度以在线服务者情况为准'}</small></div></div>`;
  }
  function timer(order) {
    const seconds = elapsedSeconds(order);
    return `<div class="service-timer"><small>${order.status === 'aftercare' ? '计时已暂停' : order.status === 'finishing' ? '约定时长已满' : '已服务时长'}</small><div class="timer-reading"><strong data-clock="${order.id}">${timeText(seconds)}</strong><span>/ ${timeText(order.duration)}</span></div><progress class="service-progress" data-progress="${order.id}" max="${order.duration}" value="${seconds}" aria-label="已服务时长"></progress><p class="timer-caption">${order.status === 'ready' || order.status === 'matching' ? '未完成全体确认前，不计入服务时长。' : order.status === 'finishing' ? '合理尾局延续不加收费用，结果计入本单。' : order.status === 'aftercare' ? '售后暂停期间不消耗购买时长。' : `购买时长 60 分钟 · ${order.firstSwapUsed ? '已使用首局换人权益' : '全体确认起算'}`}</p></div>`;
  }
  function serviceSteps(order) {
    const stage = ({pending:0,matching:0,ready:1,active:2,finishing:2,confirming:3,completed:4})[order.status];
    if (stage === undefined || order.readOnly) return '';
    return '<ol class="service-steps" aria-label="服务进度">'+['匹配','入队','对局','完成'].map((name,i)=>'<li '+(stage===i?'aria-current="step"':'')+' class="'+(stage>i?'done':'')+'"><span>'+(i+1)+'</span>'+name+'</li>').join('')+'</ol>';
  }
  function nextStepHtml(order, inDetail = false) {
    const step = nextOrderStep(order, role);
    const actionable = step.action && !(inDetail && step.action === 'view');
    const waiting = !step.action || step.action === 'view' || /^等待/.test(step.title);
    return `<section class="order-next-step" aria-label="当前下一步"><span class="next-step-symbol" aria-hidden="true">${icon(waiting ? 'clock' : 'arrow')}</span><div><small>${waiting ? '当前进度' : '轮到你处理'}</small><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.description)}</p></div>${actionable ? button(step.action,step.label,order,'primary') : ''}</section>`;
  }
  function secondaryActions(order) {
    return actions(order, false, nextOrderStep(order,role).action).replaceAll('class="order-button primary"','class="order-button"');
  }
  function renderQuick(order) {
    $('#quick-panel').innerHTML = order ? `<section class="quick-card"><div class="quick-art"><img src="${order.snapshot.image}" alt=""/><div><small>当前选中订单</small><h2>${order.snapshot.title}</h2></div></div><div class="quick-content"><div class="quick-label"><span>${order.id}</span>${badge(order)}</div>${providerRow(order)}${demandPreview(order)}${timer(order)}${serviceSteps(order)}${nextStepHtml(order)}<div class="quick-actions secondary-actions">${secondaryActions(order)}</div><button class="quick-details" type="button" data-order-action="view" data-order-id="${order.id}">订单详情与服务记录</button></div></section>` : `<section class="quick-card"><div class="quick-content"><p class="quick-info">选择一笔订单查看服务进度。</p></div></section>`;
  }
  function render() {
    document.querySelectorAll('.view-toggle button[data-role]').forEach(element => element.setAttribute('aria-pressed', String(element.dataset.role === role)));
    $('main h1').textContent=role==='provider'?'接单订单':'消费订单';
    if (orderLoadError) {
      $('#order-summary').hidden = true;
      $('#record-count').textContent = '暂时无法读取';
      $('#quick-panel').innerHTML = '<section class="quick-card"><div class="quick-content"><p class="quick-info">订单服务暂不可用，请重试后再操作。</p></div></section>';
      if (detailDialog.open) detailDialog.close();
      if (actionDialog.open) actionDialog.close();
      showError(orderLoadError, $('#order-list')); return;
    }
    const summary = [['order', '全部订单', orders.length], ['headset', '待服务', orders.filter(o => matchesOrderFilter(o,'waiting')).length], ['clock', '进行中', orders.filter(o => matchesOrderFilter(o,'serving')).length], ['shield', '待处理', orders.filter(o => hasOpenCase(o) || o.status === 'confirming').length]];
    $('#order-summary').innerHTML = summary.map(([symbol, label, count], i) => `<div class="summary-item ${i === 3 ? 'attention' : ''}"><span class="summary-icon">${icon(symbol)}</span><div><small>${label}</small><strong>${count}<em>笔</em></strong></div></div>`).join('');
    $('#order-filters').innerHTML = FILTERS.map(([key, label]) => `<button type="button" data-filter="${key}" aria-pressed="${key === filter}">${label}</button>`).join('');
    const visible = orders.filter(matches).sort((a,b)=>orderAttentionPriority(a,role)-orderAttentionPriority(b,role)||(b.createdAt||0)-(a.createdAt||0));
    if (!visible.some(order => order.id === selectedId)) selectedId = visible[0]?.id ?? null;
    $('#record-count').textContent = `${visible.length} 笔${role === 'provider' ? '服务订单' : '订单'}`;
    $('#order-list').innerHTML = visible.length ? visible.map(order => `<article class="order-card ${order.id === selectedId ? 'is-selected' : ''}" aria-label="${order.snapshot.title} ${orderStatusLabel(order)} ${order.id}"><div class="order-card-top"><span class="order-number">${order.id}</span>${badge(order)}</div><div class="order-card-main"><img class="order-thumbnail" src="${order.snapshot.image}" alt="" loading="lazy"><div><button type="button" class="order-mode-title" data-order-action="select" data-order-id="${order.id}">${order.snapshot.title}</button><p class="order-card-description">国服端游 · 1 小时 · ${providerCount(order)} 位陪玩</p><div class="order-mini-tags"><span>试用价</span><span>${order.snapshot.gear} 套起</span>${order.provider ? `<span>${role === 'buyer' ? escapeHtml(serviceProviderNames(order)) : `消费者 ${escapeHtml(order.customer)}`}</span>` : ''}</div></div><div class="order-amount"><strong>${money(order.price)}</strong><small>${order.date}</small></div></div>${demandPreview(order)}<div class="order-card-bottom"><span class="order-card-note">${order.status === 'active' ? `已服务 <b data-clock="${order.id}">${timeText(elapsedSeconds(order))}</b> / 60:00` : currentInfo(order)}</span><div class="order-card-actions">${order.status === 'active' ? button('contact', role === 'buyer' ? '联系陪玩' : '联系消费者', order, 'textual') : ''}${button('view', hasOpenCase(order) ? '售后详情' : '查看订单', order, 'primary')}</div></div></article>`).join('') : `<div class="order-empty">${icon('order')}暂无${FILTERS.find(([key]) => key === filter)[1]}订单<p>其他状态的订单仍可在“全部”中查看。</p><button type="button" class="order-button" data-filter="all">查看全部订单</button></div>`;
    renderQuick(orders.find(order => order.id === selectedId));
    if (detailDialog.open) { const selected = orders.find(order => order.id === detailId); if (selected) renderDetail(selected); else detailDialog.close(); }
  }
  function renderDetail(order) {
    const body = $('#order-detail-body');
    if (body.dataset.orderId === order.id && body.dataset.version === String(order.version) && body.dataset.role === role) return;
    body.dataset.orderId = order.id; body.dataset.version = order.version; body.dataset.role = role;
    $('#order-detail-title').textContent = order.snapshot.title + (role === 'provider' ? ' · 接单者' : ' · 消费者');
    $('#order-detail-body').innerHTML = `<div class="detail-heading-line"><div><h3>${orderStatusLabel(order)}</h3><p>${order.id} · 国服端游 · ${providerCount(order)}位陪玩</p></div><strong>${money(order.price)}</strong></div>${nextStepHtml(order, true)}<div class="detail-columns"><div><section class="detail-section"><h3>订单信息</h3><dl class="detail-data"><dt>购买服务</dt><dd>${order.snapshot.title} · 60分钟</dd><dt>计费方式</dt><dd>${money(order.unitPrice || order.snapshot.price)} / 人 / 小时 · ${providerCount(order)}位，总价${money(order.price)}</dd><dt>装备要求</dt><dd>${order.snapshot.gear} 套起</dd><dt>支付状态</dt><dd>${escapeHtml(({unpaid:'未支付',processing:'模拟支付处理中',paid:'已模拟支付',refund_pending:'模拟退款处理中',refunded:'已模拟全额退款',partially_refunded:'已模拟部分退款'})[order.payment.status] || '模拟支付')} · 不产生真实资金${order.payment.refunded ? ' · 已退 '+money(order.payment.refunded) : ''}</dd>${providerFactsHtml(order)}<dt>游戏需求</dt><dd>${escapeHtml(order.preference)}</dd></dl></section>${demandSummary(order)}${order.review ? `<section class="detail-section"><h3>服务评价</h3><p>态度 ${order.review.attitude} 分 · 沟通 ${order.review.communication} 分 · 体验 ${order.review.experience} 分</p><p>${escapeHtml(order.review.text)}</p></section>` : ""}<section class="detail-section"><h3>服务记录</h3>${order.events.some(event=>!event.actorRole)?'<p class="evidence-note">早期记录未记录操作者，保留原始内容。</p>':''}<ol class="service-timeline">${order.events.map(event => `<li>${escapeHtml(eventText(event))}<small>${escapeHtml(event.time)}</small></li>`).join('')}</ol></section>${[...(order.cases || []), ...(order.case ? [order.case] : [])].map(c => `${progressHtml(c,role,order)}<section class="detail-section"><h3>售后记录 · ${c.stage === 'closed' ? '已处理' : '处理中'}</h3><p>${escapeHtml(c.description)}</p><p>${escapeHtml(c.proposal?.reason || '等待核实')}</p></section>`).join('')}</div><div class="detail-secondary"><div class="detail-card">${providerRow(order)}${timer(order)}<div class="detail-actions secondary-actions">${secondaryActions(order)}</div></div></div></div>`;
    for (const c of [...(order.cases || []), ...(order.case ? [order.case] : [])]) { const attachments = document.createElement('section'); $('#order-detail-body').append(attachments); mountEvidence(attachments, { orderId: order.id, caseId: c.id, ownHistory: !!order.readOnly }); }
  }
  function openDetail(order) {
    detailId = order.id; selectedId = order.id; $('#order-detail-body').dataset.version = ''; render(); renderDetail(order);
    if (!detailDialog.open) detailDialog.showModal();
  }
  document.addEventListener('click', event => {
    const close = event.target.closest('[data-close-order]');
    if (close) { document.getElementById(close.dataset.closeOrder).close(); return; }
    const roleButton = event.target.closest('.view-toggle button[data-role]');
    if (roleButton) {
      if (detailDialog.open) detailDialog.close(); if (actionDialog.open) actionDialog.close();
      role = roleButton.dataset.role; saveIdentityView(identity?.id,role);
      orders=[]; selectedId=null; detailId=null; actionId=null; filter='all'; refreshSequence++;
      const url = new URL(location.href); url.searchParams.set('role', role); url.searchParams.delete('order'); history.replaceState(null, '', url);
      render(); $('#record-count').textContent='正在读取'+(role==='buyer'?'消费者':'接单者')+'订单…'; refreshOrders(); return;
    }
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) { filter = filterButton.dataset.filter; render(); return; }
    const trigger = event.target.closest('[data-order-action]');
    if (!trigger) return;
    const action = trigger.dataset.orderAction;
    if (action === 'reset') { refreshOrders(); return; }
    const order = orders.find(item => item.id === trigger.dataset.orderId);
    if (!order) return;
    if (action === 'select') { selectedId = order.id; render(); if (window.innerWidth <= 1030) openDetail(order); return; }
    if (action === 'view') { openDetail(order); return; }
    openAction(order, action, trigger.dataset.caseKind);
  });
  for (const modal of [detailDialog, actionDialog]) modal.addEventListener('click', event => {
    if (event.target !== modal) return;
    const rect = modal.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close();
  });
  function openAction(order, action, requestedKind) {
    if (detailDialog.open) detailDialog.close();
    const actionRole=role;
    if(action==='guide') { $('#order-action-title').textContent='售后与自助处理'; $('#order-action-body').innerHTML=guideHtml(order); if(!actionDialog.open) actionDialog.showModal(); return; }
    actionId = order.id;
    const originalAction = action;
    if (action === 'contact') action = 'message';
    if (action === 'swap') action = eligibility(order).firstSwap ? 'firstSwap' : 'request';
    if (action === 'zero') action = 'request';
    if (action === 'case' || (action === 'supplement' && order.case?.stage === 'proposed')) action = order.case?.stage === 'proposed' ? 'acceptCase' : 'supplement';
    actionDialog.dataset.skin = action === 'review' ? 'feedback' : ['request','supplement','acceptCase'].includes(action) ? 'report' : action === 'message' ? 'workspace' : 'information';
    $('#order-action-title').textContent = ({ pay: '确认模拟支付', accept: '确认接单', start: '确认开始服务', beginRound: '登记对局开始', endRound: '提交对局结果', confirmRound: '核对对局记录', finish: '确认服务完成', cancel: '取消订单', requestCancel: '申请协商取消', respondCancel: '回应取消申请', remind: '发送站内提醒', message: '订单沟通', request: '发起售后', supplement: '售后与补充说明', review: '评价服务', acceptCase: '售后处理方案' })[action] || '确认服务操作';
    const c = order.case;
    let fields = '';
    if (action === 'pay') fields = '<dl class="confirmation-list"><div><dt>本次服务</dt><dd>'+escapeHtml(order.snapshot.title)+' · 1小时 / '+providerCount(order)+'位陪玩</dd></div><div><dt>模拟支付金额</dt><dd class="confirmation-total">'+money(order.price)+'</dd></div></dl><p>仅更新本地模拟支付状态，不扣款，不调用真实支付渠道。</p>';
    if (action === 'accept') fields = '<dl class="confirmation-list"><div><dt>本次承接</dt><dd>'+providerCount(order)+'位陪玩 · 1小时</dd></div><div><dt>订单总价</dt><dd>'+money(order.price)+'</dd></div></dl>'+(providerCount(order)===2?'<p>你将代表已经明确同意的小队承接完整双人订单，两人同时占用服务档期。每位成员仍须自己确认开始、完成与售后方案。</p>':'')+demandSummary(order) + '<p>试音自愿且不计入尚未开始的服务。接单后可通过订单沟通与游戏语音确认，平台不录音。</p>';
    if (action === 'cancel') fields = order.status==='pending'?'<p>取消尚未支付的订单，不产生扣款或退款；需要服务时可重新下单。</p>':'<p>取消当前等待匹配的订单，已模拟支付的订单将全额模拟退款；取消后需重新下单。</p>';
    if (action === 'requestCancel') fields = '<p>仅取消尚未开始的初次服务。全体参与者同意后模拟全额退款，未回应不会自动取消。</p><label>取消原因<textarea name="reason" minlength="10" maxlength="300" required></textarea></label>';
    if (action === 'respondCancel') fields = '<p>'+escapeHtml(order.cancelRequest.reason)+'</p><label>回应<select name="decision"><option value="accept">同意取消并模拟全额退款</option><option value="decline">不同意，继续沟通或售后</option></select></label><label>回应说明（不同意时须填写）<textarea name="reason" minlength="10" maxlength="300"></textarea></label>';
    if (action === 'remind') fields = '<p>发送站内提醒；同单5分钟内最多一次，不会通过短信或微信发送。</p>';
    if (action === 'start' && role === 'buyer' && lowKd(order)) fields = '<label><input type="checkbox" name="acceptLowKd" required>已知悉对应模式 KD '+(order.providers?.length?order.providers:[order.provider]).map(p=>escapeHtml(p.name)+'：'+p.kd).join(' / ')+'，同意开始服务</label>';
    if (action === 'start' && order.provider?.trialAvailable) fields = '<p>服务者表示愿意试音，双方可自愿通过游戏语音确认，不需要上传录音。未完成双方开始确认前不计时，试音不是必须步骤。</p>' + fields;
    if (action === 'beginRound') fields = '<p>全体入局后，由一人登记即可。其余参与者会看到同一份记录，无需重复登记。</p>';
    if (action === 'start') fields = '<p>请先在游戏内入队。消费者与每位服务者分别确认后才开始计时；任何人未确认时不计时。</p>' + fields;
    if (action === 'endRound') fields = '<label>该局结果<select name="result" required><option value="" selected disabled>请选择实际对局结果</option><option value="failed">未撤离</option><option value="success">成功撤离</option></select></label><p>任一方可以提交，由其余参与者核对。未经全体确认的记录不用于首局换人或零撤离保障。</p>';
    if (action === 'confirmRound') fields = '<div class="round-check-intro"><strong>核对对方提交的结果</strong><p>这次确认会影响服务记录与保障判断，请以实际对局为准。</p></div><label>待核对对局<select name="index">'+order.rounds.map((r,i) => !roundNeedsConfirmation(order,r,role) ? '' : '<option value="'+i+'">第'+(i+1)+'局：'+(r.result === 'failed'?'未撤离':'成功撤离')+'</option>').join('')+'</select></label><label><input type="checkbox" name="agreed" required>我已核对，确认该局记录准确。</label><p class="evidence-note">记录不准确时不要确认。可直接提出异议，并在售后补充截图或说明；不因单方登记自动退款或处罚。</p>';
    if (action === 'message') fields = '<p class="dialog-note">请在本订单沟通。私下转账不纳入订单保障；诱导转账可提交投诉。</p>' + (order.status === 'ready' ? '<p>消费者与每位陪玩可在游戏语音中自愿试音，平台不录音。未确认开始不计时；不满意可协商取消，试音不是额外退款或强制换人的依据。</p>' : '') + '<div class="message-log">'+order.messages.map(m => '<p><strong>'+escapeHtml(messageAuthor(m))+'：</strong>'+escapeHtml(m.text)+'</p>').join('')+'</div><label>订单消息<textarea name="text" maxlength="300" required></textarea></label>';
    if (action === 'request') fields = '<label>申请类型<select name="kind">'+Object.entries(REQUESTS).filter(([k])=>(role === 'buyer'||['time','complaint'].includes(k))&&(!order.aftercareGuide||order.aftercareGuide.options.some(o=>o.kind===k))).map(([k,label])=>'<option value="'+k+'" '+(k === (requestedKind || (originalAction === 'zero'?'zero':originalAction === 'swap'?'replace':'service'))?'selected':'')+'>'+escapeHtml(order.aftercareGuide?.options.find(o=>o.kind===k)?.label || label)+'</option>').join('')+'</select></label><p id="aftercare-material-help" class="evidence-note"></p><label>发生时间或对局（选填）<input name="occurredWhen" maxlength="120" placeholder="例如：第2局开始后，约服务20分钟"></label><label>希望如何处理<select name="expectation"><option value="explanation">核实并说明</option><option value="refund">申请退款</option><option value="replace">更换服务者</option><option value="adjustTime">校正时长</option></select></label><p class="evidence-note">诉求用于核实，不改变退款条件或处理比例。</p><label>发生经过<textarea name="description" minlength="10" maxlength="500" required></textarea></label><label>材料说明（截图、录音的时间与摘要）<textarea name="evidence" maxlength="1000"></textarea></label><p>提交后人工核实，不因投诉自动扣款或处罚。提交申请后可在售后窗口上传截图或录音。</p><a href="./rules.html#aftercare-draft" data-document="aftercare-draft">查看售后处理草案（新增建议待确认）</a>';
    if (action === 'supplement' || action === 'acceptCase') fields = progressHtml(c,role,order) + '<section><p>'+escapeHtml(c?.description||'')+'</p><p>材料：'+escapeHtml(c?.evidence.join('；')||'暂无')+'</p>'+ (c?.notes||[]).map(n=>'<p>'+escapeHtml(messageAuthor(n))+'：'+escapeHtml(n.text)+'</p>').join('')+(c?.proposal?'<p>方案：'+escapeHtml(({refund:'按规则退款',replace:'更换服务者',resume:'恢复原流程',adjustTime:'校正服务时长'})[c.proposal.outcome])+(c.proposal.outcome === 'refund' ? ' '+c.proposal.percent+'%' : c.proposal.outcome === 'adjustTime' ? ' '+c.proposal.deltaSeconds+'秒' : '')+'</p><p>依据：'+escapeHtml(c.proposal.reason)+'</p>':'<p>等待人工核实与处理。</p>')+'</section>'+(action === 'acceptCase'?(c.proposal.accepted[role] ? '<p>你已接受该方案，正在等待对方。无需重复确认；如有异议，可申请人工复核。</p>' : '')+'<label>选择<select name="caseAction" required><option value="" selected disabled>请选择处理意见</option><option value="acceptCase" '+(c.proposal.accepted[role] ? 'disabled' : '')+'>接受方案</option><option value="appealCase" '+''+'>提出异议，申请人工复核</option></select></label>':'')+'<label>补充说明或异议<textarea name="description" minlength="10" maxlength="500" '+(action === 'supplement'?'required':'')+'></textarea></label><label>补充材料摘要<textarea name="evidence" maxlength="1000"></textarea></label>';
    if(action==='supplement') { const pending=(c?.materialRequests||[]).filter(r=>r.forRole===role&&r.respondedAt==null); if(pending.length) fields+='<label>本次回应的补证要求<select name="answeredMaterialRequestId"><option value="">仅补充一般说明</option>'+pending.map(r=>'<option value="'+r.id+'">'+escapeHtml(r.description)+'</option>').join('')+'</select></label><p class="evidence-note">提交回应仍需核实，不代表材料自动被采信。</p>'; }
    if (action === 'review') fields = ['attitude','communication','experience'].map((key,i)=>'<label>'+['服务态度','沟通配合','服务体验'][i]+'<select name="'+key+'" required><option value="" selected disabled>请选择评分</option>'+[5,4,3,2,1].map(n=>'<option value="'+n+'">'+n+'分</option>').join('')+'</select></label>').join('')+'<label>评价<textarea name="text" maxlength="300"></textarea></label>';
    const submitLabel = ({pay:'确认模拟支付',start:'确认已入队',confirmRound:'确认记录准确',endRound:'提交实际结果',finish:'确认服务完成',review:'提交评价'})[action] || '确认提交';
    $('#order-action-body').innerHTML = '<p>'+escapeHtml(currentInfo(order))+'</p><form id="order-business-form" class="order-form">'+fields+'<p id="operation-error" role="status"></p><div class="form-actions">'+(action==='confirmRound'?button('request','记录有异议',order):'')+'<button type="submit" class="order-button primary">'+submitLabel+'</button></div></form>';
    if (['supplement', 'acceptCase'].includes(action) && c) { const attachments = document.createElement('section'); $('#order-action-body').append(attachments); mountEvidence(attachments, { orderId: order.id, caseId: c.id, canUpload: !order.readOnly && ['human', 'appeal'].includes(c.stage), onUploaded: version => { order.version = version; } }); if (c.stage === 'proposed') attachments.insertAdjacentHTML('afterbegin', '<p class="evidence-note">如需补交新材料，请先提出异议。</p>'); }
    if (!actionDialog.open) actionDialog.showModal();
    const form = $('#order-business-form');
    form.addEventListener('invalid',event=>{const field=event.target;if(field.name==='result')field.setCustomValidity('请选择实际对局结果。');else if(field.name==='agreed')field.setCustomValidity('请先核对对局记录，确认准确后再勾选。');else if(field.name==='caseAction')field.setCustomValidity('请明确选择接受方案或提出异议。');else if(['attitude','communication','experience'].includes(field.name))field.setCustomValidity('请根据本次服务选择评分。');},true);
    form.addEventListener('change',event=>event.target.setCustomValidity?.(''));
    if(action==='request') { const hint=$('#aftercare-material-help'); const update=()=>{hint.textContent=materialHelp[form.elements.kind.value];}; form.elements.kind.onchange=update; update(); }
    const draftKey=order.id+':'+action+':'+(c?.id||'new');
    if(['request','supplement','acceptCase','message','requestCancel','respondCancel','review'].includes(action)) {
      for(const [key,value] of Object.entries(aftercareDrafts.get(draftKey)||{})) if(form.elements[key]) form.elements[key].value=value;
      form.addEventListener('input',()=>aftercareDrafts.set(draftKey,Object.fromEntries(['description','evidence','occurredWhen','text','reason'].filter(key=>form.elements[key]).map(key=>[key,form.elements[key].value]))));
    }
    const requestId = crypto.randomUUID();
    form.onsubmit = async event => {
      event.preventDefault(); const b = form.querySelector('button[type="submit"]'); b.disabled = true;
      if(actionRole!==role){actionDialog.close();toast('身份已切换，请在当前身份重新打开操作。');return;}
      const fields = Object.fromEntries(new FormData(form));
      for (const key of ['index','attitude','communication','experience']) if (key in fields) fields[key] = Number(fields[key]);
      for (const key of ['agreed','acceptLowKd']) fields[key] = form.elements[key]?.checked === true;
      if (action === 'respondCancel') fields.agreed = fields.decision === 'accept';
      try { const sendAction = resolveOrderAction(action, fields); await api('/api/orders/'+order.id+'/actions/'+sendAction, {...fields, version:order.version, requestId, ...(order.offer ? {offerId:order.offer.id} : {})}); aftercareDrafts.delete(draftKey); actionDialog.close(); await refreshOrders(); toast('操作已保存。'); }
      catch (error) {
        showError(error, form.querySelector('#operation-error'));
        if (error.status === 409) {
          // Keep supported text drafts visible. Never replay acceptance choices against a changed proposal.
          const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'order-button'; reload.textContent = '刷新订单并重新核对';
          form.querySelector('.form-actions').append(reload);
          reload.onclick = async () => {
            reload.disabled = true; await refreshOrders();
            const latest = orders.find(item=>item.id===order.id);
            if (actionRole!==role || !latest) { reload.disabled=false; showError(new Error('暂时无法读取订单，请关闭窗口后重新打开。'), form.querySelector('#operation-error')); return; }
            actionDialog.close(); openDetail(latest);
            toast('订单已刷新，请核对当前状态后选择操作。填写的文字在本页保留。');
          };
        } else b.disabled = false;
        await refreshOrders();
      }
    };
  }
  async function refreshOrders() {
    const sequence=++refreshSequence, requestedRole=role;
    try {
      const data = await api('/api/orders?role='+requestedRole);
      const nextOrders = data.orders.filter(order=>belongsToIdentity(order,requestedRole,identity?.id));
      if (requestedRole === 'provider') {
        if (document.visibilityState === 'visible') { const {profile} = await api('/api/provider'); if (profile?.state === 'available') await api('/api/provider/presence', {}); }
        const queue = await api('/api/queue'); nextOrders.push(...queue.orders.filter(order=>order.status==='matching'&&!order.providerId&&order.buyerId!==identity?.id));
      }
      if (sequence !== refreshSequence) return;
      serverOffset = data.serverNow-Date.now(); orders = nextOrders;
      orderLoadError = null; $('#order-summary').hidden = false; render();
    } catch (error) {
      if (sequence !== refreshSequence) return;
      orders = []; orderLoadError = error; render();
    }
  }
  await refreshOrders();
  setInterval(() => { if (document.visibilityState === 'visible') refreshOrders(); }, 5000);
  setInterval(() => {
    for (const e of document.querySelectorAll('[data-clock]')) { const o=orders.find(x=>x.id===e.dataset.clock); if(o)e.textContent=timeText(elapsedSeconds(o)); }
    for (const e of document.querySelectorAll('[data-progress]')) { const o=orders.find(x=>x.id===e.dataset.progress); if(o)e.value=elapsedSeconds(o); }
  },1000);
}

