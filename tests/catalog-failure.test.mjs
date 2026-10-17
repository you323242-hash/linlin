import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshProducts, availableProducts, getProduct } from '../dist/catalog.mjs';

test('商品读取失败不显示默认或过期价格，恢复后重新可选', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [{ id: 'secret', price: 1234, status: 'available' }] }) });
    await refreshProducts();
    assert.equal(getProduct('secret').price, 1234);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(refreshProducts(), /offline/);
    assert.deepEqual(availableProducts(), []);
    assert.equal(getProduct('secret'), null);
    for (const data of [{}, { products: null }, { products: {} }]) {
      globalThis.fetch = async (_route, options) => { assert.ok(options.signal instanceof AbortSignal); return { ok: true, json: async () => data }; };
      await assert.rejects(refreshProducts(), /响应异常/);
      assert.deepEqual(availableProducts(), []);
    }
    globalThis.fetch = async () => ({ ok: false });
    await assert.rejects(refreshProducts());
    assert.deepEqual(availableProducts(), []);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [{ id: 'secret', price: 1234, status: 'available' }] }) });
    await refreshProducts();
    assert.equal(getProduct('secret').price, 1234);
  } finally { globalThis.fetch = originalFetch; }
});
