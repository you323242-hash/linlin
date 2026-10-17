import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createAuth} from '../server/auth.mjs';
import {createMarket} from '../server/market.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {localConfig} from '../server/config.mjs';
import {integrationCapabilities} from '../server/integrations.mjs';
import {refreshProducts,availableProducts,paidOrdersAvailable} from '../dist/catalog.mjs';

test('免费优先配置显式关闭，默认兼容；拼写错误拒绝启动',()=>{
  assert.equal(localConfig({}).paidOrdersEnabled,true);
  assert.equal(localConfig({PAID_ORDERS_MODE:'disabled'}).paidOrdersEnabled,false);
  assert.equal(integrationCapabilities({PAID_ORDERS_MODE:'disabled'}).paidOrdersEnabled,false);
  for(const value of ['', 'false','disable','live'])assert.throws(()=>localConfig({PAID_ORDERS_MODE:value}),/PAID_ORDERS_MODE/);
  assert.throws(()=>localConfig({APP_ENV:'production',NODE_ENV:'production',PAID_ORDERS_MODE:'disabled'}),/production/);
});

test('免费优先目录及失败不会恢复默认付费商品',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>({ok:true,json:async()=>({products:[{id:'secret',status:'available'}],paidOrdersEnabled:false})});
    await refreshProducts();assert.equal(paidOrdersAvailable(),false);assert.deepEqual(availableProducts(),[]);
    globalThis.fetch=async()=>({ok:true,json:async()=>({products:[],paidOrdersEnabled:'false'})});
    await assert.rejects(refreshProducts(),/响应异常/);assert.equal(paidOrdersAvailable(),false);
  }finally{globalThis.fetch=original;}
});

test('免费优先直接API拒绝新单与新付款，保留历史退款、隔离权限、任务排空及重启',async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'delta-free-only-'));
  let db,providers,child,logs='';let clock=Date.now();
  const call=(market,user,scope,fields={})=>market.command(user,scope,{requestId:randomUUID(),...fields});
  try{
    const setup=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:directory});db=setup.database;
    const users=[];for(let i=0;i<3;i++)users.push((await setup.auth.api.signUpEmail({body:{name:'隔离免费测试'+i,email:'free'+i+'@example.test',password:'Synthetic-free-test-password!',termsAccepted:true}})).user);
    providers=createLocalProviders({directory,environment:'test'});
    let market=createMarket(db,providers,{now:()=>clock});
    const requestId=randomUUID();const draft=(await call(market,users[0],'create',{requestId,mode:'secret',rulesAccepted:true})).order;
    let paid=(await call(market,users[0],'create',{mode:'secret',rulesAccepted:true,providerCount:2})).order;
    paid=(await call(market,users[0],{type:'order',id:paid.id,action:'pay'},{version:paid.version})).order;
    assert.equal(paid.price,2176);assert.equal(paid.payment.status,'paid');
    const queued=(await call(market,users[0],'create',{mode:'secret',rulesAccepted:true})).order;
    const failing={...providers,payment:{...providers.payment,createPayment:async()=>{throw Error('synthetic temporary failure');}}};
    const failedMarket=createMarket(db,failing,{now:()=>clock});
    const processing=(await call(failedMarket,users[0],{type:'order',id:queued.id,action:'pay'},{version:queued.version})).order;
    assert.equal(processing.payment.status,'processing');
    market=createMarket(db,providers,{now:()=>clock,paidOrdersEnabled:false});
    const counts=()=>['orders','payment_jobs','business_requests'].map(table=>db.prepare('SELECT count(*) n FROM '+table).get().n);
    const before=counts();
    for(const scope of ['create',draft.id+':pay',{type:'order',id:draft.id,action:'pay'}])await assert.rejects(call(market,users[0],scope,{mode:'secret',rulesAccepted:true,version:0}),e=>e.status===403);
    await assert.rejects(call(market,users[0],'create',{requestId,mode:'secret',rulesAccepted:true}),e=>e.status===403);
    assert.deepEqual(counts(),before);
    assert.equal(market.readOrder(draft.id,users[0]).newPaymentAllowed,false);
    assert.ok(market.list(users[0]).every(o=>o.newPaymentAllowed===false));
    assert.throws(()=>market.readOrder(paid.id,users[2]),e=>e.status===404);
    const cancelled=(await call(market,users[0],{type:'order',id:paid.id,action:'cancel'},{version:paid.version})).order;
    assert.equal(cancelled.payment.refunded,2176);assert.equal(cancelled.payment.status,'refunded');
    await call(market,users[0],draft.id+':cancel',{version:draft.version});
    clock+=120000;await market.drainPayments();assert.equal(market.readOrder(queued.id,users[0]).payment.status,'paid');
    const snapshot=JSON.parse(db.prepare('SELECT payload FROM orders WHERE id=?').get(queued.id).payload);
    assert.equal(snapshot.newPaymentAllowed,undefined);assert.equal(snapshot.snapshot.price,1088);
    await market.waitForIdle();providers.close();providers=null;db.close();db=null;
    const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    const base='http://127.0.0.1:'+port;
    async function start(){
      child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{...process.env,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:directory,PAID_ORDERS_MODE:'disabled'},stdio:['ignore','pipe','pipe']});
      child.stderr.on('data',b=>logs+=b);
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),15000);child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('startup failed '+logs));});});
    }
    const req=async(route,cookie='',body)=>{const response=await fetch(base+route,{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(body?{Origin:base,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};};
    await start();
    assert.deepEqual((await req('/api/products')).data,{products:[],paidOrdersEnabled:false});
    assert.equal((await req('/api/integrations')).data.paidOrdersEnabled,false);
    assert.equal((await req('/api/teams')).status,200);
    assert.equal((await req('/api/orders')).status,401);
    const login=await req('/api/auth/sign-in/email','',{email:'free0@example.test',password:'Synthetic-free-test-password!'});assert.equal(login.status,200);
    const cookie=login.cookie;
    assert.equal((await req('/api/orders',cookie,{requestId:randomUUID(),mode:'secret',rulesAccepted:true,paidOrdersEnabled:true})).status,403);
    assert.equal((await req('/api/orders/'+queued.id+'/actions/pay',cookie,{requestId:randomUUID(),version:0})).status,403);
    assert.equal((await req('/api/orders/'+paid.id,cookie)).data.order.payment.refunded,2176);
    assert.equal((await req('/api/admin',cookie)).status,403);
    const other=await req('/api/auth/sign-in/email','',{email:'free1@example.test',password:'Synthetic-free-test-password!'});
    assert.equal((await req('/api/orders/'+paid.id,other.cookie)).status,404);
    assert.equal((await req('/api/payment-callbacks/wechat','',{verified:true})).status,503);
    await new Promise(resolve=>{child.once('exit',resolve);child.kill();});await start();
    assert.equal((await req('/api/me',cookie)).status,200);
    assert.deepEqual((await req('/api/products')).data,{products:[],paidOrdersEnabled:false});
    assert.equal((await req('/api/orders/'+paid.id,cookie)).data.order.payment.refunded,2176);
    await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
    const restored=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:directory});db=restored.database;providers=createLocalProviders({directory,environment:'test'});market=createMarket(db,providers,{paidOrdersEnabled:false});
    assert.equal(market.readOrder(paid.id,users[0]).payment.refunded,2176);
    await assert.rejects(call(market,users[0],'create',{mode:'secret',rulesAccepted:true}),e=>e.status===403);
  }finally{if(child?.exitCode===null)child.kill();providers?.close();db?.close();rmSync(directory,{recursive:true,force:true});}
});