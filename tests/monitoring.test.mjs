import {createFeedback} from '../server/feedback.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAuth} from '../server/auth.mjs';
import {createMarket} from '../server/market.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {createTeams} from '../server/teams.mjs';
import {createTeamProfiles} from '../server/team-profiles.mjs';
import {createSecurity} from '../server/security.mjs';
import {createPersonas} from '../server/personas.mjs';
import {createEvidence} from '../server/evidence.mjs';
import {inspectRuntime,updateMonitorState,backupStatusOk,validMonitorState} from '../server/monitoring.mjs';

test('监控同库一致快照：只读、正常与卡住任务/告警/低磁盘区分',async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'delta-monitor-'));
  const {auth,database}=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:directory});
  const providers=createLocalProviders({directory}),market=createMarket(database,providers);
  createSecurity(database);createTeams(database);createPersonas(database);createFeedback(database,{assertAdmin:createSecurity(database,auth).assertAdmin});createEvidence(database,market,providers.storage);
  createTeamProfiles(database);
  const now=Date.now();
  database.prepare("INSERT INTO runtime_tasks(id,state,next_at) VALUES ('monitor-test','idle',?)").run(now);
  const ro=new DatabaseSync(path.join(directory,'auth.sqlite'),{readOnly:true});
  try {
    const normal=inspectRuntime(ro,directory,{now});assert.ok(normal.checks.every(c=>c.ok),JSON.stringify(normal.checks));
    assert.throws(()=>ro.exec("DELETE FROM runtime_tasks"));
    const user=(await auth.api.signUpEmail({body:{name:'监测夹具',email:'monitor@example.test',password:'Monitor-test-only-2026!',termsAccepted:true}})).user;
    const {order}=await market.command(user,'create',{mode:'secret',rulesAccepted:true,requestId:'monitor-create'});
    database.prepare("INSERT INTO payment_jobs(id,order_id,action,amount,reason) VALUES ('fresh',?,'pay',1088,'isolated')").run(order.id);
    assert.equal(inspectRuntime(ro,directory,{now}).checks.find(c=>c.code==='PAYMENT_TASKS').ok,true,'新任务未执行不能按1970年时间误报');
    database.exec("UPDATE payment_jobs SET status='blocked' WHERE id='fresh'");
    assert.equal(inspectRuntime(ro,directory,{now}).checks.find(c=>c.code==='PAYMENT_TASKS').count,1);
    database.prepare("UPDATE runtime_tasks SET state='running',started_at=?").run(now-180001);
    database.exec("INSERT INTO operation_alerts(id,kind,target_id,code,opened_at,updated_at) VALUES ('sensitive-id','payment','private-order','TIMEOUT',0,0)");
    const bad=inspectRuntime(ro,directory,{now,statfs:()=>({bavail:1,bsize:4096})});
    assert.equal(bad.checks.find(c=>c.code==='WORKER_HEARTBEAT').ok,false);
    assert.equal(bad.checks.find(c=>c.code==='OPERATION_ALERTS').count,1);
    assert.equal(bad.checks.find(c=>c.code==='DISK_SPACE').ok,false);
    assert.ok(!JSON.stringify(bad).includes('private-order'));
  }finally{ro.close();providers.close();database.close();rmSync(directory,{recursive:true});}
});

test('监控事件只在变化时新增，持续故障不刷屏，恢复留痕且历史有上限',()=>{
  let state=updateMonitorState({},[{code:'HTTPS_HEALTH',ok:false}],0);
  assert.equal(state.history.length,1);assert.equal(state.ok,false);
  state=updateMonitorState(state,[{code:'HTTPS_HEALTH',ok:false}],1000);
  assert.equal(state.history.length,1);assert.equal(state.open.HTTPS_HEALTH.since,new Date(0).toISOString());
  const partial=updateMonitorState(state,[{code:'DATABASE_CHECK_FAILED',ok:false}],1500);
  assert.ok(partial.open.HTTPS_HEALTH,'未检查的项不能被当作已恢复');
  const recovered=updateMonitorState(partial,[{code:'DATABASE_INTEGRITY',ok:true},{code:'HTTPS_HEALTH',ok:true}],1800);
  assert.equal(recovered.ok,true);
  state=updateMonitorState(state,[{code:'HTTPS_HEALTH',ok:true}],2000);
  assert.equal(state.ok,true);assert.equal(state.history[1].event,'resolved');
  for(let i=0;i<120;i++)state=updateMonitorState(state,[{code:'HTTPS_HEALTH',ok:i%2===0}],3000+i);
  assert.equal(state.history.length,100);
});

test('备份必须成功且36小时内已恢复验证，未来时间/失败/无证明拒绝',()=>{
  const now=Date.now(),status={version:1,ok:true,lastVerifiedAt:new Date(now-1000).toISOString()};
  assert.equal(backupStatusOk(status,now),true);
  for(const patch of [{ok:false},{lastVerifiedAt:null},{lastVerifiedAt:'bad'},{version:2},{lastVerifiedAt:new Date(now+1000).toISOString()},{lastVerifiedAt:new Date(now-36*3600_000).toISOString()}])assert.equal(backupStatusOk({...status,...patch},now),false);
});


test('监控状态只接受既有安全结构，拒绝未知字段与伪健康状态',()=>{
 const {transitions,...state}=updateMonitorState({},[{code:'HTTPS_HEALTH',ok:false}],0);
 assert.equal(validMonitorState(state),true);
 for(const value of [null,[],{}, {...state,secret:'private'}, {...state,ok:true}, {...state,open:[]}, {...state,open:{UNKNOWN:{since:state.checkedAt,lastSeen:state.checkedAt}}}, {...state,history:[{at:state.checkedAt,code:'HTTPS_HEALTH',event:'opened',private:'secret'}]}, {...state,history:Array(101).fill(state.history[0])}])assert.equal(validMonitorState(value),false);
 const {transitions:ignored,...recovered}=updateMonitorState(state,[{code:'HTTPS_HEALTH',ok:true}],1000);
 assert.equal(validMonitorState(recovered),true);
});
