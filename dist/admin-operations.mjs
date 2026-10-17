import { escapeHtml as esc } from './business-api.mjs';

const names = { payments: '模拟资金任务', dispatch: '订单匹配', maintenance: '订单维护', notifications: '通知任务', 'storage-health': '存储检查' };
const codes = { TIMEOUT: '通道响应超时', INVALID_RECEIPT: '回执核验失败', IDEMPOTENCY_CONFLICT: '请求编号冲突', LOOKUP_UNAVAILABLE: '结果查询不可用', LOW_DISK: '可用磁盘空间不足', LOG_WRITE_FAILED: '运行日志写入失败', WORKER_STALE: '自动任务心跳超时', ORDER_WAITING: '等待订单参与者处理', OPERATION_FAILED: '执行失败，等待核查' };
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
export function operationsHtml(data) {
  if (!data) return '';
  const jobs = [...data.payment.map(j => ({ ...j, kind: 'payment' })), ...data.notification.map(j => ({ ...j, kind: 'notification' }))];
  return `<section class="workspace-panel"><h2>自动运行状态</h2><p>待处理模拟资金任务 ${data.counts.payments} 项 · 通知任务 ${data.counts.notifications} 项 · 当前提醒 ${data.alertCount} 项</p><p class="evidence-note">站内消息已保存。外部通知仅作本地模拟记录，未发送短信或微信；任务重试不改变订单处理方案。</p><details><summary>查看工作任务与运行提醒</summary><ol class="service-timeline">${data.tasks.map(t => `<li>${esc(names[t.id] || t.id)} · ${esc(({idle:'等待运行',running:'运行中',retry:'等待重试'})[t.state] || t.state)}<small>最近完成：${esc(time(t.finished_at))} · 连续失败 ${t.failures} 次</small></li>`).join('')}</ol>${data.alerts.map(a => `<p>${esc(codes[a.code] || '需要检查的运行异常')}<small> · ${esc(a.target_id)} · ${esc(time(a.opened_at))}</small></p>`).join('') || '<p>暂无运行提醒。</p>'}</details>${jobs.filter(j => j.status === 'blocked').map(j => `<form class="order-form retry-form" data-kind="${j.kind}" data-id="${esc(j.id)}"><h3>${j.kind === 'payment' ? '模拟资金' : '通知'}任务已暂停</h3><p>${esc(j.id)} · ${esc(codes[j.last_error] || '执行失败')} · 累计尝试 ${j.attempts} 次</p><label>核查结果及恢复原因<textarea name="reason" minlength="10" maxlength="300" required></textarea></label><button class="workspace-button">按原请求编号恢复</button></form>`).join('')}</section>`;
}

