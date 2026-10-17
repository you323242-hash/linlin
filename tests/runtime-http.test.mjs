import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT } from '../server/config.mjs';

async function freePort() { const s=net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const port=s.address().port; await new Promise(r=>s.close(r)); return port; }
function start(args, env) {
  const child=spawn(process.execPath,args,{cwd:PROJECT_ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.output=''; for(const stream of [child.stdout,child.stderr]) stream.on('data',bytes=>{child.output=(child.output+bytes).slice(-20000);}); return child;
}
async function stop(child) { if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGKILL');await end;} }
async function ready(child,base) {
  // Parallel HTTP suites can spend several seconds importing auth and creating databases.
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline) {
    if(child.exitCode!==null) throw Error('Server exited: '+child.output);
    try { const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)}); if(response.ok)return await response.json(); } catch {}
    await delay(70);
  }
  throw Error('Server startup timeout: '+child.output);
}
test('实际进程强制关闭后恢复会话和任务；相同数据库第二进程及在线备份被拒绝', async t => {
  const parent=realpathSync(tmpdir()),directory=mkdtempSync(path.join(parent,'delta-crash-')),port=await freePort(),base=`http://127.0.0.1:${port}`;
  const env={...process.env,NODE_ENV:'test',APP_ENV:'test',PORT:String(port),AUTH_DATA_DIR:directory,BETTER_AUTH_URL:base};
  for(const key of ['BETTER_AUTH_SECRET','TRUSTED_PROXY_IPS','STAGING_ACCESS_TOKEN','ALLOW_STAGING_MOCKS','EXTERNAL_SERVICE_MODE','BACKUP_KEY_FILE','AUTH_KEY_REF'])delete env[key];
  const children=[]; let child=start(['server/index.mjs'],env);children.push(child);
  t.after(async()=>{for(const c of children)await stop(c);const target=realpathSync(directory);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-crash-'));rmSync(target,{recursive:true});});
  const health=await ready(child,base);assert.equal(health.automation.status,'ok');
  const second=start(['server/index.mjs'],{...env,PORT:String(await freePort())});children.push(second);
  await once(second,'exit');assert.notEqual(second.exitCode,0);assert.match(second.output,/正在使用/);
  const backupTarget=path.join(directory,'online-backup'),backup=start(['scripts/backup.mjs','create',backupTarget],env);children.push(backup);
  await once(backup,'exit');assert.notEqual(backup.exitCode,0);assert.match(backup.output,/正在使用/);assert.equal(existsSync(backupTarget),false);
  const register=await fetch(base+'/api/auth/sign-up/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'重启用户',email:'restart@example.test',password:'Restart-safe-local-2026!',termsAccepted:true})});
  assert.equal(register.status,200);const signed=await register.json();const cookie=register.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const post=async(url,data)=>{const res=await fetch(base+url,{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({...data,requestId:randomUUID()})});assert.equal(res.status,200);assert.match(res.headers.get('x-request-id'),/^[a-f0-9-]{36}$/);return res.json();};
  const {order}=await post('/api/orders',{mode:'secret',rulesAccepted:true});await post(`/api/orders/${order.id}/actions/pay`,{version:order.version});
  const adminResponse=await fetch(base+'/api/admin',{headers:{Cookie:cookie}});assert.equal(adminResponse.status,403);
  await stop(child);
  const db=new DatabaseSync(path.join(directory,'auth.sqlite'));
  db.prepare("UPDATE user SET role='admin' WHERE id=?").run(signed.user.id);
  // Simulate a process dying after the task heartbeat was persisted.
  db.prepare("UPDATE runtime_tasks SET state='running',next_at=0 WHERE id='notifications'").run();db.close();
  child=start(['server/index.mjs'],env);children.push(child);await ready(child,base);
  const me=await fetch(base+'/api/me',{headers:{Cookie:cookie}});assert.equal(me.status,200);assert.equal((await me.json()).user.id,signed.user.id);
  const restored=await(await fetch(base+'/api/orders/'+order.id,{headers:{Cookie:cookie}})).json();assert.equal(restored.order.payment.status,'paid');
  assert.equal(restored.order.events.filter(e=>e.label.startsWith('模拟支付成功')).length,1);
  const data=await(await fetch(base+'/api/admin',{headers:{Cookie:cookie}})).json();assert.equal(data.operations.tasks.find(t=>t.id==='notifications').state,'idle');assert.ok(data.operations.tasks.find(t=>t.id==='notifications').runs>=2);
  const page=await fetch(base+'/admin.html',{headers:{Cookie:cookie}});assert.equal(page.status,200);
  const detail=JSON.stringify(await(await fetch(base+'/api/health')).json());assert.ok(!detail.includes(directory));assert.ok(!detail.includes(order.id));assert.ok(!detail.includes('restart@example.test'));
  await stop(child);
  const logs=readdirSync(path.join(directory,'logs')).map(f=>readFileSync(path.join(directory,'logs',f),'utf8')).join('');
  assert.ok(logs.includes(order.id));assert.ok(!logs.includes('Restart-safe-local-2026!'));assert.ok(!logs.includes('restart@example.test'));assert.ok(!logs.includes(cookie));
});
