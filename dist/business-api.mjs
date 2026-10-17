export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// An invitation proxy transports application 401 as 403 to avoid re-opening
// the browser's Basic Auth dialog. Ordinary forbidden responses stay 403.
export const responseStatus = response => response.status === 403 && response.headers?.get('X-Delta-Application-Status') === '401' ? 401 : response.status;
export function rateLimitError(response) {
  const value = (response.headers?.get('Retry-After') ?? response.headers?.get('X-Retry-After'))?.trim();
  const seconds = value && /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 3600 ? Number(value) : null;
  const error = new Error(seconds ? `请求过于频繁，请等待约${seconds}秒后重试。` : '请求过于频繁，请稍后重试。');
  error.status = 429; error.retryAfter = seconds;
  return error;
}
export async function api(route, body) {
  let response;
  try { response = await fetch(route, { signal: AbortSignal.timeout(10_000), method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  } catch (error) { throw new Error(error.name === 'TimeoutError' ? '服务响应超时，请稍后重试。' : '暂时无法连接服务，请检查网络后重试。'); }
  if (response.status === 429) throw rateLimitError(response);
  let data;
  try { data = await response.json(); } catch { throw new Error('服务响应异常，请稍后重试。'); }
  if (!data || typeof data !== 'object') throw new Error('服务响应异常，请稍后重试。');
  if (!response.ok) { const error = new Error(data.message || '操作未成功，请稍后重试。'); error.status = responseStatus(response); throw error; }
  return data;
}
export const requestBody = fields => ({ ...fields, requestId: crypto.randomUUID() });
export const safeReturnPath = value => typeof value === 'string' && /^\/(?:account|orders|service|admin|teams)\.html(?:\?[^#]*)?$/.test(value) ? value : '/account.html';
export function showError(error, element) {
  if (element) element.textContent = error.message;
  if (error.status === 401) location.replace('/?login=1&returnTo=' + encodeURIComponent(safeReturnPath(location.pathname + location.search)));
}

