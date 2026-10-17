import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../dist/business-api.mjs';
test('业务接口失败明确提示，超时可恢复，不把错误响应当成功', async t=>{
  const saved=globalThis.fetch;
  try {
    await t.test('请求带超时与同源会话，保留正常响应',async()=>{
      globalThis.fetch=async(route,options)=>{assert.ok(options.signal instanceof AbortSignal);assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');return {ok:true,json:async()=>({orders:[]})};};
      assert.deepEqual(await api('/api/orders'),{orders:[]});
    });
    await t.test('网络与超时错误转换为可重试提示',async()=>{
      for(const [error,message] of [[new TypeError('Failed to fetch'),/无法连接/],[new DOMException('timeout','TimeoutError'),/超时/]]){globalThis.fetch=async()=>{throw error;};await assert.rejects(api('/api/orders'),message);}
    });
    await t.test('HTML、空值和错误状态不能作为业务成功响应',async()=>{
      for(const json of [async()=>{throw new SyntaxError('HTML');},async()=>null]){globalThis.fetch=async()=>({ok:true,json});await assert.rejects(api('/api/orders'),/响应异常/);}
      globalThis.fetch=async()=>({ok:false,status:409,json:async()=>({message:'订单已变化'})});
      await assert.rejects(api('/api/orders'),e=>e.status===409&&e.message==='订单已变化');
      globalThis.fetch=async()=>({ok:true,json:async()=>({orders:[{id:'restored'}]})});assert.equal((await api('/api/orders')).orders[0].id,'restored');
    });
    await t.test('限流提示保留等待时间，代理HTML也不能掩盖429，不自动重发',async()=>{
      let calls=0;
      globalThis.fetch=async()=>{calls++;return new Response('<html>rate limited</html>',{status:429,headers:{'Retry-After':'60','Content-Type':'text/html'}});};
      await assert.rejects(api('/api/orders',{requestId:'same-id'}),e=>e.status===429&&e.retryAfter===60&&/约60秒/.test(e.message));
      assert.equal(calls,1);
      for(const value of ['','-1','0','999999999','<script>','Wed, 01 Jan 2020 00:00:00 GMT']){
        globalThis.fetch=async()=>new Response('{}',{status:429,headers:{'Retry-After':value}});
        await assert.rejects(api('/api/orders'),e=>e.status===429&&e.retryAfter===null&&e.message==='请求过于频繁，请稍后重试。');
      }
      globalThis.fetch=async()=>new Response('{"orders":[]}',{status:200,headers:{'Content-Type':'application/json'}});
      assert.deepEqual(await api('/api/orders'),{orders:[]});
    });
  } finally {globalThis.fetch=saved;}
});
