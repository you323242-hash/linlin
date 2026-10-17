import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
test('双人功能真实HTTP：认证、CSRF、价格、队友权限与三方起算',async t=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(path.join(parent,'delta-dual-http-'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{...process.env,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const req=async(p,u,body,origin=base)=>{const r=await fetch(base+p,{method:body?'POST':'GET',headers:{...(u?{cookie:u.cookie}:{}),...(body?{origin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify({requestId:randomUUID(),...body})}:{})});return{status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};};
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('测试服务启动超时')),20000);child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',c=>{clearTimeout(timer);reject(Error('测试服务退出 '+c));});});
    const users=[];for(let i=0;i<4;i++){const r=await req('/api/auth/sign-up/email',null,{name:'HTTP测试'+i,email:`dual-http${i}@example.test`,password:'Dual-http-only-local!',termsAccepted:true});assert.equal(r.status,200);users.push({cookie:r.cookie,id:r.data.user.id});}
    await t.test('小队接口拒绝匿名、跨站、非法操作，资料与加入均需本人明确同意',async()=>{
      assert.equal((await req('/api/squads')).status,401);assert.equal((await req('/api/squads',users[1],{action:'create',consent:true},'https://evil.test')).status,403);assert.equal((await req('/api/squads',users[1],{action:'admin'})).status,400);
      for(const u of users.slice(1,3)){const r=await req('/api/provider',u,{adult:true,gameId:'LOCAL-'+u.id,introduction:'HTTP测试资料，非真实玩家',modes:['secret'],stats:{secret:{kd:1.1,gear:4}},available:true});assert.equal(r.status,200);}
      assert.equal((await req('/api/squads',users[1],{action:'create'})).status,400);
      const r=await req('/api/squads',users[1],{action:'create',consent:true});assert.equal(r.status,200);assert.equal((await req('/api/squads',users[2],{action:'join',code:r.data.squad.joinCode,consent:true})).status,200);
      assert.equal((await req('/api/squads',users[3])).data.squad,null);
    });
    let order;
    const act=async(i,action,body={})=>{const r=await req('/api/orders/'+order.id,users[i]);assert.equal(r.status,200);return req('/api/orders/'+order.id+'/actions/'+action,users[i],{version:r.data.order.version,...body});};
    await t.test('总价后端计算，双人支付不能被第三人触发，两名成员均有订单权限',async()=>{
      const r=await req('/api/orders',users[0],{mode:'secret',providerCount:2,price:1,rulesAccepted:true});assert.equal(r.status,200);order=r.data.order;assert.equal(order.price,2176);
      assert.equal((await req('/api/orders/'+order.id+'/actions/pay',users[3],{version:0})).status,404);
      assert.equal((await act(0,'pay')).status,200);await req('/api/provider/presence',users[1],{});await req('/api/provider/presence',users[2],{});
      const queue=(await req('/api/queue',users[2])).data.orders;const q=queue.find(o=>o.id===order.id);assert.ok(q);assert.equal(q.providerCount,2);assert.ok(!q.buyerId);
      const accepted=await req('/api/orders/'+order.id+'/actions/accept',users[2],{version:q.version,offerId:q.offer?.id});assert.equal(accepted.status,200);assert.equal(accepted.data.order.providers.length,2);
      for(const i of [1,2])assert.ok((await req('/api/orders?role=provider',users[i])).data.orders.some(o=>o.id===order.id));
      assert.equal((await req('/api/orders/'+order.id,users[3])).status,404);
    });
    await t.test('三人各自起算，不能代确认、重确认或让陌生人推进',async()=>{
      assert.equal((await act(1,'start')).status,200);let r=await act(0,'start');assert.equal(r.status,200);assert.equal(r.data.order.status,'ready');assert.equal(r.data.order.runningSince,null);
      assert.equal((await act(1,'start',{userId:users[2].id})).status,409);
      assert.equal((await req('/api/orders/'+order.id+'/actions/start',users[3],{version:r.data.order.version})).status,404);
      r=await act(2,'start');assert.equal(r.status,200);assert.equal(r.data.order.status,'active');
      assert.equal((await req('/api/squads',users[2],{action:'leave'})).status,409);
    });
  }finally{if(child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});const target=realpathSync(dir);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-dual-http-'));rmSync(target,{recursive:true});}
});
