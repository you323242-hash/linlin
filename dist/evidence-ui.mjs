import { api, responseStatus, escapeHtml as esc, showError } from './business-api.mjs';

const sizeText = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB';
export function mountEvidence(root, { orderId, caseId, canUpload = false, ownHistory = false, onUploaded = () => {} }) {
  root.classList.add('evidence-panel');
  root.innerHTML = `<h3>附件材料</h3><p class="evidence-note">${ownHistory ? "历史交接记录仅展示本人上传的材料。" : "截图与录音只用于本单售后，订单双方及管理员可查看。请遮盖无关个人信息。"}</p><button type="button" class="text-link" data-refresh-files>刷新附件</button><div data-file-list>正在读取附件…</div>${canUpload ? '<form class="order-form evidence-upload"><label>选择截图或录音<input name="file" type="file" accept=".png,.jpg,.jpeg,.webp,.mp3,.wav" required></label><label>附件说明<input name="summary" type="text" maxlength="300" placeholder="例如：第1局结束后，语音中断的时间与经过"></label><p class="evidence-note">单个不超过5MB；每方最多5个、共10MB。本次售后合计最多10个、20MB。支持PNG、JPG、WEBP、MP3、WAV。</p><button class="order-button workspace-button" type="submit">上传附件</button></form>' : ''}<p class="evidence-feedback" role="status"></p>`;
  const route = `/api/orders/${orderId}/cases/${caseId}/attachments`, list = root.querySelector('[data-file-list]'), feedback = root.querySelector('.evidence-feedback');
  async function refresh() {
    try {
      const { files } = await api(route);
      list.innerHTML = files.length ? files.map(f => `<article class="evidence-file"><strong>${esc(f.name)}</strong><small>${sizeText(f.bytes)} · ${esc(f.uploader)} · ${esc(new Date(f.createdAt).toLocaleString('zh-CN'))}</small><p>${esc(f.summary || '未填写补充说明')}</p><div class="evidence-file-actions"><button type="button" class="text-link" data-file-preview="${f.id}" data-kind="${f.mime.startsWith('image/') ? 'image' : 'audio'}">${f.mime.startsWith('image/') ? '预览图片' : '播放录音'}</button><a class="text-link" href="${f.url}" download>下载查看</a></div><div data-preview-slot="${f.id}"></div></article>`).join('') : '<p class="evidence-note">暂无附件。已提交的文字说明仍保存在售后记录中。</p>';
    } catch (error) { showError(error, feedback); list.textContent = '附件暂时无法读取。'; }
  }
  root.addEventListener('click', event => {
    if (event.target.closest('[data-refresh-files]')) { refresh(); return; }
    const button = event.target.closest('[data-file-preview]'); if (!button) return;
    const slot = root.querySelector(`[data-preview-slot="${button.dataset.filePreview}"]`);
    if (slot.childElementCount) { slot.replaceChildren(); button.textContent = button.dataset.kind === 'image' ? '预览图片' : '播放录音'; return; }
    const media = document.createElement(button.dataset.kind === 'image' ? 'img' : 'audio');
    media.src = '/api/attachments/' + button.dataset.filePreview;
    if (media.tagName === 'IMG') media.alt = '本单售后截图'; else { media.controls = true; media.preload = 'metadata'; }
    media.onerror = () => { feedback.textContent = '附件无法打开，可能已退出登录、权限变化或文件损坏。请刷新后重试。'; };
    slot.append(media); button.textContent = '收起附件';
  });
  const form = root.querySelector('form');
  if (form) {
    let requestId = crypto.randomUUID();
    form.addEventListener('input', () => { requestId = crypto.randomUUID(); });
    form.onsubmit = async event => {
      event.preventDefault(); const file = form.elements.file.files[0], button = form.querySelector('button');
      if (!file || !file.size || file.size > 5 * 1024 * 1024) { feedback.textContent = '请选择非空文件，每个不超过5MB。'; return; }
      button.disabled = true; feedback.textContent = '正在上传，请稍候…';
      try {
        const response = await fetch(route, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Summary': encodeURIComponent(form.elements.summary.value), 'X-Upload-Id': requestId }, body: file });
        const data = await response.json();
        if (!response.ok) { const error = new Error(data.message || '上传未成功。'); error.status = responseStatus(response); throw error; }
        onUploaded(data.file.orderVersion); form.reset(); requestId = crypto.randomUUID(); await refresh(); feedback.textContent = '附件已保存。上传本身不代表责任认定。';
      } catch (error) { showError(error, feedback); }
      finally { button.disabled = false; }
    };
  }
  refresh();
}

