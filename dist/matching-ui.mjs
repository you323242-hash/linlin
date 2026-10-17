import { parseTags } from './matching.mjs';
import { escapeHtml as esc } from './business-api.mjs';
const TAG_GROUPS = [ ['沟通',['耐心沟通','积极报点','轻松聊天','安静配合']], ['玩法',['战术协作','任务协助','路线讲解','物资搜集']], ['体验',['新手友好','节奏稳健','主动交战','娱乐开黑']] ];
const tagButtons=(tags,name)=>tags.map(tag=>`<button type="button" data-tag-field="${name}" data-tag="${tag}" aria-pressed="false">${tag}<span class="tag-check" aria-hidden="true">✓</span></button>`).join('');
export const tagField = (title, name = 'tags') => `<section class="tag-picker" aria-label="${esc(title)}"><div class="tag-picker-head"><h3>${esc(title)}</h3><span data-tag-counter="${name}" aria-live="polite">0 / 6</span></div><div class="tag-picker-options">${TAG_GROUPS.map(([group,tags])=>`<div class="tag-group"><span class="tag-group-name">${group}</span><div class="tag-suggestions" aria-label="${group}标签">${tagButtons(tags,name)}</div></div>`).join('')}</div><details class="tag-custom"><summary>更多协作标签</summary><div class="tag-suggestions">${tagButtons(['掩护配合','地图熟悉','新手讲解','部门任务','活动任务','对局复盘'],name)}</div></details><details class="tag-custom"><summary>自定义标签 <span>可选</span></summary><label>编辑标签<input name="${name}" maxlength="120" placeholder="用逗号分隔，例如：耐心沟通，桥区配合"></label></details><p class="matching-hint">最多6项，每项12字 · 自填标签不代表平台认证</p></section>`;
export const demandFields = () => `${tagField('希望陪玩的服务标签', 'desiredTags')}<label>派单备注（符合接单条件的服务者可见）<textarea name="matchNote" maxlength="120" placeholder="例如：刚接触机密，希望耐心讲解，轻松交流"></textarea></label><p class="matching-hint">请勿填写手机号、QQ号、微信号或其他隐私。详细入队资料留在订单沟通中。</p><label><input type="checkbox" name="preferTrial">优先匹配愿意入队前试音的服务者（非必需）</label><p class="matching-hint">先按接单条件筛选，再优先匹配标签；同等匹配时参考试音偏好。没有对应人选仍可分配其他合格服务者，不保证匹配速度。</p>`;
export const readDemand = form => ({ desiredTags: parseTags(form.elements.desiredTags.value), matchNote: form.elements.matchNote.value, preferTrial: form.elements.preferTrial.checked });
export function fillDemand(form, p) { form.elements.desiredTags.value = (p.desiredTags || []).join('，'); form.elements.matchNote.value = p.matchNote || ''; form.elements.preferTrial.checked = !!p.preferTrial; syncTagButtons(form); }
export const demandSummary = order => `<section class="detail-section matching-summary"><h3>匹配需求</h3><p>${(order.desiredTags || []).length ? order.desiredTags.map(esc).join(' · ') : '未设置标签偏好'}</p>${order.matchNote ? `<p>${esc(order.matchNote)}</p>` : ''}<p>${order.preferTrial ? '希望入队前自愿试音' : '不要求试音'} · 标签与试音均不构成平台能力认证。</p>${order.match ? `<p>与你匹配${order.match.matchedTags.length}个标签${order.match.trialMatched ? '，试音偏好一致' : ''}。</p>` : ''}</section>`;

export function syncTagButtons(form) {
  form.querySelectorAll('[data-tag-field]').forEach(button => {
    let tags = []; try { tags = parseTags(form.elements[button.dataset.tagField].value); } catch { /* Keep invalid custom text available for correction. */ }
    button.setAttribute('aria-pressed', String(tags.includes(button.dataset.tag)));
  });
  form.querySelectorAll('[data-tag-counter]').forEach(node=>{ const input=form.elements[node.dataset.tagCounter]; if(!input)return; try{node.textContent=parseTags(input.value).length+' / 6';}catch{node.textContent='请检查标签';} });
}
export function bindTagButtons(form) {
  form.addEventListener('input', () => { form.querySelectorAll('[data-tag-field]').forEach(b => form.elements[b.dataset.tagField].setCustomValidity('')); syncTagButtons(form); });
  form.addEventListener('click', event => {
    const button = event.target.closest('[data-tag-field]'); if (!button || button.disabled) return;
    const input = form.elements[button.dataset.tagField];
    try {
      const tags = parseTags(input.value), tag = button.dataset.tag;
      input.value = parseTags((tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag]).join('，')).join('，');
      input.setCustomValidity(''); syncTagButtons(form);
    } catch (error) { input.setCustomValidity(error.message); const details=input.closest?.('details'); if(details)details.open=true; input.reportValidity(); }
  });
  syncTagButtons(form);
}
export const demandPreview = order => (order.desiredTags?.length || order.matchNote || order.preferTrial) ? '<div class="order-demand"><strong>服务需求</strong><p>'+[...(order.desiredTags || []).map(esc), ...(order.preferTrial ? ['自愿试音'] : [])].join(' · ')+'</p>'+(order.matchNote ? '<p>'+esc(order.matchNote)+'</p>' : '')+(order.match ? '<small>与你匹配'+order.match.matchedTags.length+'个标签'+(order.match.trialMatched ? ' · 试音偏好一致' : '')+'</small>' : '')+'</div>' : '';

