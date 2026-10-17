import { accountTitle, accountPanel, mountAuthPanel, initializeAuth } from './auth-ui.js?v=4';
import { mountProjectLetter } from './project-letter.mjs';
import { availableProducts, priceText, serviceHref, refreshProducts, paidOrdersAvailable } from './catalog.mjs?v=4';
let catalogUnavailable = false;
let catalogPending = true;
// One catalog request per page; account interaction never waits for it.
export const catalogReady = refreshProducts().then(() => { catalogPending = false; return null; }, error => { catalogPending = false; catalogUnavailable = true; return error; });
// Only new-paid navigation is hidden; historical orders and support remain reachable.
catalogReady.then(error => {
  if (error || paidOrdersAvailable()) return;
  document.querySelectorAll('.team-paid-entry, .people-section:has(#paid-people), #join').forEach(section => { section.hidden = true; });
  document.querySelectorAll('a[href]').forEach(link => {
    const href = link.getAttribute('href');
    if (/^(?:\.\/)?(?:index\.html#services|service\.html(?:\?|$))/.test(href)) link.hidden = true;
  });
});
const dialog = document.querySelector('#preview-dialog');
const title = document.querySelector('#dialog-title');
const content = document.querySelector('#dialog-content');
let returnFocus = null;

const panels = {
  profile: ["账户资料","<p>正式登录后，可管理昵称、游戏ID与绑定的登录方式。切换身份共用同一个账户。</p><p>本机支持账户与服务资料保存；手机号、微信、QQ登录暂未接入。</p>"],
  earnings: ["收益与结算","<p>支付接入后，将分别展示待结算收入、可提现金额与收支记录。</p><p>费用承担、结算周期及提现方式将在正式接单前明确说明。</p><p class=\"dialog-note\">当前尚未接入支付与结算，不显示模拟可提现余额。</p>"],
  orders: ['我的订单', '<p>订单与服务记录已保存在本机数据库。</p><p class="dialog-note"><a href="./orders.html">进入订单中心</a> · 支付均为模拟，不产生真实资金。</p>'],
  help: () => ['客服与帮助', `<p>${catalogPending ? '正在读取服务列表，请稍候。' : catalogUnavailable ? '服务列表暂时不可用，不影响账户登录或查看已有订单。' : '当前提供国服端游小时陪玩：' + availableProducts().map(item => item.title + ' ¥' + priceText(item.price) + ' / 人 / 小时').join('；') + '。可选择一位或两位服务者。'}</p><details class="help-question" open><summary>从什么时候开始计时？</summary><p>消费者与全部服务者分别确认开始后计时，到时完成已开始的当前对局。</p></details><details class="help-question"><summary>如何匹配合适的服务者？</summary><p>下单时可添加需求标签与备注；符合条件者按标签匹配优先。试音自愿，通过游戏语音在全部参与者确认开始前沟通，不计服务时长，也不保证匹配速度。</p></details><details class="help-question"><summary>服务遇到问题怎么处理？</summary><p>进入对应订单的“售后 / 自助处理”，系统按实际状态提供取消、换人或申请入口。责任争议可提交经过及材料、回应补证要求，查看方案并提出异议。</p></details><p><a href="./rules.html#order-notice" data-document="order-notice">点单须知</a> · <a href="./rules.html#provider-notice" data-document="provider-notice">接单须知</a></p><p><a href="./rules.html#aftercare-draft" data-document="aftercare-draft">售后处理规则草案</a></p><p class="dialog-note">本机订单售后由管理员核实；实时客服与AI客服未接入。</p>`],
  join: ['服务者入驻', '<p>自主接单，免收押金。无固定在线时长要求，接单后应完成已确认的服务。</p><ul><li>年满18周岁，如实填写必要的服务信息</li><li>对应模式KD建议不低于1.0；低于1.0须在开始前如实告知，并获得消费者同意</li><li>陪玩装备要求：机密 4 套起，绝密 5 套起</li><li>具备基础实战能力，沟通清晰、响应及时、积极配合</li><li>注册后即可接单，不设首次审核；服务过程中持续评估</li></ul><a class="inline-rule-link" href="./account.html?role=provider">进入服务者中心</a><p class="dialog-note">多次有效投诉或战绩持续明显不达标，可暂停接单并支持申诉。本机可填写服务资料；KD与装备为自行申报，请勿上传身份证原图。</p><a class="inline-rule-link" href="./rules.html#provider-notice" data-document="provider-notice">阅读接单须知</a>'],
  sources: ['原创视觉', '<p>本站角色与海岸场景由文字描述独立生成，未使用游戏角色、游戏截图或第三方插画作为参考。默认头像为原创几何设计，角色仅作装饰，不代表真实服务者。</p><p>用户上传头像须具有合法使用权；游戏名称仅用于说明服务适用范围，平台并非游戏官方。</p><div id="art-credits"></div>'],
};

export function show(titleText, html, trigger) {
  title.textContent = titleText;
  content.innerHTML = html;
  dialog.dataset.skin = content.querySelector('[data-kind]')?.dataset.kind || (titleText.includes('名片设置') ? 'editor' : titleText.includes('账户') || titleText.includes('登录') ? 'account' : 'information');
  returnFocus = trigger;
  dialog.showModal();
  dialog.scrollTop = 0;
}
document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', async () => {
  if (button.dataset.panel === 'persona') { show('我的名片设置','正在读取名片…',button); try { const {mountPersonaEditor}=await import('./persona-editor.mjs'); await mountPersonaEditor(content); } catch(error) { content.textContent=error.message; } return; }
  if (button.dataset.panel === 'messages') { show('消息中心','正在读取站内消息…',button); const {mountInbox}=await import('./notifications.mjs'); await mountInbox(content); return; }
  const panel = ['account', 'profile'].includes(button.dataset.panel) ? [accountTitle(), accountPanel()] : typeof panels[button.dataset.panel] === 'function' ? panels[button.dataset.panel]() : panels[button.dataset.panel];
  if (!panel) return;
  show(panel[0], panel[1], button);
  if (['account', 'profile'].includes(button.dataset.panel)) mountAuthPanel(content);
  if (button.dataset.panel === 'sources') {
    const credits = document.querySelector('#art-credits');
    fetch('./art-credits.json').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(works => {
      for (const work of works) {
        const p = document.createElement('p'); const a = document.createElement('a');
        a.href = work.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = `${work.artist} · ${work.title}`;
        p.append(a); credits.append(p);
      }
    }).catch(() => { credits.textContent = '插图来源清单暂时无法加载。'; });
  }
}));
document.querySelectorAll('#close-dialog, #dismiss-dialog').forEach(button => button.addEventListener('click', () => dialog.close()));
dialog.addEventListener('close', () => returnFocus?.focus());
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });

const documentDialog = document.querySelector('#document-dialog');
const documentTitle = document.querySelector('#document-title');
const documentContent = document.querySelector('#document-content');
const fullDocumentLink = document.querySelector('#document-full-link');
let documentTrigger = null;
let rulesSource = null;

document.addEventListener('click', async event => {
  const link = event.target.closest('[data-document]');
  if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const id = link.dataset.document;
  if (!['order-notice', 'provider-notice', 'user-agreement', 'disclaimer', 'aftercare-draft'].includes(id)) return;
  documentTrigger = link;
  documentTitle.textContent = link.textContent.includes('点单') ? '点单须知' : link.textContent.includes('接单') ? '接单须知' : id === 'aftercare-draft' ? '售后处理规则草案' : id === 'user-agreement' ? '用户服务协议' : '免责声明与风险提示';
  documentContent.textContent = '正在加载正文…';
  fullDocumentLink.href = `./rules.html#${id}`;
  documentDialog.showModal();
  try {
    if (!rulesSource) {
      const response = await fetch('./rules.html?v=8');
      if (!response.ok) throw new Error('Rules unavailable');
      rulesSource = new DOMParser().parseFromString(await response.text(), 'text/html');
    }
    const section = rulesSource.getElementById(id);
    if (!section) throw new Error('Document missing');
    if (!documentDialog.open || documentTrigger !== link) return;
    documentTitle.textContent = section.dataset.title;
    documentContent.replaceChildren(section.querySelector('.legal-meta').cloneNode(true), section.querySelector('.legal-content').cloneNode(true));
    documentContent.scrollTop = 0;
  } catch {
    documentContent.textContent = '正文暂时无法加载。可点击下方“查看全文”，或稍后重试。';
  }
});
document.querySelectorAll('[data-close-document]').forEach(button => button.addEventListener('click', () => documentDialog.close()));
documentDialog.addEventListener('close', () => documentTrigger?.focus());
documentDialog.addEventListener('click', event => {
  if (event.target !== documentDialog) return;
  const rect = documentDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) documentDialog.close();
});

// Local preview controls never create identities or initiate third-party login.
document.addEventListener('click', event => {
  const button = event.target.closest('[data-login-method]');
  if (!button) return;
  const method = button.dataset.loginMethod;
  if (!['email', 'phone', 'wechat', 'qq'].includes(method)) return;
  document.querySelectorAll('[data-login-method]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.loginMethod === method)));
  document.querySelectorAll('[data-login-panel]').forEach(item => { item.hidden = item.dataset.loginPanel !== method; });
});

async function renderProducts() {
  const productGrid = document.querySelector('.price-grid');
  if (!productGrid) return;
  const template = productGrid.querySelector('.price-card')?.cloneNode(true);
  productGrid.setAttribute('aria-busy', 'true');
  productGrid.querySelectorAll('.select-button').forEach(link => { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); link.querySelector('span').textContent = '正在读取服务…'; });
  productGrid.querySelectorAll('.price strong').forEach(price => { price.textContent = '—'; });
  await catalogReady;
  productGrid.removeAttribute('aria-busy');
  const cards = availableProducts().map((product, index) => {
    const card = template.cloneNode(true);
    card.className = `price-card ${product.id}`;
    card.dataset.productCard = product.id;
    const heading = card.querySelector('.mode-heading h2');
    heading.textContent = product.title;
    heading.id = `product-${product.id}-title`;
    card.setAttribute('aria-labelledby', heading.id);
    card.querySelector('.mode-code').textContent = `${String(index + 1).padStart(2, '0')} — 国服端游`;
    const art = card.querySelector('.card-art');
    const pageArt = { secret: ['original/amber-outpost.webp', '平台原创战术伙伴插画'], topsecret: ['original/copper-outpost.webp', '平台原创通讯伙伴插画'] }[product.id];
    art.src = pageArt ? `./assets/${pageArt[0]}` : product.image;
    art.alt = pageArt ? pageArt[1] : `${product.title}场景概念插图`;
    const [whole, decimal] = priceText(product.price).split('.');
    card.querySelector('.price strong').innerHTML = whole + '<span class="decimal">.' + decimal + '</span>';
    card.querySelector('.equipment strong').textContent = product.gear + ' 套起';
    const link = card.querySelector('.select-button');
    link.removeAttribute('aria-disabled');
    link.href = serviceHref(product.id);
    link.querySelector('span').textContent = `选择${product.shortTitle}`;
    return card;
  });
  productGrid.replaceChildren(...cards);
  if (!cards.length) {
    productGrid.textContent = catalogUnavailable ? '服务列表暂时无法读取，请刷新页面重试。' : paidOrdersAvailable() ? '当前暂无可选服务，请稍后再来。' : '付费服务暂未开放，欢迎先来免费组队。已有订单仍可在订单中心处理。';
    if (!catalogUnavailable && !paidOrdersAvailable()) { const link = document.createElement('a'); link.href = './teams.html'; link.textContent = '前往免费组队 →'; productGrid.append(document.createElement('br'), link); }
  }
}

initializeAuth(show);
mountProjectLetter(show);
renderProducts().catch(() => { const grid = document.querySelector('.price-grid'); if (grid) { grid.removeAttribute('aria-busy'); grid.textContent = '服务列表暂时无法显示，请刷新页面重试。'; } });

