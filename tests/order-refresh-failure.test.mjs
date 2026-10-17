import test from 'node:test';
import assert from 'node:assert/strict';
import { startOrders } from '../dist/orders.mjs';
test('订单页面故障清除旧操作，恢复重载，迟到响应不能覆盖当前数据',async()=>{
  const saved=Object.fromEntries(['document','location','fetch','setInterval'].map(k=>[k,globalThis[k]]));
  const elements=new Map(),timers=[]; let onClick;
  const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:false,open:false,dataset:{},addEventListener(){},close(){this.open=false;}});return elements.get(id);};
  const order={id:'verified-order',status:'pending',snapshot:{title:'机密行动',gear:4,image:'./assets/secret.jpg'},price:1088,date:'2026/10/3',payment:{status:'pending'},rounds:[],duration:3600,elapsed:0,runningSince:null};
  let fetcher=async()=>({ok:true,json:async()=>({orders:[order],serverNow:Date.now()})});
  try {
    globalThis.document={visibilityState:'visible',querySelector:element,querySelectorAll:()=>[],addEventListener(event,callback){if(event==='click')onClick=callback;}};
    globalThis.location={href:'http://local.test/orders.html'};
    globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return timers.length;};
    order.buyerId='test-buyer';
    globalThis.fetch=(...args)=>args[0]==='/api/me'?Promise.resolve({ok:true,json:async()=>({user:{id:'test-buyer'}})}):fetcher(...args);
    await startOrders();
    const poll=timers.find(t=>t.ms===5000).callback;
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    assert.match(element('#quick-panel').innerHTML,/data-order-action="pay"/);
    fetcher=async()=>{throw new TypeError('offline');};poll();await settle();
    assert.equal(element('#order-summary').hidden,true);
    assert.equal(element('#record-count').textContent,'暂时无法读取');
    assert.doesNotMatch(element('#quick-panel').innerHTML,/data-order-action/);
    assert.match(element('#order-list').textContent,/无法连接/);
    onClick({target:{closest:selector=>selector==='[data-filter]'?{dataset:{filter:'all'}}:null}});
    assert.equal(element('#record-count').textContent,'暂时无法读取');
    assert.match(element('#order-list').textContent,/无法连接/);
    fetcher=async()=>({ok:true,json:async()=>({orders:[order],serverNow:Date.now()})});poll();await settle();
    assert.equal(element('#order-summary').hidden,false);
    assert.match(element('#quick-panel').innerHTML,/data-order-action="pay"/);
    let late;
    fetcher=()=>new Promise(resolve=>{late=resolve;});poll();
    fetcher=async()=>({ok:true,json:async()=>({orders:[],serverNow:Date.now()})});poll();await settle();
    late({ok:true,json:async()=>({orders:[order],serverNow:Date.now()})});await settle();
    assert.doesNotMatch(element('#quick-panel').innerHTML,/data-order-action/);
    assert.equal(element('#record-count').textContent,'0 笔订单');
  } finally {for(const [key,value] of Object.entries(saved))globalThis[key]=value;}
});
