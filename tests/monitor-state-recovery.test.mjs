import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
const run=env=>new Promise(resolve=>{const child=spawn(process.execPath,['scripts/monitor.mjs'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('close',code=>resolve({code,out,err}));});
test('监控损坏状态保留原件并继续巡检；修复后恢复事件只出现一次',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'delta-monitor-state-')),data=path.join(root,'data'),status=path.join(root,'status');mkdirSync(data);mkdirSync(status);
 const file=path.join(status,'state.json');
 const server=http.createServer((_q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({app:'delta-companion',status:'ok',environment:'test'}));});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const env={...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:data,PORT:String(server.address().port),BETTER_AUTH_URL:'http://127.0.0.1:'+server.address().port,MONITOR_STATE_FILE:file};
 for(const key of ['STAGING_ACCESS_TOKEN','ALLOW_STAGING_MOCKS','TRUSTED_PROXY_IPS','BETTER_AUTH_SECRET','MONITOR_BACKUP_STATUS_FILE','BACKUP_KEY_FILE','AUTH_KEY_REF'])delete env[key];
 try {
  const raw='{broken-private-content: DO_NOT_EXPOSE';writeFileSync(file,raw);
  const first=await run(env);assert.equal(first.code,1);assert.match(first.out,/monitor_check/,'损坏旧状态不能阻止当前检查');
  const state=JSON.parse(readFileSync(file,'utf8'));assert.ok(state.open.MONITOR_STATE_INVALID);assert.ok(state.open.DATABASE_CHECK_FAILED);assert.equal(state.open.HTTPS_HEALTH,undefined);
  const archive=readdirSync(status).find(name=>name.startsWith('state.json.invalid-'));assert.ok(archive);assert.equal(readFileSync(path.join(status,archive),'utf8'),raw);
  assert.doesNotMatch(first.out+first.err,/DO_NOT_EXPOSE|broken-private-content/);
  const opened=first.out.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.event==='monitor_transition');assert.ok(opened.some(e=>e.code==='MONITOR_STATE_INVALID'&&e.kind==='opened'&&e.delivery==='not-configured'));assert.ok(opened.every(e=>/^[a-f0-9]{64}$/.test(e.id)));
  const second=await run(env);assert.equal(second.code,1);const transitions=second.out.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.event==='monitor_transition');assert.equal(transitions.filter(e=>e.code==='MONITOR_STATE_INVALID'&&e.kind==='resolved').length,1);assert.equal(transitions.filter(e=>e.code==='DATABASE_CHECK_FAILED').length,0);
  const third=await run(env);assert.equal(third.code,1);assert.doesNotMatch(third.out,/monitor_transition/);assert.equal(readdirSync(status).filter(name=>name.startsWith('state.json.invalid-')).length,1);
  writeFileSync(file,JSON.stringify({version:1,ok:true,open:[],history:[],checkedAt:new Date().toISOString(),secret:'PRIVATE_SCHEMA'}));
  const schema=await run(env);assert.match(schema.out,/monitor_check/);assert.doesNotMatch(schema.out+schema.err,/PRIVATE_SCHEMA/);assert.ok(JSON.parse(readFileSync(file,'utf8')).open.MONITOR_STATE_INVALID);
  const oversized='x'.repeat(1024*1024+1);writeFileSync(file,oversized);
  const rejected=await run(env);assert.equal(rejected.code,1);assert.doesNotMatch(rejected.out,/monitor_check/);assert.equal(readFileSync(file,'utf8'),oversized,'不覆盖超限文件');assert.equal(readdirSync(status).filter(name=>name.startsWith('state.json.invalid-')).length,2);
 }finally{await new Promise(done=>server.close(done));rmSync(root,{recursive:true});}
});
