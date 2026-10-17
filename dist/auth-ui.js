import { safeReturnPath, responseStatus, rateLimitError, api as businessApi } from './business-api.mjs';
let currentUser = null;
let loading = true;
let sessionError = false;
let sessionRequest = 0;
let phoneMockEnabled = false;
const phonePasswordForm = () => `<form class="registration-fields" data-phone-password-login><label>手机号<input name="phone" type="tel" inputmode="tel" autocomplete="username" maxlength="14" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label><div class="consent-row"><input id="phone-remember" name="remember" type="checkbox" checked><label for="phone-remember">保持登录7天（公共设备请取消）</label></div><p class="auth-message" role="status"></p><button class="auth-submit" type="submit">手机号密码登录</button></form>`;
const firstPasswordForm = () => `<button type="button" class="text-link" data-password-open>设置登录密码 →</button><form class="registration-fields" data-first-password hidden><p class="dialog-note">验证码登录后5分钟内可设置一次；以后可用手机号和密码登录。模拟认证不证明号码归属。</p><label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>确认密码<input name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><p class="auth-message" role="status"></p><button class="auth-submit" type="submit">保存登录密码</button></form>`;
function phoneForm(binding = false) {
  return `<form class="registration-fields" data-phone-form data-binding="${binding}"><p class="dialog-note">模拟验证码仅写入服务器私有测试收件箱，不发送短信，也不验证真实号码归属。</p><label>手机号<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="14" placeholder="中国大陆11位手机号" required></label><button type="button" class="text-link" data-phone-send>获取模拟验证码</button><label>验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="输入6位测试验证码" required></label>${binding ? '<label>原账户密码<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>' : '<div class="consent-row"><input name="termsAccepted" type="checkbox" id="phone-consent"><label for="phone-consent">首次使用请阅读并同意<a href="./rules.html#user-agreement">用户协议</a>及<a href="./rules.html#disclaimer">风险提示</a></label></div>'}<p data-phone-message class="auth-message" role="status" aria-live="polite"></p><button class="auth-submit" type="submit">${binding ? '确认模拟绑定' : '验证并登录'}</button></form>`;
}
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('delta-session') : null;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeReturn = () => {
  const value = new URL(location.href).searchParams.get('returnTo');
  return safeReturnPath(value);
};

export const accountTitle = () => currentUser ? '我的账户' : '登录 / 注册';
export function accountPanel() {
  if (loading) return '<p role="status" data-auth-loading>正在确认登录状态…</p>';
  if (sessionError) return '<p class="login-intro" role="status">暂时无法确认登录状态，请检查网络后重试。</p><button type="button" class="auth-submit" data-auth-retry>重新连接</button>';
  if (currentUser?.isGuest) return `<div class="auth-profile"><p class="login-intro">已登录为 <strong>${escape(currentUser.name)}</strong></p><p class="dialog-note">游客可体验免费组队与模拟付费流程，不会真实扣款，不能进入管理后台。身份通过当前浏览器的登录状态保持；退出、清除浏览器数据或会话失效后，无法找回原游客资料。不会自动删除已发布的内容，请先结束不再需要的招募。</p><a class="account-preview-link" href="./teams.html">进入免费组队 →</a><a class="account-preview-link" href="./index.html#services">体验付费流程（模拟） →</a><a class="account-preview-link" href="./account.html">进入用户中心 →</a><button type="button" class="auth-submit" data-sign-out>退出游客登录</button><p id="auth-message" class="auth-message" role="status"></p></div>`;
  if (currentUser) return `<div class="auth-profile"><p class="login-intro">已登录为 <strong>${escape(currentUser.name)}</strong></p><dl>${currentUser.email.endsWith('@phone.example.invalid') ? '' : `<div><dt>邮箱</dt><dd>${escape(currentUser.email)} · ${currentUser.emailVerified ? '已验证' : '未验证'}</dd></div>`}${currentUser.phoneMasked ? `<div><dt>手机号（模拟绑定）</dt><dd>${escape(currentUser.phoneMasked)}</dd></div>` : ''}<div><dt>账户编号</dt><dd>${escape(currentUser.id)}</dd></div></dl>${!currentUser.emailVerified && !currentUser.email.endsWith('@phone.example.invalid') ? '<a class="text-link" href="./recovery.html">验证邮箱 →</a>' : ''}${phoneMockEnabled && !currentUser.phoneMasked && currentUser.role !== 'admin' ? '<button type="button" class="text-link" data-phone-bind>绑定测试手机号</button><div data-phone-bind-panel hidden>' + phoneForm(true) + '</div>' : ''}${phoneMockEnabled && currentUser.phoneMasked && !currentUser.phonePasswordSet && currentUser.role !== 'admin' ? firstPasswordForm() : ''}<a class="account-preview-link" href="./account.html">进入用户中心 →</a><button type="button" class="auth-submit" data-sign-out>退出登录</button><p id="auth-message" class="auth-message" role="status"></p></div>`;
  return `<p class="login-intro">一个账户，自由切换消费者与服务者身份。</p>
    <div class="login-tabs" role="group" aria-label="登录方式"><button type="button" data-login-method="email" aria-pressed="true">内测账号</button><button type="button" data-login-method="phone" aria-pressed="false" ${phoneMockEnabled ? '' : 'disabled'} title="${phoneMockEnabled ? '私有模拟验证码，不发送短信' : '短信渠道尚未接入'}">手机号 · ${phoneMockEnabled ? '模拟测试' : '待开通'}</button><button type="button" data-login-method="wechat" aria-pressed="false" disabled title="微信授权尚未接入">微信</button><button type="button" data-login-method="qq" aria-pressed="false" disabled title="QQ授权尚未接入">QQ</button></div>
    <p class="login-test-note">可使用内测账号，或选择<button type="button" class="text-link" data-login-method="guest" aria-pressed="false">游客登录</button>体验组队与模拟付费流程。第三方登录暂未开放。</p>
    <div data-login-panel="guest" hidden><form class="registration-fields" data-guest-form><p class="dialog-note">无需邮箱或密码，建立独立游客身份；可操作免费组队与付费功能的模拟流程，不会真实扣款。退出、清除浏览器数据或会话失效后无法找回原资料。请勿填写真实个人信息。已发布内容不会因退出自动删除。</p><div class="consent-row"><input type="checkbox" id="guest-consent" name="termsAccepted" required><label for="guest-consent">我已阅读并同意<a href="./rules.html#user-agreement">用户协议</a>、<a href="./rules.html#user-agreement-chapter-8">个人信息说明</a>及<a href="./rules.html#disclaimer">风险提示</a></label></div><p class="auth-message" role="status" aria-live="polite"></p><button class="auth-submit" type="submit">以游客身份进入</button></form></div>
    <div data-login-panel="email"><div class="auth-tabs" role="group" aria-label="账户操作"><button type="button" data-auth-mode="login" aria-pressed="true">登录</button><button type="button" data-auth-mode="register" aria-pressed="false">注册新账户</button></div>
    <form id="auth-form" class="registration-fields" data-mode="login">
      <label data-register-field hidden>昵称<input name="name" autocomplete="nickname" maxlength="32" placeholder="你希望大家如何称呼你" disabled></label>
      <label>邮箱<input name="email" type="email" autocomplete="username" maxlength="254" placeholder="请输入邮箱" required></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" maxlength="128" placeholder="请输入密码" required></label>
      <label data-register-field hidden>确认密码<input name="confirmPassword" type="password" autocomplete="new-password" maxlength="128" placeholder="再次输入密码" disabled></label>
      <div class="consent-row" data-register-field hidden><input type="checkbox" id="registration-consent" name="termsAccepted" disabled><div><label for="registration-consent">我已阅读并同意</label><a href="./rules.html#user-agreement" data-document="user-agreement">《用户服务协议》</a><span>及</span><a href="./rules.html#disclaimer" data-document="disclaimer">《免责声明与风险提示》</a></div></div>
      <p id="auth-message" class="auth-message" role="status" aria-live="polite"></p><button type="submit" class="auth-submit">登录</button>
    </form><a class="text-link" href="./recovery.html">邮箱验证 / 找回密码</a><p class="dialog-note">登录保留7天；公共设备使用后请退出。</p></div>
    <div data-login-panel="phone" hidden>${phoneMockEnabled ? `<div class="auth-tabs" aria-label="手机号登录方式"><button type="button" data-phone-login-mode="password" aria-pressed="true">密码登录</button><button type="button" data-phone-login-mode="otp" aria-pressed="false">验证码 / 注册</button></div><div data-phone-login-view="password">${phonePasswordForm()}</div><div data-phone-login-view="otp" hidden>${phoneForm()}</div>` : '<p>手机号登录尚未开放</p>'}</div>
    <div data-login-panel="wechat" hidden><div class="login-placeholder"><p>微信授权登录尚未开放</p><small>目前可以使用邮箱和密码注册或登录。</small></div></div>
    <div data-login-panel="qq" hidden><div class="login-placeholder"><p>QQ授权登录尚未开放</p><small>目前可以使用邮箱和密码注册或登录。</small></div></div>`;
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  } catch { throw new Error('暂时无法连接用户服务，请检查网络后重试。'); }
  if (response.status === 429) throw rateLimitError(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status >= 500) throw new Error('用户服务暂时不可用，请稍后重试。');
    const messages = {
      USER_ALREADY_EXISTS: '此邮箱已注册，请切换到登录。', USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '此邮箱已注册，请切换到登录。',
      INVALID_PHONE_NUMBER_OR_PASSWORD: '手机号或密码不正确。', INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确。', INVALID_PASSWORD: '邮箱或密码不正确。',
      PASSWORD_TOO_SHORT: '密码至少需要12个字符。', PASSWORD_TOO_LONG: '密码最多128个字符。',
      INVALID_EMAIL: '请输入有效邮箱。', TOO_MANY_REQUESTS: '尝试过于频繁，请稍后再试。',
      EMAIL_NOT_VERIFIED: '请先通过自己的邮件验证邮箱，再登录。',
      OTP_NOT_FOUND: '验证码不存在或已使用，请重新获取。', OTP_EXPIRED: '验证码已过期，请重新获取。', INVALID_OTP: '验证码不正确。', TOO_MANY_ATTEMPTS: '验证码错误次数过多，请重新获取。', PHONE_NUMBER_EXIST: '此号码已经绑定其他账户。',
    };
    throw new Error(messages[data.code] || (!data.code && data.message) || (response.status === 404 ? '用户服务未启动，请通过项目的用户系统地址访问。' : '操作未成功，请检查输入或稍后重试。'));
  }
  return data;
}

function mountSecondFactor(container) {
  container.innerHTML = `<p class="login-intro">密码已验证。请输入验证码应用中的6位数字，或使用一条未用过的恢复码。</p><form id="factor-login-form" class="registration-fields"><label>验证方式<select name="method"><option value="totp">验证码应用</option><option value="backup">单次恢复码</option></select></label><label>验证码<input name="code" autocomplete="one-time-code" maxlength="40" required></label><p id="factor-message" class="auth-message" role="status" aria-live="polite"></p><button class="auth-submit">验证并登录</button></form><button type="button" class="text-link" data-restart-login>重新登录</button>`;
  const form = container.querySelector('form'), status = container.querySelector('#factor-message');
  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('button'); if (button.disabled) return;
    button.disabled = true; status.textContent = '正在验证…';
    try {
      await businessApi('/api/security/verify', { method: form.elements.method.value, code: form.elements.code.value.trim() });
      form.reset(); channel?.postMessage('changed'); location.replace(safeReturn());
    } catch (error) { status.textContent = error.message; }
    finally { form.elements.code.value = ''; button.disabled = false; }
  };
  container.querySelector('[data-restart-login]').onclick = () => { container.innerHTML = accountPanel(); mountAuthPanel(container); };
  form.elements.code.focus();
}

function renderIdentity() {
  document.querySelectorAll('[data-panel="account"]').forEach(button => {
    const label = button.querySelector('span');
    const text = sessionError ? '账户暂不可用' : currentUser ? currentUser.name : '登录 / 注册';
    if (label) label.textContent = text;
    else button.textContent = sessionError ? text : currentUser ? '账户与退出' : text;
    button.setAttribute('aria-label', sessionError ? text : currentUser ? `账户：${currentUser.name}` : '登录或注册');
  });
  const workspace = document.querySelector('#account-workspace');
  if (workspace && currentUser) {
    workspace.hidden = false;
    document.querySelector('.profile-card h2').textContent = currentUser.name;
    document.querySelector('.workspace-preview').textContent = currentUser.isGuest ? '已登录 · 游客体验' : currentUser.phoneMasked ? '已登录 · 手机号模拟认证' : '已登录 · 内测账户';
  }
}

export async function refreshSession() {
  const request = ++sessionRequest;
  const workspace = document.querySelector('#account-workspace');
  if (workspace) workspace.hidden = true;
  try {
    const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    const user = response.ok ? (await response.json()).user : null;
    if (request !== sessionRequest) return;
    if (response.headers?.get('x-delta-environment') === 'staging' && !document.querySelector('#staging-notice')) {
      const notice = document.createElement('p');
      notice.id = 'staging-notice'; notice.className = 'dialog-note';
      notice.textContent = '封闭内测 · 支付与退款均为模拟，请勿真实转账。';
      document.querySelector('main')?.prepend(notice);
    }
    if (response.ok && user?.id) currentUser = user;
    else if (responseStatus(response) === 401) currentUser = null;
    else throw new Error('Session unavailable');
    sessionError = false;
    document.querySelector('#auth-connection-error')?.remove();
    loading = false;
    renderIdentity();
    if (workspace && !currentUser) location.replace('/?login=1&returnTo=' + encodeURIComponent('/account.html' + location.search));
  } catch {
    if (request !== sessionRequest) return;
    loading = false;
    currentUser = null;
    sessionError = true;
    renderIdentity();
    if (workspace && !document.querySelector('#auth-connection-error')) {
      const notice = document.createElement('section');
      notice.id = 'auth-connection-error'; notice.className = 'profile-card';
      notice.innerHTML = accountPanel();
      workspace.before(notice);
      notice.querySelector('[data-auth-retry]').addEventListener('click', async () => {
        await refreshSession();
        if (!sessionError) location.reload();
      });
    }
  }
}

export function mountAuthPanel(container) {
  const guestForm = container.querySelector('[data-guest-form]');
  guestForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const button=guestForm.querySelector('[type="submit"]'),status=guestForm.querySelector('.auth-message');
    if(button.disabled)return;
    if(!guestForm.elements.termsAccepted.checked){status.textContent='请先阅读并同意协议。';return;}
    button.disabled=true;status.textContent='正在建立游客身份…';
    try {await api('/api/auth/sign-in/anonymous',{termsAccepted:true});channel?.postMessage('changed');location.replace(safeReturn());}
    catch(error){status.textContent=error.message;}
    finally{button.disabled=false;}
  });
  container.querySelector('[data-password-open]')?.addEventListener('click',()=>{const form=container.querySelector('[data-first-password]');form.hidden=!form.hidden;});
  container.querySelectorAll('[data-phone-login-mode]').forEach(button=>button.addEventListener('click',()=>{
    container.querySelectorAll('[data-phone-login-view]').forEach(panel=>panel.hidden=panel.dataset.phoneLoginView!==button.dataset.phoneLoginMode);
    container.querySelectorAll('[data-phone-login-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  }));
  for(const form of container.querySelectorAll('[data-phone-password-login],[data-first-password]')) form.addEventListener('submit',async event=>{
    event.preventDefault();const submit=form.querySelector('[type="submit"]'),status=form.querySelector('.auth-message');if(submit.disabled)return;
    const setting=form.hasAttribute('data-first-password'),password=form.elements.password.value;
    if(setting&&password!==form.elements.confirm.value){status.textContent='两次输入的密码不一致。';return;}
    submit.disabled=true;
    try{
      if(setting){await api('/api/auth/phone-number/set-password',{newPassword:password});await refreshSession();container.innerHTML=accountPanel();mountAuthPanel(container);}
      else {const raw=form.elements.phone.value.trim();await api('/api/auth/sign-in/phone-number',{phoneNumber:raw.startsWith('+86')?raw:'+86'+raw,password,rememberMe:form.elements.remember.checked});channel?.postMessage('changed');location.replace(safeReturn());}
    }catch(error){status.textContent=error.message;}finally{form.elements.password.value='';if(setting)form.elements.confirm.value='';submit.disabled=false;}
  });
  container.querySelectorAll('[data-login-method]:not([disabled])').forEach(button => button.addEventListener('click', () => {
    container.querySelectorAll('[data-login-panel]').forEach(panel => { panel.hidden = panel.dataset.loginPanel !== button.dataset.loginMethod; });
    container.querySelectorAll('[data-login-method]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  container.querySelector('[data-phone-bind]')?.addEventListener('click', () => { const panel = container.querySelector('[data-phone-bind-panel]'); panel.hidden = !panel.hidden; });
  container.querySelectorAll('[data-phone-form]').forEach(form => {
    const status = form.querySelector('[data-phone-message]');
    const phone = () => { const value = form.elements.phone.value.trim(); return value.startsWith('+86') ? value : '+86' + value; };
    const send = form.querySelector('[data-phone-send]');
    send.onclick = async () => {
      if (send.disabled) return;
      if (!/^\+861[3-9]\d{9}$/.test(phone())) { status.textContent = '请输入中国大陆11位手机号。'; return; }
      send.disabled = true;
      try { await api('/api/auth/phone-number/send-otp', { phoneNumber: phone() }); status.textContent = '已写入私有测试收件箱，5分钟内有效；不发送短信。'; setTimeout(() => { send.disabled = false; }, 60000); }
      catch (error) { status.textContent = error.message; send.disabled = false; }
    };
    form.onsubmit = async event => {
      event.preventDefault(); const submit = form.querySelector('[type="submit"]'); if (submit.disabled) return;
      submit.disabled = true;
      try { await api('/api/auth/phone-number/verify', { phoneNumber: phone(), code: form.elements.code.value, ...(form.dataset.binding === 'true' ? { updatePhoneNumber: true, password: form.elements.password.value } : { termsAccepted: form.elements.termsAccepted.checked }) }); form.reset(); channel?.postMessage('changed'); location.replace(safeReturn()); }
      catch (error) { status.textContent = error.message; }
      finally { if (form.elements.password) form.elements.password.value = ''; submit.disabled = false; }
    };
  });
  container.querySelector('[data-auth-retry]')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    await refreshSession();
    container.innerHTML = accountPanel(); mountAuthPanel(container);
  });
  const form = container.querySelector('#auth-form');
  container.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => {
    const register = button.dataset.authMode === 'register';
    form.reset(); form.dataset.mode = register ? 'register' : 'login';
    container.querySelectorAll('[data-auth-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    form.querySelectorAll('[data-register-field]').forEach(field => {
      field.hidden = !register;
      field.querySelectorAll('input').forEach(input => { input.disabled = !register; input.required = register; });
    });
    form.elements.password.minLength = register ? 12 : 1;
    form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
    form.elements.password.placeholder = register ? '设置12–128个字符的密码' : '请输入密码';
    form.querySelector('[type="submit"]').textContent = register ? '注册并登录' : '登录';
    form.querySelector('#auth-message').textContent = '';
  }));
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const register = form.dataset.mode === 'register';
    const message = form.querySelector('#auth-message');
    const submit = form.querySelector('[type="submit"]');
    const password = form.elements.password.value;
    if (register && password !== form.elements.confirmPassword.value) { message.textContent = '两次输入的密码不一致。'; return; }
    if (register && !form.elements.termsAccepted.checked) { message.textContent = '请先阅读并同意协议。'; return; }
    submit.disabled = true; message.textContent = register ? '正在创建账户…' : '正在登录…';
    try {
      const result = await api(`/api/auth/${register ? 'sign-up' : 'sign-in'}/email`, { email: form.elements.email.value.trim().toLowerCase(), password, ...(register ? { name: form.elements.name.value.trim(), termsAccepted: true } : {}), rememberMe: true });
      form.reset();
      if (register && result.verificationRequired) { message.textContent = '注册请求已处理，请通过邮件验证邮箱后登录。'; return; }
      if (result.twoFactorRedirect) { mountSecondFactor(container); return; }
      channel?.postMessage('changed');
      location.replace(safeReturn());
    } catch (error) { message.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  container.querySelector('[data-sign-out]')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await api('/api/auth/sign-out', {});
      currentUser = null; renderIdentity();
      const workspace = document.querySelector('#account-workspace'); if (workspace) workspace.hidden = true;
      channel?.postMessage('changed');
      location.replace('/');
    } catch (error) { container.querySelector('#auth-message').textContent = error.message; button.disabled = false; }
  });
}

export async function initializeAuth(show) {
  try { const response = await fetch('/api/integrations', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) }); phoneMockEnabled = response.ok && (await response.json()).login?.phone?.mode === 'private-mock-inbox'; } catch { phoneMockEnabled = false; }
  await refreshSession();
  const open = () => { show(accountTitle(), accountPanel()); mountAuthPanel(document.querySelector('#dialog-content')); };
  if ((new URL(location.href).searchParams.get('login') === '1' && !currentUser) || document.querySelector('#preview-dialog[open] [data-auth-loading]')) open();
  channel?.addEventListener('message', async () => {
    await refreshSession();
    if (document.querySelector('#preview-dialog')?.open && document.querySelector('#dialog-content #auth-form, #dialog-content .auth-profile')) open();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) refreshSession(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshSession(); });
}

