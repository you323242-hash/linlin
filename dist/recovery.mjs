import {rateLimitError} from './business-api.mjs';

const root = document.querySelector('#recovery-content'), status = document.querySelector('#recovery-status');
const fragment = new URLSearchParams(location.hash.slice(1));
const resetToken = fragment.get('reset'), verifyToken = fragment.get('verify');
// Keep credentials out of browser history, referrers, screenshots and copied URLs.
history.replaceState(null, '', location.pathname);
async function request(route, body) {
  let response;
  try { response = await fetch(route, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); }
  catch (error) { throw Error(error.name === 'TimeoutError' ? '服务响应超时，无法确认请求结果。请稍后手动重试。' : '暂时无法连接服务，无法确认请求结果。请检查网络后手动重试。'); }
  if (response.status === 429) throw rateLimitError(response);
  if (!response.ok) throw Error(response.status === 503 ? '真实邮件服务尚未接入，此功能暂不可用。' : '链接无效、已过期或输入不正确，请重新申请。');
}
const password = '<label>新密码<input type="password" name="newPassword" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>确认密码<input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="128" required></label>';
if (resetToken) root.innerHTML = `<form class="registration-fields">${password}<button class="auth-submit">设置新密码</button></form>`;
else if (verifyToken) root.innerHTML = '<form class="registration-fields"><p>确认此验证链接来自你自己的测试邮件。</p><button class="auth-submit">确认验证邮箱</button></form>';
else root.innerHTML = '<form class="registration-fields"><label>邮箱<input type="email" name="email" autocomplete="username" maxlength="254" required></label><label>操作<select name="action"><option value="reset">找回密码</option><option value="verify">重新发送验证邮件</option></select></label><button class="auth-submit">发送邮件</button></form>';
root.querySelector('form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button');
  if (button.disabled) return;
  if (resetToken && form.elements.newPassword.value !== form.elements.confirm.value) { status.textContent = '两次密码不一致。'; return; }
  button.disabled = true; status.textContent = '正在处理…';
  try {
    if (resetToken) await request('/api/auth/reset-password', { token: resetToken, newPassword: form.elements.newPassword.value });
    else if (verifyToken) await request('/api/auth/verify-email?token=' + encodeURIComponent(verifyToken));
    else {
      const verify = form.elements.action.value === 'verify';
      await request('/api/auth/' + (verify ? 'send-verification-email' : 'request-password-reset'), { email: form.elements.email.value.trim().toLowerCase() });
    }
    form.reset(); status.textContent = resetToken ? '密码已更新，原登录会话已退出。请返回首页重新登录；二次验证仍需完成。' : verifyToken ? '邮箱已验证，请返回首页登录。' : '若邮箱符合条件，邮件已记录。开发者可在本机私有测试收件箱查看；请勿转发链接。';
    if (resetToken || verifyToken) form.hidden = true;
  } catch (error) { status.textContent = error.message || '暂时无法连接，请稍后重试。'; }
  finally { form.querySelectorAll('input[type="password"]').forEach(input => input.value = ''); button.disabled = false; }
};

