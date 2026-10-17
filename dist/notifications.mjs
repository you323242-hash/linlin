import { api, escapeHtml as esc, showError } from './business-api.mjs';

function renderUnread(unread) {
  document.querySelectorAll('[data-panel="messages"]').forEach(button => {
    let count = button.querySelector('[data-inbox-count]');
    if (!count) { count = document.createElement('span'); count.dataset.inboxCount = ''; count.className = 'inbox-count'; button.append(count); }
    count.textContent = String(unread); count.hidden = unread === 0; count.setAttribute('aria-label', `${unread}条未读`);
  });
  const summary = document.querySelector('[data-message-summary]');
  if (summary) summary.textContent = unread ? `有 ${unread} 条未读消息，可查看订单进度与售后通知。服务问题请从对应订单发起售后。` : '暂无未读消息。历史通知可在消息中心查看，服务问题请从对应订单发起售后。';
}
export async function refreshUnread() {
  try { renderUnread((await api('/api/notifications?summary=1')).unread); }
  catch { const summary = document.querySelector('[data-message-summary]'); if (summary) summary.textContent = '消息数量暂时无法读取，可打开消息中心重试。'; }
}

export async function mountInbox(root) {
  root.innerHTML = '<p class="dialog-note">站内记录保存在本机。未发送短信、微信或外部推送；历史邀请可能已失效，以订单当前状态为准。</p><button class="text-link" data-refresh-inbox>刷新消息</button><div data-inbox-list role="status">正在读取…</div>';
  const list = root.querySelector('[data-inbox-list]');
  async function refresh() {
    try {
      const data = await api('/api/notifications');
      if (!root.contains(list)) return;
      renderUnread(data.unread);
      list.innerHTML = `<p>未读 ${data.unread} 条 · 展示最近200条</p>` + (data.notifications.map(n => `<section class="evidence-file"><strong>${esc(n.label)}</strong><small>${esc(new Date(n.createdAt).toLocaleString('zh-CN'))} · ${n.readAt ? '已读' : '未读'}</small><a class="text-link" href="./orders.html?order=${encodeURIComponent(n.orderId)}&role=${n.role}">进入对应订单</a>${n.readAt ? '' : `<button class="text-link" data-read-notification="${esc(n.id)}">标为已读</button>`}</section>`).join('') || '<p>暂无站内消息。</p>');
    } catch (error) { showError(error, list); }
  }
  root.onclick = async event => {
    if (event.target.closest('[data-refresh-inbox]')) return refresh();
    const button = event.target.closest('[data-read-notification]'); if (!button) return;
    button.disabled = true;
    try { await api('/api/notifications', { id: button.dataset.readNotification }); await refresh(); }
    catch (error) { showError(error, list); }
  };
  await refresh();
}

