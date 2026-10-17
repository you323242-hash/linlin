import { availableProducts, getProduct, priceText, serviceHref, paidOrdersAvailable } from './catalog.mjs?v=4';
import { show, catalogReady } from './main.js?v=14';
import { api, requestBody, escapeHtml as esc, showError } from './business-api.mjs';
import { refreshUnread } from './notifications.mjs';
import { parseTags } from './matching.mjs';
import {readIdentityView,saveIdentityView} from './identity-view.mjs';
import { tagField, demandFields, readDemand, fillDemand, bindTagButtons, syncTagButtons } from './matching-ui.mjs';
const $ = selector => document.querySelector(selector);
const catalogError = await catalogReady;
const products = availableProducts();
if (catalogError) {
  const notice = '<section class="workspace-empty"><h1>服务资料暂时无法读取</h1><p role="status">请刷新页面重试，也可先进入订单中心查看已有订单。</p><a href="./orders.html">进入订单中心</a></section>';
  if ($('#service-workspace')) $('#service-workspace').innerHTML = notice;
  else {
    $('#buyer-workspace').hidden = true;
    $('#provider-workspace').hidden = true;
    document.querySelectorAll('[data-account-role]').forEach(button => { button.disabled = true; });
    $('#account-workspace').insertAdjacentHTML('beforeend', notice);
  }
}
if (!catalogError && $('#account-workspace')) {
  const accountUser=(await api('/api/me').catch(()=>null))?.user;
  let profile = null;
  if(accountUser){const {AVATARS}=await import('./persona-assets.mjs');const {persona}=await api('/api/persona').catch(()=>({persona:{}}));const ownAvatar=/^\/api\/avatars\/[A-Za-z0-9-]{1,128}\?v=\d+$/.test(persona.avatarUrl||'')?persona.avatarUrl:AVATARS.find(a=>a.id===persona.avatar)?.src;const avatar=document.querySelector('.profile-avatar');avatar.replaceChildren();if(ownAvatar){const image=document.createElement('img');image.src=ownAvatar;image.alt='我的头像';avatar.append(image);}else avatar.textContent=Array.from(accountUser.name)[0];}

  const preferencePanel = document.createElement('section'); preferencePanel.className = 'workspace-panel matching-preferences';
  preferencePanel.innerHTML = '<h2>我的匹配偏好</h2><p>保存常用需求，下单时仍可调整，不影响已创建订单。</p><form class="order-form" id="matching-preferences">'+demandFields()+'<button type="submit" class="workspace-button">保存匹配偏好</button><p role="status" data-preference-status></p></form>';
  $('#recommended-services').after(preferencePanel);
  bindTagButtons($('#matching-preferences'));
  const preferenceForm = $('#matching-preferences'), preferenceStatus = preferencePanel.querySelector('[data-preference-status]');
  try { fillDemand(preferenceForm, (await api('/api/preferences')).preferences); } catch (error) { showError(error, preferenceStatus); }
  preferenceForm.onsubmit = async event => { event.preventDefault(); const b = preferenceForm.querySelector('button[type=submit]'); b.disabled = true;
    try { fillDemand(preferenceForm, (await api('/api/preferences', requestBody(readDemand(preferenceForm)))).preferences); preferenceStatus.textContent = '匹配偏好已保存，下次下单自动带入。'; }
    catch (error) { showError(error, preferenceStatus); } finally { b.disabled = false; }
  };
  async function presence() { if (!$('#provider-workspace').hidden && document.visibilityState === 'visible' && profile?.state === 'available') { try { const result = await api('/api/provider/presence', {}); $('#dispatch-status').textContent = result.invitation ? '有一份接单邀请，请进入订单中心，在 '+new Date(result.invitation.expiresAt).toLocaleTimeString('zh-CN')+' 前确认。' : '正在等待匹配邀请；也可进入订单中心自主接单。'; } catch (error) { showError(error, $('#profile-error')); } } }
  await refreshUnread();
  setInterval(() => { presence(); if (document.visibilityState === 'visible') refreshUnread(); }, 20_000);
  function setRole(role) {
    role = role === 'provider' ? 'provider' : 'buyer';
    const url = new URL(location.href); url.searchParams.set('role', role); history.replaceState(null, '', url);
    document.querySelectorAll('[data-account-role]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.accountRole === role)));
    $('#buyer-workspace').hidden = role !== 'buyer'; $('#provider-workspace').hidden = role !== 'provider';
    $('#profile-view').textContent = role === 'buyer' ? '消费者视角' : '服务者视角'; $('#profile-orders').href = './orders.html?role=' + role;
    saveIdentityView(accountUser?.id,role);
    $('#active-role-label').textContent=role==='buyer'?'消费者':'接单者';
    $('#active-role-help').textContent=role==='buyer'?'选择服务、管理自己下的订单。':'填写服务资料、接单与管理服务记录。';
    document.querySelectorAll('a[href*="orders.html"]').forEach(link=>{const target=new URL(link.href);target.searchParams.set('role',role);link.href=target.pathname+target.search;});
  }
  document.querySelectorAll('[data-account-role]').forEach(b => b.onclick = () => { document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()); setRole(b.dataset.accountRole); presence(); });
  setRole(readIdentityView(accountUser?.id,new URL(location.href).searchParams.get('role')));
  $('#recommended-services').innerHTML = products.map(p => `<a class="compact-service" href="${serviceHref(p.id)}"><img src="${p.image}" alt=""><small>国服端游 · 试用价</small><h3>${p.title}</h3><div class="compact-price">¥${priceText(p.price)}<span>/ 小时</span></div><p>1 位陪玩 · ${p.gear} 套起</p><span class="text-link">查看服务 →</span></a>`).join('');
  $('#provider-preview-state').closest('label').innerHTML = '<span id="server-provider-state">正在读取状态…</span>';
  $('#provider-mode-options').innerHTML = `<form id="provider-profile" class="order-form"><label>游戏账户 ID<input name="gameId" maxlength="64" required></label><label>服务简介<textarea name="introduction" maxlength="160" required></textarea></label>${tagField('我的服务标签')}<label><input type="checkbox" name="trialAvailable">愿意在全体确认开始前自愿试音（非必需，空闲时可调整）</label><p class="matching-hint">试音非接单门槛。有助于匹配有试音需求的消费者，可能减少沟通和换人；不保证接单速度。通过参与者自行使用的游戏语音确认，平台不录音、不提供语音通话。</p>${products.map(p => `<fieldset><legend><label><input type="checkbox" name="mode" value="${p.id}">${p.title}</label></legend><label>对应模式 KD（自报）<input name="kd-${p.id}" type="number" min="0" max="100" step="0.01" placeholder="请填写" disabled></label><label>装备套数<input name="gear-${p.id}" type="number" min="${p.gear}" max="100" placeholder="${p.gear}套起" disabled></label></fieldset>`).join('')}<label><input name="adult" type="checkbox" required>已年满18周岁，资料真实；填写后直接可接单，无首次审核。</label><button type="submit" class="workspace-button">保存服务资料</button><p id="profile-error" role="status"></p></form>`;
  const dispatchStatus = document.createElement('p'); dispatchStatus.id = 'dispatch-status'; dispatchStatus.className = 'timer-caption'; dispatchStatus.setAttribute('role','status'); $('#availability-description').after(dispatchStatus);
  const squadPanel=document.createElement('section');$('#provider-mode-options').after(squadPanel);const {mountPaidSquad}=await import('./paid-squad-ui.mjs');await mountPaidSquad(squadPanel);
  const form = $('#provider-profile'); bindTagButtons(form);
  form.addEventListener('invalid', event => {
    const field = event.target;
    const message = field.name === 'mode' ? '请选择至少一种接单模式。' : field.name.startsWith('kd-') ? '请填写所选模式的有效 KD（0—100）。' : field.name.startsWith('gear-') ? '请填写所选模式要求的装备套数。' : field.name === 'adult' ? '请确认已满18周岁且资料真实。' : '请完整填写游戏账户 ID 和服务简介。';
    field.setCustomValidity(message);
    $('#profile-error').textContent = message;
  }, true);
  function clearProfileValidation(event) {
    event.target.setCustomValidity?.('');
    syncModeFields();
    $('#profile-error').textContent = '';
  }
  form.addEventListener('input', clearProfileValidation);
  form.addEventListener('change', clearProfileValidation);
  function syncModeFields() {
    const modes=[...form.querySelectorAll('[name="mode"]')];
    for(const mode of modes) for(const prefix of ['kd-','gear-']) {
      const field=form.elements[prefix+mode.value]; field.disabled=profile?.state==='serving'||!mode.checked; field.required=mode.checked;
      if(field.disabled)field.setCustomValidity('');
    }
    modes[0]?.setCustomValidity(modes.some(mode=>mode.checked)?'':'请选择至少一种接单模式。');
  }
  form.querySelectorAll('[name="mode"]').forEach(mode=>mode.addEventListener('change',syncModeFields));
  function renderProfile() {
    const state = profile?.state || 'idle';
    if (state !== 'available') $('#dispatch-status').textContent = '';
    $('#provider-availability').dataset.state = state;
    $('#server-provider-state').textContent = ({ idle: '未开启接单', available: '可接单', serving: '已有服务订单', suspended: '接单暂停' })[state];
    $('#availability-label').textContent = $('#server-provider-state').textContent;
    $('#availability-title').textContent = state === 'available' ? '已准备好，查看可接订单' : state === 'suspended' ? '接单功能暂时受限' : state === 'serving' ? '先完成当前订单' : '准备好，再开始接单';
    $('#availability-description').textContent = profile?.suspended ? profile.reason : '开启接单并保持服务者页面在线，可收到邀请。离开页面后不再续在线状态。KD为自报。';
    $('#availability-action').textContent = state === 'serving' ? '查看订单' : state === 'available' ? '停止接单' : '开启接单';
    $('#availability-action').disabled = state === 'suspended';
    form.querySelectorAll('input,textarea,button').forEach(input => input.disabled = state === 'serving');
    if (profile) {
      form.elements.gameId.value = profile.gameId; form.elements.introduction.value = profile.introduction; form.elements.adult.checked = true; form.elements.tags.value = (profile.tags || []).join('，'); form.elements.trialAvailable.checked = !!profile.trialAvailable;
      form.querySelectorAll('[name="mode"]').forEach(input => { input.checked = profile.modes.includes(input.value); const stat = profile.stats[input.value]; if (stat) { form.elements['kd-' + input.value].value = stat.kd; form.elements['gear-' + input.value].value = stat.gear; } });
    }
    syncTagButtons(form);
    syncModeFields();
  }
  let saving = false;
  async function save(available) {
    if (saving || !form.reportValidity()) return;
    saving = true;
    const saveButton = form.querySelector('button[type=submit]');
    saveButton.disabled = true;
    $('#availability-action').disabled = true;
    const modes = [...form.querySelectorAll('[name="mode"]:checked')].map(input => input.value);
    try { profile = (await api('/api/provider', requestBody({ tags: parseTags(form.elements.tags.value), trialAvailable: form.elements.trialAvailable.checked, gameId: form.elements.gameId.value, introduction: form.elements.introduction.value, adult: form.elements.adult.checked, modes, stats: Object.fromEntries(modes.map(mode => [mode, { kd: Number(form.elements['kd-' + mode].value), gear: Number(form.elements['gear-' + mode].value) }])), available }))).profile; renderProfile(); await presence(); $('#profile-error').textContent = '资料已保存。'; }
    catch (error) { showError(error, $('#profile-error')); }
    finally { saving = false; saveButton.disabled = profile?.state === 'serving'; $('#availability-action').disabled = profile?.state === 'suspended'; }
  }
  form.onsubmit = event => { event.preventDefault(); save(profile?.available || false); };
  $('#availability-action').onclick = () => profile?.state === 'serving' ? location.assign('./orders.html?role=provider') : save(!profile?.available);
  $('.availability-actions small').innerHTML = '<a href="./orders.html?role=provider">查看可接订单与服务记录 →</a>';
  try {
    profile = (await api('/api/provider')).profile; renderProfile(); await presence();
    const current = (await api('/api/orders')).orders.filter(o => !['completed', 'cancelled'].includes(o.status));
    $('.empty-service').innerHTML = current.length ? `<div><h3>你有 ${current.length} 笔待处理订单</h3><p>订单已保存，可继续处理。</p></div><a class="workspace-button primary" href="./orders.html?role=buyer">进入订单中心</a>` : '<div><h3>还没有进行中的服务</h3><p>选择游戏模式，找到与你一起行动的队友。</p></div><a class="workspace-button primary" href="#service-picks">去选服务 →</a>';
    const historyOrders = (await api('/api/orders?role=provider')).orders;
    $('#provider-workspace .account-bottom .message-empty').textContent = historyOrders.length ? `已保存 ${historyOrders.length} 笔服务记录，可进入订单查看进度与评价。` : '尚无服务记录，开启接单后可查看符合条件的订单。';
    const { user } = await api('/api/me');
    if (user.role === 'admin') { const a = document.createElement('a'); a.className = 'workspace-button'; a.href = './admin.html'; a.textContent = '进入平台处理台'; $('.profile-links').append(a); }
  } catch (error) { $('.empty-service').textContent = '服务状态暂时无法读取，请刷新页面，或从订单记录查看。'; showError(error, $('#profile-error')); }
}
if (!catalogError && $('#service-workspace')) {
  const product = getProduct(new URL(location.href).searchParams.get('mode'));
  if (!product) $('#service-workspace').innerHTML = paidOrdersAvailable() ? '<section class="workspace-empty"><h1>此服务暂不可选</h1><p>服务可能已下架，请返回服务列表。</p><a href="./index.html#services">查看可选服务</a></section>' : '<section class="workspace-empty"><h1>付费服务暂未开放</h1><p>可先使用免费组队；已有订单仍可在订单中心查看和处理。</p><a href="./teams.html">前往免费组队</a> · <a href="./orders.html">查看已有订单</a></section>';
  else {
    document.querySelectorAll('[data-service-title]').forEach(n => n.textContent = product.title);
    document.querySelectorAll('[data-service-price]').forEach(n => n.textContent = priceText(product.price));
    document.querySelectorAll('[data-service-gear]').forEach(n => n.textContent = product.gear + ' 套起');
    $('#service-illustration').src = './assets/original/briefing-lounge.webp';
    $('#service-mode-options').innerHTML = products.map(p => `<a href="${serviceHref(p.id)}" ${p.id === product.id ? 'aria-current="true"' : ''}>${p.title}</a>`).join('');
    $('#preview-selection').textContent = '创建订单'; $('.booking-demo').textContent = '本机测试：订单真实保存，模拟支付不扣款。';
    const selectedSeats=()=>Number(document.querySelector('[name="providerCount"]:checked').value);
    const updateTotal=()=>{document.querySelector('[data-service-total]').textContent=priceText(product.price*selectedSeats());$('.booking-subtitle').textContent='条件匹配 · '+selectedSeats()+' 位陪玩';};
    document.querySelectorAll('[name="providerCount"]').forEach(input=>input.addEventListener('change',updateTotal));updateTotal();
    $('#preview-selection').disabled = false;
    $('#preview-selection').onclick = async () => {
      const seats=selectedSeats();
      let defaults; try { defaults = (await api('/api/preferences')).preferences; } catch (error) { showError(error, $('.booking-demo')); return; }
      show('确认服务', `<dl class="confirmation-list"><div><dt>服务</dt><dd>${product.title} · 1小时 / ${seats}位陪玩</dd></div><div><dt>装备要求</dt><dd>${product.gear}套起</dd></div><div><dt>当前价格</dt><dd class="confirmation-total">¥${priceText(product.price*seats)}</dd></div></dl><form id="checkout-form" class="order-form">${demandFields()}<label>详细游戏需求（仅接单后的参与者与售后管理员可见）<textarea name="preference" maxlength="160"></textarea></label><label><input type="checkbox" name="rules" required>已阅读并同意点单须知</label><a href="./rules.html#order-notice" data-document="order-notice">阅读须知</a><p>消费者与全部服务者确认后起算；${seats===2?'双人订单整体履约，更换时重新匹配小队。':''}不承诺撤离或战利品收益。</p><a href="./rules.html#aftercare-draft" data-document="aftercare-draft">查看售后处理草案（新增建议待确认）</a><p id="checkout-error" role="status"></p><button type="submit" class="auth-submit">创建待支付订单</button></form>`);
      const form = $('#checkout-form'); bindTagButtons(form); fillDemand(form, defaults); const requestId = crypto.randomUUID();
      form.onsubmit = async event => { event.preventDefault(); const b = form.querySelector('button[type=submit]'); b.disabled = true;
        try { const { order } = await api('/api/orders', { requestId, ...readDemand(form), mode: product.id, providerCount:seats, rulesAccepted: form.elements.rules.checked, preference: form.elements.preference.value }); location.assign('./orders.html?order=' + order.id); }
        catch (error) { showError(error, $('#checkout-error')); b.disabled = false; }
      };
    };
  }
}

