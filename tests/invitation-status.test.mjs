import test from 'node:test';
import assert from 'node:assert/strict';
import { api, responseStatus, showError } from '../dist/business-api.mjs';

test('入口代理的业务未登录响应仍引导网站登录，普通403不被误判', async () => {
  const mapped = new Response(JSON.stringify({message:'请先登录。'}), {status:403,headers:{'X-Delta-Application-Status':'401'}});
  assert.equal(responseStatus(mapped),401);
  assert.equal(responseStatus(new Response('',{status:403})),403);
  assert.equal(responseStatus(new Response('',{status:401})),401);
  assert.equal(responseStatus(new Response('',{status:200,headers:{'X-Delta-Application-Status':'401'}})),200);
  const originalFetch=globalThis.fetch;
  const originalLocation=globalThis.location;
  try {
    globalThis.fetch=async()=>mapped.clone();
    let target;
    globalThis.location={pathname:'/orders.html',search:'',replace:value=>target=value};
    await assert.rejects(api('/api/me'),error=>{
      assert.equal(error.status,401);
      showError(error);
      assert.equal(target,'/?login=1&returnTo=%2Forders.html');
      return true;
    });
    target=undefined;
    globalThis.fetch=async()=>new Response(JSON.stringify({message:'无权访问。'}),{status:403});
    await assert.rejects(api('/api/admin'),error=>{
      assert.equal(error.status,403);showError(error);assert.equal(target,undefined);return true;
    });
  } finally {
    globalThis.fetch=originalFetch;
    if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;
  }
});
