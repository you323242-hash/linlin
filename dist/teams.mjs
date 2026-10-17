import { personMini, personSheet } from './people-cards.mjs?v=8';
import { api, requestBody, escapeHtml as esc, safeReturnPath } from './business-api.mjs';
import { tagField, bindTagButtons } from './matching-ui.mjs';
import { TACTICAL_STYLES, filterRooms, recruitment, isTeamHistory } from './teams-model.mjs';
import {ALL_AVATARS,BACKGROUNDS} from './persona-assets.mjs';
import {CARD_MAPS} from './people-cards.mjs';
const $ = selector => document.querySelector(selector);
const dialog = $('#team-dialog'), body = $('#team-dialog-body');
let channel='pc';
const channelLabel=()=>channel==='mobile'?'国服手游':'国服端游';
async function teamAPI(route,options){
  const started=channel;
  if(started==='mobile'&&route.startsWith('/api/teams'))route+=(route.includes('?')?'&':'?')+'channel=mobile';
  const result=await api(route,options);
  if(started!==channel)throw Object.assign(new Error('游戏平台已切换。'),{staleChannel:true});
  return result;
}
function freeSheet(person){return personSheet(person.channel==='mobile'?{...person,id:'mobile-card',spaceRoom:null}:person,'free-live')+`<p class="team-form-note">${person.channel==='mobile'?'国服手游':'国服端游'}游戏名片 · 两个平台的游戏资料独立保存</p>`;}
let rooms = [], mine = null, next = null, trigger, toastTimer, busy = false, loading = false, currentId = null, currentView = null, detailData, chatCursor = 0, chatHistory = [], activeChatId = null, boardSequence = 0, disposed = false, refreshing = false;
const statusNames = { requested:'等待房主确认', confirmed:'已确认入队', ended:'已结束', rejected:'申请未通过', withdrawn:'已撤回', left:'已退出' };
let lastTeamState = null;
let chatSequence = 0;
let dialogRevision = 0;
function closeChat() {
  chatSequence++; activeChatId = null; chatHistory = []; chatCursor = 0;
  $('#team-conversation-body').replaceChildren(); $('#team-conversation-body').hidden = true;
  $('[data-action="close-chat"]').hidden = true;
  $('#team-chat-rooms').querySelectorAll('button').forEach(button => { button.setAttribute('aria-pressed','false'); button.setAttribute('aria-expanded','false'); });
}
const tags = items => `<div class="team-tags">${items.map(t => `<span>${esc(t)}</span>`).join('')}</div>`;
function toast(message) { clearTimeout(toastTimer); $('#team-toast').textContent = message; $('#team-toast').hidden = false; toastTimer = setTimeout(() => $('#team-toast').hidden = true, 4500); }
function open(title, html) { dialogRevision++; if (!dialog.open) trigger = document.activeElement; $('#team-dialog-title').textContent = title; body.innerHTML = html; dialog.dataset.skin = body.querySelector('[data-kind]')?.dataset.kind || ({feedback:'feedback',report:'report',appeal:'appeal',workspace:'workspace',rules:title.includes('信誉')?'reputation':'information',publish:'recruitment'})[currentView] || 'information'; if (!dialog.open) dialog.showModal(); }
function login() { location.assign('/?login=1&returnTo=' + encodeURIComponent(safeReturnPath('/teams.html'+(channel==='mobile'?'?channel=mobile':'')))); }
async function identity(required = false) {
  try { const previousUser = mine?.user.id; mine = await teamAPI('/api/teams/mine');
    if (previousUser && previousUser !== mine.user.id) { closeChat(); lastTeamState = null; detailData = null; if (dialog.open) dialog.close(); }
    if (activeChatId && !mine.teams.some(d => d.room.id === activeChatId && ['confirmed','ended'].includes(d.membership.state))) closeChat();
    const state = new Map(mine.teams.map(d => [d.room.id, {pending:d.applicants.length, member:d.membership.state}]));
    if (lastTeamState) {
      if (mine.teams.some(d => d.membership.own && d.applicants.length > (lastTeamState.get(d.room.id)?.pending || 0))) toast('收到新的入队申请，请在“我的组队”中确认。');
      else if (mine.teams.some(d => !d.membership.own && d.membership.state === 'confirmed' && lastTeamState.get(d.room.id)?.member === 'requested')) toast('房主已确认入队，可以进入小队沟通。');
    }
    lastTeamState = state; return true; }
  catch (error) { if(error.staleChannel)return false;mine = null; if (error.status === 401) { closeChat(); lastTeamState = null; if (required) login(); return false; } throw error; }
}
function render() {
  $('#team-chat-rooms').innerHTML = (mine?.teams || []).filter(d => ['confirmed','ended'].includes(d.membership.state)).map(d=>`<button type="button" class="team-text" data-action="chat" data-id="${esc(d.room.id)}" aria-controls="team-conversation-body" aria-expanded="${activeChatId === d.room.id}" aria-pressed="${activeChatId === d.room.id}">${esc(d.room.title)}${d.room.status === 'ended' ? ' · 历史' : ''}</button>`).join('');
  const filters = Object.fromEntries(new FormData($('#team-filters'))), shown = filterRooms(rooms, filters);
  $('#team-result').textContent = `${shown.length} 条招募${next ? ' · 可加载更多' : ''}`;
  $('#team-cards').innerHTML = shown.length ? shown.map(r => `<article class="team-card ui-surface"><div class="team-card-top"><span class="team-mode">${esc(r.mode)} / ${esc(r.style)}</span><span class="team-mini-label">${r.need ? `缺 ${r.need} 人` : '已满员'}</span></div><div class="team-card-body"><h3>${esc(r.title)}</h3><div class="team-meta"><span>◷ ${esc(r.when)}</span><span>${r.mic === 'voice' ? '需要麦克风' : '麦克风不限'}</span></div>${tags(r.tags.slice(0,3))}${personMini(r)}</div><div class="team-card-foot"><button class="team-button" data-action="detail" data-id="${esc(r.id)}">查看招募 <span aria-hidden="true">→</span></button></div></article>`).join('') : '<div class="team-empty team-no-results"><span>◇</span>暂无符合条件的招募。<div><button class="team-text" data-action="publish">发布招募 →</button></div></div>';
  if (next) $('#team-cards').insertAdjacentHTML('beforeend', '<button class="team-button" data-action="more">加载更多招募</button>');
  if ($('#my-teams')) $('#my-teams').innerHTML = mine?.teams.length ? mine.teams.map(d => `<div class="team-owned"><strong>${esc(d.room.title)}</strong><p>${esc(d.membership.own && d.room.status === 'open' ? `我的招募 · ${d.applicants.length} 条待确认申请` : statusNames[d.membership.state])}</p><div class="team-record-actions"><button class="team-text" data-action="detail" data-id="${esc(d.room.id)}">查看进度 →</button>${d.membership.own ? `<button class="team-text" data-action="reuse" data-id="${esc(d.room.id)}">再次招募</button>` : ''}${isTeamHistory(d) ? `<button class="team-text" data-action="dismiss" data-id="${esc(d.room.id)}">清除记录</button>` : ''}</div></div>`).join('') : '<div class="team-empty"><span>＋</span>暂无组队记录<div><button class="team-text" data-action="publish">发布招募 →</button></div></div>';
  if ($('[data-action="clear-history"]')) $('[data-action="clear-history"]').disabled = !mine?.teams.some(isTeamHistory);
  if ($('#my-teams') && mine?.blocks?.length) $('#my-teams').insertAdjacentHTML('beforeend', '<details><summary>已屏蔽招募</summary>'+mine.blocks.map(r=>`<div class="team-owned"><strong>${esc(r.title)}</strong><button class="team-text" data-action="unblock" data-id="${esc(r.id)}">取消屏蔽</button></div>`).join('')+'</details>');
  if ($('#my-reputation')) {
    const r = mine?.restriction, p = mine?.reputation;
    $('#my-reputation').innerHTML = r ? `<span class="team-reputation-badge restricted">组队受限</span><p>${esc(r.reason)}</p><button class="team-text" data-action="appeal">查看原因并申诉 →</button>` : `<span class="team-reputation-badge new">${p?.samples ? '已有组队反馈' : '新洲友'}</span><p>${p?.samples ? `${p.samples} 次实际反馈 · ${p.again} 次愿意再次组队` : '反馈积累中，暂无评级。'}</p>`;
  }
}
async function loadBoard(append = false) {
  const sequence = ++boardSequence;
  const filter = Object.fromEntries(new FormData($('#team-filters')));
  const result = await teamAPI('/api/teams?' + new URLSearchParams({ ...filter, ...(append && next ? { before: next } : {}) }));
  if (sequence !== boardSequence || disposed) return;
  rooms = append ? [...rooms, ...result.rooms.filter(r => !rooms.some(old => old.id === r.id))] : result.rooms;
  next = result.next; render();
}
function reputationGuide() { return '<div class="team-reputation-guide"><h3>信誉如何形成</h3><dl><div><dt>实际反馈</dt><dd>本次组队结束后，已确认成员可对洲友反馈一次；展示样本与再次组队意愿，不作技术认证。</dd></div><div><dt>核实违规</dt><dd>广告、骚扰、恶意信息可举报。提交不等于成立，正常失误不扣分；不按举报数量自动处罚。</dd></div><div><dt>限制与申诉</dt><dd>限制需说明核实事件、期限及恢复条件，可申诉。组队限制与付费接单暂停分开。</dd></div></dl><p class="team-form-note">自动评级阈值尚未启用；新洲友不等于低信誉。</p></div>'; }
function rules(kind) {
  currentView = 'rules'; currentId = null;
  if (kind === 'reputation') return open('组队信誉与行为管理', `<div class="reputation-summary"><div><strong>${mine?.reputation.samples || '—'}</strong><span>实际组队反馈</span></div><div><strong>${mine?.reputation.again || '—'}</strong><span>愿意再次组队</span></div><div><strong>${mine?.restriction?'受限':'正常'}</strong><span>${mine?'当前组队状态':'登录后查看个人信誉'}</span></div></div>` + reputationGuide());
  open('免费组队说明', '<h3>免费对接，自主选择</h3><p>平台提供招募与需求对接，在游戏内开展对局。不适用付费服务的退款、换人及赔付保障，不保证战绩、撤离率或匹配速度。</p><h3>确认后沟通</h3><p>登录后发布或申请加入，由房主确认；只有已确认成员能使用小队文字沟通。请勿发布联系方式、广告或敏感资料。</p><h3>基本社区保障</h3><p>举报会保存到后台等待核实，正常失败不构成违规。可屏蔽招募；组队限制保留原因、期限与申诉。</p><h3>语音自愿</h3><p>文字即可发布和加入，不录音不降低匹配优先级。短语音上传尚未开放，小队没有实时语音房。</p>');
}
async function workspace(view = 'teams') {
  if (!await identity(true)) return;
  currentView = 'workspace'; currentId = null;
  open('我的组队与信誉', $('#team-workspace-template').innerHTML);
  $('[data-reputation-guide]').innerHTML = reputationGuide(); workspaceView(view); render();
}
function workspaceView(view) {
  body.querySelectorAll('[data-workspace-panel]').forEach(node => node.hidden = node.dataset.workspacePanel !== view);
  body.querySelectorAll('[data-action="workspace-view"]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.view === view)));
}
async function gameProfile(){
 if(!await identity(true))return;
 const {profile}=await teamAPI('/api/teams/profile'),started=channel;
 const select=(key,items)=>`<label>${({gender:'性别（可选）',avatar:'游戏名片头像',cover:'名片背景'})[key]}<select name="${key}">${items.map(([value,label])=>`<option value="${esc(value)}" ${profile[key]===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
 const checks=(key,label,items)=>`<fieldset class="choice-field"><legend>${label}</legend><div class="choice-row">${items.filter(value=>value!=='不限').map(value=>`<label><input type="checkbox" name="${key}" value="${esc(value)}" ${(profile[key]||[]).includes(value)?'checked':''}><span>${esc(value)}</span></label>`).join('')}</div></fieldset>`;
 currentView='game-profile';currentId=null;
 open(channelLabel()+' · 我的游戏名片',`<p class="team-notice">只保存当前平台的游戏资料，另一平台的名片不会被覆盖。</p><form id="team-game-profile" class="team-form"><div class="team-game-profile-grid">${select('gender',[['unspecified','不公开'],['male','男'],['female','女']])}${select('avatar',[['initial','昵称首字'],...ALL_AVATARS.map(v=>[v.id,v.name])])}</div>${select('cover',BACKGROUNDS.map(v=>[v.id,v.name]))}${checks('maps','常玩地图（可选）',CARD_MAPS)}${checks('modes','常玩模式（可选）',['机密行动','绝密行动','不限'])}<label>玩法风格<input name="style" maxlength="12" value="${esc(profile.style||'')}" placeholder="例如：任务协作"></label><label>名片签名<input name="signature" maxlength="60" value="${esc(profile.signature||'')}" placeholder="只填写与找队友有关的信息"></label><label>游戏介绍<textarea name="bio" maxlength="240" rows="3">${esc(profile.bio||'')}</textarea></label><label>${channelLabel()}游戏内名称或ID<input name="gameId" maxlength="64" value="${esc(profile.gameId||'')}" placeholder="不会在公开名片展示"></label><p class="team-form-note">发布招募时可带入当前平台ID，仅房主和确认成员可见。账号昵称仍共用；不填写联系方式。</p><p class="team-status" role="status" data-form-error></p><button class="team-button primary" type="submit">保存${channelLabel()}名片</button></form>`);
 const form=$('#team-game-profile');form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||channel!==started)return;
  const values=new FormData(form),button=form.querySelector('[type="submit"]');busy=true;button.disabled=true;
  try{
   await teamAPI('/api/teams/profile',{...Object.fromEntries(values),maps:values.getAll('maps'),modes:values.getAll('modes'),version:profile.version});
   if(channel===started){dialog.close();await loadBoard();toast(channelLabel()+'名片已保存。');}
  }catch(error){if(!error.staleChannel&&form.isConnected)form.querySelector('[data-form-error]').textContent=error.message;}
  finally{busy=false;if(button.isConnected)button.disabled=false;}
 });
}
async function publish(templateId) {
  if (!await identity(true)) return;
  if (mine.restriction) return appeal();
  currentView = 'publish'; currentId = null;
  const choices = (name, values, selected) => '<fieldset class="choice-field"><legend>'+({mode:'行动模式',mic:'麦克风要求',need:'招募人数'})[name]+'</legend><div class="choice-row">'+values.map(([value,label])=>'<label><input type="radio" name="'+name+'" value="'+value+'" '+(value===selected?'checked':'')+' required><span>'+label+'</span></label>').join('')+'</div></fieldset>';
  open('发布洲友招募', `<p class="team-form-note">先选玩法与时间，补充需求后发布。</p><form id="team-publish" class="team-form"><label>招募标题<input name="title" maxlength="32" placeholder="选择下方示例，也可自行填写" required></label><div class="choice-row">${['轻松跑刀，一起搜集','一起清任务，互相配合','正常配装，先聊打法'].map(t=>'<button type="button" class="team-text" data-title="'+t+'">'+t+'</button>').join('')}</div>${choices('mode',[['机密行动','机密'],['绝密行动','绝密'],['不限','不限']],'机密行动')}<label>战术风格<input name="style" list="tactical-styles" maxlength="12" value="正常配装" required><datalist id="tactical-styles">${TACTICAL_STYLES.map(v=>'<option value="'+v+'">').join('')}</datalist></label><div class="choice-row">${TACTICAL_STYLES.map(v=>'<button type="button" class="team-text" data-style="'+v+'">'+v+'</button>').join('')}</div><label>开始时间<input name="when" maxlength="30" value="在线等" placeholder="在线等，或填写预约时间" required></label><div class="choice-row"><button type="button" class="team-text" data-when="在线等">在线等</button><button type="button" class="team-text" data-when="今晚 ">预约</button></div>${choices('need',[['1','1 位洲友'],['2','2 位洲友']],'1')}${choices('mic',[['text','不限'],['voice','需要麦克风']],'text')}<details class="team-form-extra"><summary>标签偏好（可选）</summary><div class="team-form-extra-body">${tagField('我的标签','selfTags')}${tagField('希望洲友具备','tags')}</div></details><label>补充说明（可选）<textarea name="intro" maxlength="120" placeholder="可说明装备、战绩要求或路线偏好。请勿填写联系方式。"></textarea></label><details class="team-form-extra"><summary>短语音招募（可选，稍后开放）</summary><p class="team-form-note">不录音也可正常招募。</p></details><label class="team-check"><input type="checkbox" name="agree" required><span>我了解免费对接范围，不发布广告、骚扰或恶意信息。</span></label><p class="team-status" role="status" data-form-error></p><button class="team-button primary" type="submit">发布招募</button></form>`);
  const form = $('#team-publish'); bindTagButtons(form);
  form.insertAdjacentHTML('afterbegin',`<p class="team-notice">当前发布到${channelLabel()}大厅，发布后不会跨平台展示。</p>`);
  form.querySelector('textarea[name="intro"]').closest('label').insertAdjacentHTML('afterend','<label>游戏内名称或ID（可选）<input name="gameId" maxlength="64" placeholder="仅房主与确认入队的成员可见"></label><p class="team-form-note">自填资料，平台暂不能验证游戏账号真实性。</p>');
  if(!templateId){const own=await teamAPI('/api/teams/profile');if(form.isConnected)form.elements.gameId.value=own.profile.gameId||'';}
  if (templateId) {
    const saved = await teamAPI('/api/teams/'+templateId);
    for (const key of ['title','style','when','intro','gameId']) form.elements[key].value = key === 'gameId' ? saved.gameId : saved.room[key] || '';
    for (const key of ['mode','mic','need']) { const value = key === 'need' ? saved.room.capacity-1 : saved.room[key]; form.elements[key].value = String(value); }
    for (const key of ['tags','selfTags']) form.elements[key].value = (saved.room[key]||[]).join('，');
    form.dispatchEvent(new Event('input',{bubbles:true}));
  }
  const syncChoices=()=>form.querySelectorAll('[data-title],[data-style],[data-when]').forEach(b=>{const key=['title','style','when'].find(k=>b.dataset[k]!==undefined);b.setAttribute('aria-pressed',String(form.elements[key].value===b.dataset[key]));});
  form.addEventListener('input',syncChoices);
  form.addEventListener('click', event => { const b=event.target.closest('[data-title],[data-style],[data-when]'); if(!b)return; const key=['title','style','when'].find(k=>b.dataset[k]!==undefined); form.elements[key].value=b.dataset[key]; syncChoices(); });
  syncChoices();

}
async function detail(id) {
  renderDetail(await teamAPI('/api/teams/' + id));
}
function renderDetail(d) {
  const id = d.room.id; detailData = d; currentId = id; currentView = 'detail';
  const r = d.room, m = d.membership;
  let controls;
  if (m?.own) controls = `<div class="team-actions">${r.status === 'open' ? `<button class="team-button primary" data-action="chat" data-id="${id}">小队文字沟通</button><button class="team-text" data-action="finish" data-id="${id}">结束本次组队</button>` : `<button class="team-button" data-action="chat" data-id="${id}">查看历史消息</button>`}</div>${r.status === 'open' ? `<h3>待确认申请</h3>${d.applicants.map(a => `<div class="team-owned"><strong>${esc(a.name)}</strong><p>${esc(a.note || '未填写留言')}</p><div class="team-actions"><button class="team-button" data-action="accept" data-id="${id}" data-user="${esc(a.id)}" ${r.need ? '' : 'disabled'}>确认入队</button><button class="team-text" data-action="reject" data-id="${id}" data-user="${esc(a.id)}">暂不接受</button></div></div>`).join('') || '<p>暂无待确认申请。</p>'}` : ''}`;
  else if (m?.state === 'requested') controls = `<p>等待房主确认，确认前不能进入小队沟通。</p><button class="team-text" data-action="withdraw" data-id="${id}">撤回申请</button>`;
  else if (m?.state === 'confirmed') controls = `<div class="team-actions"><button class="team-button primary" data-action="chat" data-id="${id}">小队文字沟通</button><button class="team-text" data-action="leave" data-id="${id}">退出小队</button></div>`;
  else if (m?.state === 'ended') controls = `<button class="team-button" data-action="chat" data-id="${id}">查看历史消息</button>`;
  else controls = r.status === 'open' && r.need ? `<form id="team-join" class="team-form" data-id="${id}"><label>加入留言（可选）<textarea name="note" maxlength="120" placeholder="你的时间和配合偏好，不填写联系方式。"></textarea></label><p class="team-status" role="status" data-form-error></p><button class="team-button primary">申请加入</button></form>` : '<p>本次招募已满员或已结束。</p>';
  open(r.title, `<dl class="team-detail-facts"><div><dt>行动模式</dt><dd>${esc(r.mode)}</dd></div><div><dt>开始时间</dt><dd>${esc(r.when)}</dd></div><div><dt>队伍需求</dt><dd>缺 ${r.need} 人 · ${r.mic === 'voice' ? '需要麦克风' : '麦克风不限'}</dd></div></dl><p>${esc(r.intro)}</p>${d.gameId ? `<div class="team-notice"><strong>房主游戏内名称 / ID</strong><p>${esc(d.gameId)}</p><small>仅确认成员可见 · 自填资料</small></div>` : ''}${r.tags.length ? '<h3>希望洲友具备</h3>' + tags(r.tags) : ''}${r.selfTags.length ? '<h3>房主自身标签</h3>' + tags(r.selfTags) : ''}${personMini(r)}<div class="team-notice"><p>免费自主组队，不适用付费售后；正常失败不构成违规。</p></div>${m ? `<p class="team-status">当前状态：${esc(statusNames[m.state])}</p>${m.note ? `<p>我的申请留言：${esc(m.note)}</p>` : ''}` : ''}${controls}${m?.own && r.status === 'open' ? '<h3>当前成员</h3>' + d.members.filter(p=>p.state === 'confirmed' && p.id !== mine?.user.id).map(p=>`<div class="team-owned"><strong>${esc(p.name)}</strong><button class="team-text" data-action="remove" data-id="${id}" data-user="${esc(p.id)}">移出小队</button></div>`).join('') + (!r.need ? '<p class="team-notice">小队已满员，可以结束招募；历史消息仍会保留。</p>' : '') : ''}${d.feedbackTargets.length ? `<h3>本次洲友</h3>${d.feedbackTargets.map(p => `<div class="team-owned"><strong>${esc(p.name)}</strong><button class="team-text" data-action="feedback" data-id="${id}" data-user="${esc(p.id)}" ${p.submitted ? 'disabled' : ''}>${p.submitted ? '已反馈' : '留下组队反馈'}</button></div>`).join('')}` : ''}<div class="team-actions team-divider">${!m?.own ? `<button class="team-text" data-action="report" data-id="${id}">${d.reported ? '举报其他成员' : '举报招募或成员'}</button>` : d.members.some(p => !mine || p.id !== mine.user.id) ? `<button class="team-text" data-action="report" data-id="${id}">举报不当成员信息</button>` : ''}<button class="team-text" data-action="block" data-id="${id}">屏蔽此招募</button></div>`);
}
async function syncDetail() {
  const id = currentId, revision = dialogRevision, userId = mine?.user.id;
  const d = await teamAPI('/api/teams/' + id);
  if (disposed || busy || !dialog.open || currentView !== 'detail' || currentId !== id || dialogRevision !== revision || mine?.user.id !== userId) return;
  if (JSON.stringify(d) === JSON.stringify(detailData)) return;
  // Leave unsent application text in its original form; other form views are never polled.
  if (body.querySelector('form')) {
    if (!body.querySelector('[data-detail-update]')) body.insertAdjacentHTML('afterbegin', `<p class="team-notice" role="status" data-detail-update>招募进度已变化，当前留言已保留。<button class="team-text" data-action="detail" data-id="${esc(id)}">查看最新状态</button><small>重新查看会清空未提交留言。</small></p>`);
    return;
  }
  const scroll = dialog.scrollTop, bodyScroll = body.scrollTop, focused = document.activeElement;
  const action = body.contains(focused) ? focused?.closest('[data-action]')?.dataset : null;
  renderDetail(d);
  if (action) {
    const replacement = [...body.querySelectorAll('[data-action]')].find(node => node.dataset.action === action.action && node.dataset.id === action.id && node.dataset.user === action.user);
    (replacement || $('[data-close-team]')).focus({preventScroll:true});
  }
  dialog.scrollTop = scroll; body.scrollTop = bodyScroll;
}
function chatLog() {
  const log = $('#team-chat-log'); if (!log) return;
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = chatHistory.map(msg => `<p><strong>${esc(msg.who)}</strong><small>${esc(new Date(msg.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))}</small><span class="team-chat-text">${esc(msg.text)}</span></p>`).join('') || '<p>还没有消息，先打个招呼吧。</p>';
  if (atEnd) log.scrollTop = log.scrollHeight;
}
async function chat(id) {
  if (activeChatId === id) { if (dialog.open) dialog.close(); closeChat(); return; }
  const sequence = ++chatSequence, userId = mine?.user.id;
  const result = await teamAPI(`/api/teams/${id}/messages?before=${Number.MAX_SAFE_INTEGER}`);
  if (sequence !== chatSequence || userId !== mine?.user.id || disposed || !mine?.teams.some(d => d.room.id === id && ['confirmed','ended'].includes(d.membership.state))) return;
  if (dialog.open) dialog.close();
  activeChatId = id; chatHistory = result.messages; chatCursor = chatHistory.at(-1)?.id || 0;
  $('#team-conversation-body').hidden = false; $('[data-action="close-chat"]').hidden = false;
  $('#team-conversation-body').innerHTML = `<div class="team-chat-log" id="team-chat-log" role="log" aria-label="小队消息"></div>${result.writable ? `<form class="team-chat-form" id="team-chat" data-id="${id}"><label>小队消息<textarea name="message" maxlength="300" required placeholder="先确认路线和时间。"></textarea></label><p class="team-status" role="status" data-form-error></p><button class="team-button primary">发送</button></form>` : '<p>本次沟通只供查看。</p>'}<button class="team-text" data-action="detail" data-id="${id}">查看小队详情 →</button><p class="team-form-note">每10秒更新；请勿发送敏感资料，最多展示最近100条。</p>`;
  render(); chatLog(); $('#team-conversation-body').scrollIntoView({block:'nearest'});
}
async function pollChat() {
  const id = activeChatId, sequence = chatSequence; if (!id) return;
  const result = await teamAPI(`/api/teams/${id}/messages?after=${chatCursor}`);
  if (activeChatId !== id || sequence !== chatSequence) return;
  chatHistory = [...chatHistory, ...result.messages.filter(m => !chatHistory.some(old => old.id === m.id))].slice(-100);
  chatCursor = chatHistory.at(-1)?.id || chatCursor; chatLog();
  if (!result.writable) $('#team-chat')?.remove();
}
async function report(id) {
  if (!await identity(true)) return;
  const d = await teamAPI('/api/teams/' + id); currentView = 'report'; currentId = id;
  const otherMembers = d.members.filter(p => p.id !== mine.user.id);
  open('举报不当行为', `<div class="report-layout"><aside class="report-aside"><strong aria-hidden="true">◇</strong><p>请描述实际发生的问题。<br>平台保留本次招募与可访问的近期消息，核实后处理。</p></aside><form id="team-report" data-id="${id}" class="team-form">${otherMembers.length ? `<label>举报对象<select name="targetId">${otherMembers.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}<label>问题类型<select name="kind"><option value="" selected disabled>请选择问题类型</option><option>广告招募 / 引流</option><option>骚扰 / 辱骂</option><option>恶意或欺诈信息</option><option>其他不当内容</option></select></label><label>情况说明<textarea name="reason" minlength="5" maxlength="300" required placeholder="例如：发布了哪些不当内容、出现在什么位置。"></textarea></label><p class="team-status" role="status" data-form-error></p><button class="team-button primary">提交举报</button></form></div>`);
  $('#team-report select[name="kind"]').required=true;
}
async function appeal() {
  if (!await identity(true)) return;
  const r = mine.restriction; currentView = 'appeal'; currentId = null;
  if (!r) return workspace('reputation');
  const pending = mine.appeals.some(a => a.status === 'pending');
  open('组队限制与申诉', `<span class="team-reputation-badge restricted">组队受限</span><h3>限制依据</h3><p>${esc(r.reason)}</p><h3>期限与恢复条件</h3><p>期限至 ${esc(new Date(r.expiresAt).toLocaleString('zh-CN'))}</p><p>${esc(r.recovery)}</p><p>暂停新发布、加入和发言，已有记录可查看，仍可退出与申诉；付费接单权限单独管理。</p>${pending ? '<p>已有申诉待复核，请勿重复提交。</p>' : '<form id="team-appeal" class="team-form"><label>申诉说明<textarea name="reason" minlength="5" maxlength="300" required></textarea></label><p class="team-status" role="status" data-form-error></p><button class="team-button primary">提交申诉</button></form>'}${mine.appeals.map(a => `<p>${esc(({pending:'待复核',accepted:'已通过',rejected:'未通过'})[a.status])}：${esc(a.decisionReason || '等待处理')}</p>`).join('')}`);
}
function feedback(id, targetId) {
  currentView = 'feedback'; currentId = id;
  const options=(name,title,values)=>`<fieldset class="feedback-options"><legend>${title}</legend><div class="choice-row">${values.map(v=>`<label><input type="radio" name="${name}" value="${v}" required><span>${v}</span></label>`).join('')}</div></fieldset>`;
  open('这一局，配合得怎么样？', `<p>留下真实体验，让下一次组队更有默契。</p><form id="team-feedback" data-id="${id}" data-user="${esc(targetId)}" class="team-form">${options('again','下次还想一起玩吗？',['愿意再次组队','暂不确定','节奏不合适'])}${options('communication','沟通与配合',['沟通友好、配合顺畅','配合一般','需要改善'])}${options('reliable','时间与约定',['按约上线','提前沟通过调整','未按约上线'])}<p class="team-status" role="status" data-form-error></p><button class="team-button primary">提交组队反馈</button></form>`);
}
async function run(button, operation) {
  if (busy) return; busy = true; if (button) button.disabled = true;
  try { await operation(); }
  catch (error) { toast(error.message); if (error.status === 401) { mine = null; if (dialog.open) dialog.close(); login(); } }
  finally { busy = false; if (button?.isConnected) button.disabled = false; }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const { action, id, user } = button.dataset;
  run(button, async () => {
    if (action === 'rules' || action === 'reputation') rules(action);
    else if (action === 'clear') { $('#team-filters').reset(); await loadBoard(); }
    else if (action === 'more') await loadBoard(true);
    else if (action === 'workspace') { if (dialog.open && currentView === 'workspace') dialog.close(); else await workspace(); }
    else if (action === 'close-workspace') dialog.close();
    else if (action === 'close-chat') closeChat();
    else if (action === 'clear-history' || action === 'dismiss') {
      currentView = 'history-confirm'; currentId = action === 'dismiss' ? id : null;
      open(action === 'dismiss' ? '清除这条历史？' : '清除组队历史？', '<p>仅移除你的历史展示，手机与电脑同步。正在组队和待确认的申请会保留，也不会清除其他成员的记录。</p><p class="team-form-note">必要的举报与审计依据仍会保留。</p><div class="team-actions"><button type="button" class="team-button" data-action="workspace">暂不清除</button><button type="button" class="team-button primary" data-action="confirm-history">确认清除</button></div>');
    }
    else if (action === 'confirm-history' && currentView === 'history-confirm') {
      await teamAPI(currentId ? `/api/teams/${currentId}/actions/dismiss` : '/api/teams/history', requestBody({}));
      await workspace(); toast('历史记录已清除。');
    }
    else if (action === 'workspace-view') workspaceView(button.dataset.view);
    else if (action === 'publish') await publish();
    else if (action === 'reuse') await publish(id);
    else if (action === 'detail') await detail(id);
    else if (action === 'game-profile') await gameProfile();
    else if (action === 'person') { const person = rooms.find(r => r.id === id) || detailData?.room; if (person) { currentView = 'person'; currentId = id; open('洲友名片', freeSheet(person) + `<button class="team-button" data-action="detail" data-id="${esc(id)}">查看招募 →</button>`); } }
    else if (action === 'chat') await chat(id);
    else if (action === 'report') await report(id);
    else if (action === 'appeal') await appeal();
    else if (action === 'feedback') feedback(id, user);
    else if (['accept','reject','remove','withdraw','leave','finish','block','unblock'].includes(action)) {
      if (!await identity(true)) return;
      if (action === 'remove' && !confirm('移出该成员？对方将不能继续发言，但仍可举报本次组队问题。')) return;
      await teamAPI(`/api/teams/${id}/actions/${action === 'finish' ? 'end' : action}`, requestBody(user ? { userId: user } : {}));
      if (action === 'block') { dialog.close(); toast('已屏蔽此招募，不影响对方权限。'); } else if (action === 'unblock') { await workspace(); toast('已取消屏蔽。'); } else await detail(id);
      await identity(); await loadBoard();
    }
  });
});
document.addEventListener('submit', event => {
  const form = event.target; if (!['team-publish','team-join','team-report','team-appeal','team-chat','team-feedback'].includes(form.id)) return;
  event.preventDefault(); if (busy) return;
  const values = Object.fromEntries(new FormData(form)), id = form.dataset.id, button = form.querySelector('button[type="submit"],button:not([type])');
  const fields = form.id === 'team-publish' ? { ...values, agree: values.agree === 'on' } : form.id === 'team-feedback' ? { ...values, targetId: form.dataset.user } : values;
  const encoded = JSON.stringify(fields); if (form.dataset.fields !== encoded) { form.dataset.fields = encoded; form.dataset.request = crypto.randomUUID(); }
  // Keep the same requestId after timeout; do not turn a retry into a second publish/message.
  const request = { ...fields, requestId: form.dataset.request };
  busy = true; button.disabled = true;
  (async () => {
    try {
      if (!await identity(true)) return;
      const action = ({'team-join':'join','team-report':'report','team-chat':'message','team-feedback':'feedback'})[form.id];
      const route = form.id === 'team-publish' ? '/api/teams' : form.id === 'team-appeal' ? '/api/teams/appeal' : `/api/teams/${id}/actions/${action}`;
      if (form.id === 'team-publish') recruitment(values);
      const result = await teamAPI(route, request);
      delete form.dataset.request; delete form.dataset.fields;
      if (form.id === 'team-chat') { form.reset(); await pollChat(); form.elements.message.focus(); }
      else if (form.id === 'team-report' || form.id === 'team-appeal') { currentView = 'receipt'; open('已提交，待核实', '<p>记录已保存，处理结果需核实；不会自动处罚或解除限制。</p>'); }
      else { await detail(result.roomId || id); toast(form.id === 'team-publish' ? '招募已保存，刷新后仍可查看。' : '记录已保存。'); }
      await identity(); await loadBoard();
    } catch (error) { const node = form.querySelector('[data-form-error]'); if (node?.isConnected) node.textContent = error.message; else toast(error.message); if (error.status === 401) { dialog.close(); login(); } }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  })();
});
let filterTimer;
$('#team-filters').addEventListener('input', () => { clearTimeout(filterTimer); boardSequence++; filterTimer = setTimeout(() => loadBoard().catch(error => { if(error.staleChannel)return;rooms = []; next = null; render(); toast(error.message); }), 250); });
$('#team-filters').addEventListener('submit', e => e.preventDefault());
$('[data-close-team]').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { dialogRevision++; currentView = null; currentId = null; trigger?.focus(); });
dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
async function refresh() {
  if (disposed || document.visibilityState !== 'visible' || busy || refreshing) return;
  refreshing = true;
  try {
    const wasLogged = !!mine; await identity();
    if (wasLogged && !mine && dialog.open) { dialog.close(); toast('登录已失效，请重新登录。'); }
    if (!mine && activeChatId) closeChat();
    if (activeChatId) { try { await pollChat(); } catch (error) { if (error.status === 403 || error.status === 404) { closeChat(); toast('当前已不在小队中；组队记录中仍可举报问题。'); } else throw error; } }
    if (dialog.open && currentView === 'workspace') render();
    if (dialog.open && currentView === 'detail') await syncDetail();
    await loadBoard();
  } catch (error) {
    if (dialog.open && ['chat','workspace'].includes(currentView)) dialog.close();
    if (dialog.open && currentView === 'detail' && [403,404].includes(error.status)) { dialog.close(); detailData = null; }
    toast(error.message);
  } finally { refreshing = false; }
}
const poll = setInterval(refresh, 10_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('pagehide', () => { disposed = true; clearInterval(poll); clearTimeout(filterTimer); }, {once:true});
window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; location.reload(); } });
$('#team-result').textContent = '正在读取招募…';
const channelControl=$('#free-channel');
if(channelControl){
 const requested=new URLSearchParams(location.search||'').get('channel');if(['pc','mobile'].includes(requested))channel=requested;
 channelControl.value=channel;
 const updateChannelLabel=()=>{const node=$('.team-platform');if(node)node.textContent=channelLabel();const rail=$('.vertical-label');if(rail)rail.textContent=channel==='mobile'?'MOBILE / CN':'PC / CN';$('#team-channel-note').textContent=channelLabel()+'专区 · 招募、组队记录与游戏资料不跨平台展示';};
 updateChannelLabel();
 channelControl.addEventListener('change',async()=>{
  if(busy){channelControl.value=channel;return toast('请等当前提交完成后再切换平台。');}
  channel=channelControl.value;window.history?.replaceState(null,'','/teams.html?channel='+channel);boardSequence++;clearTimeout(filterTimer);rooms=[];mine=null;next=null;detailData=null;lastTeamState=null;closeChat();if(dialog.open)dialog.close();render();updateChannelLabel();
  try{await Promise.all([identity(),loadBoard()]);}catch(error){if(!error.staleChannel)toast(error.message);}
 });
}
Promise.all([identity(), loadBoard()]).catch(error => { if(error.staleChannel)return;rooms = []; next = null; render(); toast(error.message); });
const motion = matchMedia('(prefers-reduced-motion: reduce)');
if (!motion.matches && 'IntersectionObserver' in window) {
  const reveal = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('team-arrived'); reveal.unobserve(entry.target); } }, { threshold:0.08 });
  document.querySelectorAll('.team-lobby,.team-paid-entry,.team-footer').forEach(node => reveal.observe(node));
  window.addEventListener('pagehide', () => reveal.disconnect(), { once:true });
}

