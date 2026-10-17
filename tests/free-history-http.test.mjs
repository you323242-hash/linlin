import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '../server/auth.mjs';
import {createMarket} from '../server/market.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';

test('免费优先真实HTTP：历史双人履约、三方售后、附件权限与重启恢复',async t=>{
  const parent=realpathSync(tmpdir()),directory=mkdtempSync(path.join(parent,'delta-free-history-'));
  let db,providers,market,child,logs='';const users=[],orders=[];
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base='http://127.0.0.1:'+port;
  async function start(){
    child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{...process.env,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:directory,PAID_ORDERS_MODE:'disabled'},stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stderr.on('data',b=>logs+=b.toString());
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时 '+logs)),15000);child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
    db=new DatabaseSync(path.join(directory,'auth.sqlite'));
  }
  async function stop(){db?.close();db=null;if(child?.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});}
  async function req(route,index,body,origin=base){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{...(index!==undefined?{Cookie:users[index].cookie}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify({requestId:randomUUID(),...body})}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};}
  async function action(order,index,name,body={}){const view=await req('/api/orders/'+order.id,index);assert.equal(view.status,200);const result=await req('/api/orders/'+order.id+'/actions/'+name,index,{version:view.data.order.version,...body});assert.equal(result.status,200,JSON.stringify(result.data));return result.data.order;}
  async function acceptAndStart(order){
    for(const i of [1,2])assert.equal((await req('/api/provider/presence',i,{})).status,200);
    const queued=(await req('/api/queue',2)).data.orders.find(o=>o.id===order.id);assert.ok(queued);
    const accepted=await req('/api/orders/'+order.id+'/actions/accept',2,{version:queued.version,offerId:queued.offer?.id});assert.equal(accepted.status,200);order=accepted.data.order;
    await action(order,1,'start');order=await action(order,0,'start');assert.equal(order.status,'ready');
    const stranger=await req('/api/orders/'+order.id+'/actions/start',3,{version:order.version});assert.equal(stranger.status,404);
    order=await action(order,2,'start');assert.equal(order.status,'active');return order;
  }
  try{
    // Seed historical paid orders before shutdown. The HTTP process is disabled throughout.
    const setup=await createAuth({baseURL:base,dataDirectory:directory});db=setup.database;
    for(let i=0;i<5;i++)users.push((await setup.auth.api.signUpEmail({body:{name:'历史隔离'+i,email:'history'+i+'@example.test',password:'Synthetic-history-only!',termsAccepted:true}})).user);
    db.prepare("UPDATE user SET role='admin' WHERE id=?").run(users[4].id);
    providers=createLocalProviders({directory,environment:'test'});market=createMarket(db,providers);
    const cmd=(u,scope,body={})=>market.command(u,scope,{requestId:randomUUID(),...body});
    for(const u of users.slice(1,3))await cmd(u,'profile',{adult:true,gameId:'LOCAL-'+u.id,introduction:'合成隔离资料，不是真实玩家',modes:['secret'],stats:{secret:{kd:1.2,gear:4}},available:true});
    const {squad}=await cmd(users[1],'squadCreate',{consent:true});await cmd(users[2],'squadJoin',{consent:true,code:squad.joinCode});
    for(let i=0;i<2;i++){let order=(await cmd(users[0],'create',{mode:'secret',providerCount:2,rulesAccepted:true})).order;order=(await cmd(users[0],order.id+':pay',{version:order.version})).order;assert.equal(order.payment.status,'paid');orders.push(order);}
    await market.waitForIdle();providers.close();providers=null;db.close();db=null;market=null;
    await start();
    for(let i=0;i<5;i++){const login=await req('/api/auth/sign-in/email',undefined,{email:'history'+i+'@example.test',password:'Synthetic-history-only!'});assert.equal(login.status,200);users[i].cookie=login.cookie;}
    assert.deepEqual((await req('/api/products')).data,{products:[],paidOrdersEnabled:false});
    assert.equal((await req('/api/orders',0,{mode:'secret',rulesAccepted:true})).status,403);
    await t.test('旧双人单可接单、三方开始、尾局核对、三方完成与评价，零退款',async()=>{
      let order=await acceptAndStart(orders[0]);await action(order,1,'beginRound');
      // Change elapsed time only in this temporary DB; no test-clock public endpoint exists.
      const payload=JSON.parse(db.prepare('SELECT payload FROM orders WHERE id=?').get(order.id).payload);payload.runningSince=Date.now()-3600001;
      db.prepare('UPDATE orders SET payload=?,version=version+1 WHERE id=?').run(JSON.stringify(payload),order.id);
      order=await action(order,1,'endRound',{result:'success'});assert.equal(order.status,'confirming');
      await action(order,0,'confirmRound',{index:0,agreed:true});order=await action(order,2,'confirmRound',{index:0,agreed:true});assert.equal(order.rounds[0].normal,true);
      await action(order,1,'finish');order=await action(order,0,'finish');assert.equal(order.status,'confirming');order=await action(order,2,'finish');assert.equal(order.status,'completed');
      order=await action(order,0,'review',{attitude:5,communication:5,experience:4,text:'合成历史履约评价'});assert.equal(order.review.experience,4);assert.equal(order.payment.refunded,0);orders[0]=order;
    });
    let file,route;const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrxkAAAAASUVORK5CYII=','base64');
    await t.test('旧单售后三方举证及附件幂等，陌生人/跨站拒绝，两名服务者可看',async()=>{
      let order=await acceptAndStart(orders[1]);order=await action(order,0,'request',{kind:'service',description:'合成服务质量争议，仅验证关闭付费后原售后路径'});assert.equal(order.case.stage,'human');
      route='/api/orders/'+order.id+'/cases/'+order.case.id+'/attachments';
      const headers={Cookie:users[0].cookie,Origin:base,'Content-Type':'image/png','X-File-Name':encodeURIComponent('合成证据.png'),'X-Upload-Id':randomUUID()};
      const upload=(extra={},body=bytes)=>fetch(base+route,{method:'POST',headers:{...headers,...extra},body});
      assert.equal((await upload({Origin:'https://evil.test'})).status,403);assert.equal((await upload({Cookie:users[3].cookie})).status,404);
      const uploaded=await upload();assert.equal(uploaded.status,200);file=(await uploaded.json()).file;assert.equal((await (await upload()).json()).file.id,file.id);
      assert.equal((await fetch(base+file.url)).status,401);assert.equal((await fetch(base+file.url,{headers:{Cookie:users[3].cookie}})).status,404);
      for(const i of [0,1,2,4]){const response=await fetch(base+file.url,{headers:{Cookie:users[i].cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);}
      for(const i of [1,2])await action(order,i,'supplement',{description:'合成服务者独立说明，验证本人材料权限'});
      assert.equal((await req(route,4)).data.files.length,1);orders[1]=(await req('/api/orders/'+order.id,0)).data.order;
    });
    await t.test('独立管理员方案、异议复核、三方明确接受后仅一次2176分退款',async()=>{
      let order=orders[1];order=await action(order,4,'proposeCase',{outcome:'refund',reason:'合成材料核实后建议整单全额模拟退款'});
      order=await action(order,2,'appealCase',{description:'合成异议说明，请再次核实后重新提出方案'});assert.equal(order.case.stage,'appeal');assert.equal(order.payment.refunded,0);
      order=await action(order,4,'proposeCase',{outcome:'refund',reason:'合成复核完成，重新提出整单全额模拟退款'});
      await action(order,0,'acceptCase');order=await action(order,1,'acceptCase');assert.equal(order.case.stage,'proposed');assert.equal(order.payment.refunded,0);
      order=await action(order,2,'acceptCase');assert.equal(order.case.stage,'closed');assert.equal(order.payment.refunded,2176);
      assert.equal((await req('/api/orders/'+order.id+'/actions/acceptCase',2,{version:order.version})).status,409);
      assert.equal(db.prepare("SELECT count(*) n FROM payment_jobs WHERE order_id=? AND action='refund'").get(order.id).n,1);
      const blocked=await fetch(base+route,{method:'POST',headers:{Cookie:users[0].cookie,Origin:base,'Content-Type':'image/png','X-File-Name':'late.png','X-Upload-Id':randomUUID()},body:bytes});assert.equal(blocked.status,409);
      orders[1]=order;
    });
    await t.test('禁付费状态、会话、评价、退款、证据及审计重启保持',async()=>{
      await stop();await start();assert.equal((await req('/api/me',0)).status,200);assert.equal((await req('/api/products')).data.paidOrdersEnabled,false);
      assert.equal((await req('/api/orders/'+orders[0].id,0)).data.order.review.text,'合成历史履约评价');
      assert.equal((await req('/api/orders/'+orders[1].id,2)).data.order.payment.refunded,2176);
      assert.equal((await fetch(base+file.url,{headers:{Cookie:users[2].cookie}})).status,200);
      assert.equal((await fetch(base+file.url,{headers:{Cookie:users[3].cookie}})).status,404);
      assert.ok((await req('/api/admin',4)).data.audit.length>0);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(logs,'');
    });
  }finally{await stop();await market?.waitForIdle();providers?.close();const target=realpathSync(directory);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-free-history-'));rmSync(target,{recursive:true});}
});
