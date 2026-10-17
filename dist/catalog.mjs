// Prices are integer cents. Live reads use the API; existing orders keep server-side snapshots.
export const PRODUCTS = Object.freeze([
  Object.freeze({ id: 'secret', title: '机密行动', shortTitle: '机密', price: 1088, minutes: 60, gear: 4, status: 'available', image: './assets/original/amber-outpost.webp', ruleVersion: '2026-10-01-preview' }),
  Object.freeze({ id: 'topsecret', title: '绝密行动', shortTitle: '绝密', price: 2088, minutes: 60, gear: 5, status: 'available', image: './assets/original/copper-outpost.webp', ruleVersion: '2026-10-01-preview' }),
]);
export const priceText = cents => (cents / 100).toFixed(2);
// Historical price/rule snapshots stay immutable; retired artwork is never served again.
export const productArt = id => `./assets/original/${id === 'topsecret' ? 'copper-outpost' : id === 'secret' ? 'amber-outpost' : 'coastal-outpost'}.webp`;
let currentCatalog = PRODUCTS;
let paidEnabled = false;
export const paidOrdersAvailable = () => paidEnabled;
export async function refreshProducts() {
  // Do not offer default or stale prices when the authoritative catalog fails.
  currentCatalog = [];
  paidEnabled = false;
  const response = await fetch('/api/products', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('服务列表暂时不可用。');
  const data = await response.json();
  if (!Array.isArray(data?.products)) throw new Error('服务列表响应异常，请稍后重试。');
  if (data.paidOrdersEnabled !== undefined && typeof data.paidOrdersEnabled !== 'boolean') throw new Error('服务开放状态响应异常，请稍后重试。');
  paidEnabled = data.paidOrdersEnabled !== false;
  currentCatalog = paidEnabled ? data.products : [];
  return currentCatalog;
}
export const availableProducts = (catalog = currentCatalog) => catalog.filter(product => product.status === 'available');
export const getProduct = (id, catalog = currentCatalog) => availableProducts(catalog).find(product => product.id === id) ?? null;
export const serviceHref = id => `./service.html?mode=${encodeURIComponent(id)}`;

export const PROVIDER_STATES = Object.freeze({
  idle: { label: '尚未开启接单', title: '准备好，再开始接单', description: '自主安排时间，选择可服务的模式后即可开启接单。', action: '开启接单预览' },
  available: { label: '等待接单', title: '已开启接单预览', description: '真实服务开放后，系统将根据模式与空闲状态为你匹配订单。', action: '停止接单' },
  serving: { label: '服务中', title: '专注当前这一单', description: '双方确认后开始计时，服务时长结束后完成已开始的当前对局。', action: '查看示例订单' },
  suspended: { label: '接单已暂停', title: '你的接单功能暂时受限', description: '示例原因：多次服务投诉经核实成立。你仍可消费、查询订单并申请复核。', action: '查看申诉说明' },
});

// ponytail: UI state only; backend permissions and dispatch replace this before real service.
export function toggleAvailability(state, selectedModes) {
  if (!['idle', 'available'].includes(state)) return { state, error: '当前状态无法开启接单。' };
  if (state === 'available') return { state: 'idle', error: '' };
  if (!selectedModes.some(id => getProduct(id))) return { state, error: '请至少选择一种可服务的模式。' };
  return { state: 'available', error: '' };
}

