import { api, escapeHtml as esc, showError } from './business-api.mjs';
import { mountPrivacyCopy } from './privacy-copy-ui.mjs';

const root = document.querySelector('#account-security');
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
let generation = 0;
function wire(container, action, fields, after = render) {
  const form = container.querySelector('form');
  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('button[type="submit"]'); if (button.disabled) return;
    button.disabled = true; const status = form.querySelector('[role="status"]'); status.textContent = '正在处理…';
    try { const result = await api('/api/security/' + action, fields(form)); form.reset(); await after(result); }
    catch (error) { status.textContent = error.message; if (error.status === 401) { root.replaceChildren(); showError(error); } }
    finally { form.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]').forEach(input => input.value = ''); button.disabled = false; }
  };
}
const passwordField = '<label>当前密码<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>';
const submit = text => `<p role="status" aria-live="polite"></p><button type="submit" class="workspace-button">${text}</button>`;

function showSetup(result) {
  let secret;
  try { secret = new URL(result.totpURI).searchParams.get('secret'); } catch { secret = null; }
  if (!secret || !Array.isArray(result.backupCodes)) throw new Error('验证设置暂不可读，请重新设置。');
  const container = root.querySelector('#security-factor');
  container.innerHTML = `<h3>完成二次验证设置</h3><p>在验证码应用中添加账户，选择基于时间的验证码，手动输入下方密钥。平台不会将密钥发给第三方二维码服务。</p><label>设置密钥<textarea readonly aria-label="二次验证设置密钥" spellcheck="false">${esc(secret)}</textarea></label><p>恢复码只在本次展示，请保存到安全位置，每条仅可使用一次。不要发到聊天或客服。</p><textarea readonly aria-label="单次恢复码" spellcheck="false">${esc(result.backupCodes.join('\n'))}</textarea><form class="order-form"><label><input name="saved" type="checkbox" required>我已安全保存恢复码</label><label>应用验证码<input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>${submit('验证并启用')}</form><button type="button" class="text-link" data-close-setup>取消设置</button>`;
  wire(container, 'verify', form => ({ code: form.elements.code.value, method: 'totp' }));
  container.querySelector('[data-close-setup]').onclick = render;
}
async function render() {
  const version = ++generation;
  try {
    const data = await api('/api/security'); if (version !== generation) return;
    root.innerHTML = `<div class="panel-heading"><h2>账户安全</h2><button class="text-link" type="button" data-security-refresh>刷新</button></div><p>查看登录会话，保护账户。退出或撤销后，原会话无法继续访问私有内容。</p>
      <details><summary>登录会话 · ${data.sessions.length}条</summary><ul class="service-timeline">${data.sessions.map(s => `<li><strong>${s.current ? '当前会话' : s.device}</strong><small>登录：${esc(date(s.createdAt))} · 到期：${esc(date(s.expiresAt))}</small>${s.current ? '' : `<button type="button" class="text-link" data-revoke="${esc(s.id)}">撤销此会话</button>`}</li>`).join('')}</ul><button type="button" class="workspace-button" data-revoke-others>退出其他会话</button><p role="status" id="security-session-message"></p></details>
      <details id="security-factor"><summary>二次验证 · ${data.twoFactorEnabled ? '已启用' : '未启用'}</summary><p>${data.admin ? data.adminVerificationRequired ? '管理员进入处理台前必须启用并验证；验证有效期15分钟。' : '当前为本地开发环境；外部内测管理员必须二次验证。' : '可选设置。启用后，密码登录还需要验证码或单次恢复码。'}</p>${data.verifiedUntil ? `<p>本次验证有效至 ${esc(date(data.verifiedUntil))}</p>` : ''}${data.twoFactorEnabled ? `<div data-factor-verify><form class="order-form"><label>验证码<input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>${submit('完成二次验证')}</form></div>${data.admin ? '<a class="text-link" href="./admin.html">进入平台处理台 →</a>' : `<details data-factor-disable><summary>关闭二次验证</summary><p>须先完成上面的二次验证。关闭后其他会话将退出。</p><form class="order-form">${passwordField}${submit('关闭二次验证')}</form></details>`}<details data-backup-codes><summary>重新生成恢复码</summary><p>须先完成二次验证。生成后旧恢复码失效。</p><form class="order-form">${passwordField}${submit('重新生成恢复码')}</form></details>` : `<form class="order-form">${passwordField}${submit('开始设置')}</form>`}</details>
      <details data-password-change><summary>修改密码</summary><p>新密码为12–128个字符。修改后其他设备退出；启用二次验证时需先完成验证。</p><form class="order-form"><label>当前密码<input type="password" name="currentPassword" autocomplete="current-password" maxlength="128" required></label><label>新密码<input type="password" name="newPassword" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>确认新密码<input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="128" required></label>${submit('修改密码')}</form></details><p class="dialog-note">${data.emailRecoveryEligible === true ? '<a href="./recovery.html">邮箱验证 / 找回密码</a> · 当前为私有测试邮件，不通过聊天收集密码或验证密钥。' : '手机号密码找回暂未开放，模拟验证码不能重置已有密码。请勿向客服提供密码或验证码。'}</p>`;
    mountPrivacyCopy(root,()=>version===generation);
    root.querySelector('[data-security-refresh]').onclick = render;
    const msg = root.querySelector('#security-session-message');
    root.querySelectorAll('[data-revoke],[data-revoke-others]').forEach(button => button.onclick = async () => {
      if (button.disabled) return; button.disabled = true;
      try { await api('/api/security/' + (button.hasAttribute('data-revoke-others') ? 'revoke-others' : 'revoke'), { id: button.dataset.revoke }); await render(); }
      catch (error) { msg.textContent = error.message; showError(error); button.disabled = false; }
    });
    wire(root.querySelector('[data-password-change]'), 'password', form => {
      if (form.elements.newPassword.value !== form.elements.confirm.value) throw new Error('两次新密码不一致。');
      return { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value };
    }, async () => { await render(); root.insertAdjacentHTML('afterbegin', '<p role="status">密码已修改，其他会话已退出。</p>'); });
    if (data.twoFactorEnabled) {
      wire(root.querySelector('[data-factor-verify]'), 'verify', form => ({ code: form.elements.code.value, method: 'totp' }));
      const disable = root.querySelector('[data-factor-disable]'); if (disable) wire(disable, 'disable', form => ({ password: form.elements.password.value }));
      wire(root.querySelector('[data-backup-codes]'), 'backup-codes', form => ({ password: form.elements.password.value }), result => {
        const container = root.querySelector('[data-backup-codes]');
        container.innerHTML = `<summary>保存新恢复码</summary><p>旧码已失效。每条新码仅可使用一次，请安全保存。</p><textarea readonly aria-label="新单次恢复码">${esc(result.backupCodes.join('\n'))}</textarea><button type="button" class="workspace-button">已保存，关闭展示</button>`;
        container.querySelector('button').onclick = render;
      });
    } else wire(root.querySelector('#security-factor'), 'enroll', form => ({ password: form.elements.password.value }), showSetup);
    if (new URL(location.href).searchParams.get('security') === '1') root.querySelector('#security-factor').open = true;
  } catch (error) {
    if (version !== generation) return;
    root.replaceChildren(); const text = document.createElement('p'); text.textContent = error.message; root.append(text);
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'workspace-button'; retry.textContent = '重试'; retry.onclick = render; root.append(retry); showError(error);
  }
}
if (root) {
  render();
  // Clear ephemeral enrollment secrets and re-check permissions whenever a cached page returns.
  window.addEventListener('pageshow', event => { if (event.persisted) render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { generation++; root.replaceChildren(); } else render(); });
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('delta-session') : null;
  channel?.addEventListener('message', render);
}

