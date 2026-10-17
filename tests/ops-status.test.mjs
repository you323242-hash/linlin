import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectOpsStatus,inspectSystemdStatus,OPS_UNITS} from '../scripts/ops-status.mjs';

test('独立运维检查拒绝陈旧、未来、损坏和未恢复状态，不输出私有内容',()=>{
  const now=Date.now(),date=n=>new Date(now-n).toISOString();
  const m={version:1,ok:true,checkedAt:date(0),open:{},secret:'DO_NOT_OUTPUT'};
  const b={version:1,ok:true,lastVerifiedAt:date(0)};
  assert.equal(inspectOpsStatus(m,b,now).ok,true);
  for(const changed of [{checkedAt:date(900000)},{checkedAt:date(-1)},{checkedAt:'bad'},{version:2},{open:[]},{open:{HTTPS_HEALTH:{}}},{ok:false}])assert.equal(inspectOpsStatus({...m,...changed},b,now).ok,false);
  assert.equal(inspectOpsStatus(m,{...b,lastVerifiedAt:date(36*3600000)},now).ok,false);
  assert.equal(inspectOpsStatus(null,null,now).ok,false);
  assert.ok(!JSON.stringify(inspectOpsStatus(m,b,now)).includes('DO_NOT_OUTPUT'));
});

test('运维CLI实际读取文件，正常0、过期1、缺失1且不泄漏输入',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'delta-ops-status-')),m=path.join(dir,'monitor.json'),b=path.join(dir,'backup.json');
  const run=()=>spawnSync(process.execPath,['scripts/ops-status.mjs',m,b],{encoding:'utf8'});
  try {
    const now=new Date().toISOString();
    writeFileSync(m,JSON.stringify({version:1,ok:true,checkedAt:now,open:{},secret:'PRIVATE_SECRET'}));
    writeFileSync(b,JSON.stringify({version:1,ok:true,lastVerifiedAt:now}));
    const good=run();assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).ok,true);assert.ok(!good.stdout.includes('PRIVATE_SECRET'));
    writeFileSync(m,JSON.stringify({version:1,ok:true,checkedAt:'2000-01-01T00:00:00Z',open:{}}));assert.equal(run().status,1);
    rmSync(m);const missing=run();assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stderr).code,'STATE_UNAVAILABLE');assert.ok(!missing.stderr.includes(dir));
  }finally{rmSync(dir,{recursive:true});}
});

test('运维CLI经部署目录链接仍执行：健康有结果、过期和非法参数失败，导入无副作用',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'delta-ops-linked-'));
  const alias=path.join(dir,'current'),m=path.join(dir,'monitor.json'),b=path.join(dir,'backup.json');
  const run=(args)=>spawnSync(process.execPath,args,{encoding:'utf8',timeout:5000});
  try {
    symlinkSync(path.resolve(import.meta.dirname,'..'),alias,process.platform==='win32'?'junction':'dir');
    const entry=path.join(alias,'scripts','ops-status.mjs'),now=new Date().toISOString();
    writeFileSync(m,JSON.stringify({version:1,ok:true,checkedAt:now,open:{},secret:'PRIVATE_SECRET'}));
    writeFileSync(b,JSON.stringify({version:1,ok:true,lastVerifiedAt:now}));
    const good=run([entry,m,b]);assert.equal(good.status,0,good.stderr);
    const report=JSON.parse(good.stdout);assert.equal(report.ok,true);assert.equal(report.checks.length,3);
    assert.ok(!good.stdout.includes('PRIVATE_SECRET'));
    writeFileSync(m,JSON.stringify({version:1,ok:true,checkedAt:'2000-01-01T00:00:00Z',open:{}}));
    const stale=run([entry,m,b]);assert.equal(stale.status,1);assert.equal(JSON.parse(stale.stdout).ok,false);
    const invalid=run([entry,m,b,'--invalid']);assert.equal(invalid.status,1);
    assert.equal(JSON.parse(invalid.stderr).code,'STATE_UNAVAILABLE');assert.ok(!invalid.stderr.includes(dir));
    const imported=run(['--input-type=module','-e',"await import('./scripts/ops-status.mjs'); console.log('IMPORT_ONLY');"]);
    assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout.trim(),'IMPORT_ONLY');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

function systemdFixture(changes={}) {return OPS_UNITS.map(id=>Object.entries({Id:id,LoadState:'loaded',ActiveState:id.endsWith('repair.service')?'inactive':'active',...(id.endsWith('repair.service')?{Result:'success'}:{}),...(changes[id]||{})}).map(([k,v])=>k+'='+v).join('\n')).join('\n\n');}

test('备份与恢复CLI经目录链接拒绝缺失参数，不空成功或导入时执行',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'delta-backup-linked-')),alias=path.join(dir,'current');
  try {
    symlinkSync(path.resolve(import.meta.dirname,'..'),alias,process.platform==='win32'?'junction':'dir');
    for(const filename of ['backup.mjs','recovery-check.mjs']) {
      const args=filename==='backup.mjs'?['--invalid']:[];
      const result=spawnSync(process.execPath,[path.join(alias,'scripts',filename),...args],{encoding:'utf8',timeout:5000,env:{...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:path.join(dir,'unused-data')}});
      assert.equal(result.status,1,result.stderr);assert.equal(result.stdout.trim(),'');assert.ok(result.stderr.trim());
      const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import('./scripts/${filename}'); console.log('IMPORT_ONLY');`],{encoding:'utf8',timeout:5000});
      assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout.trim(),'IMPORT_ONLY');
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('systemd检查区分oneshot正常inactive与timer停止、缺失、修复失败和pending',()=>{
  const good=systemdFixture();assert.ok(inspectSystemdStatus(good,false).every(c=>c.ok));
  for(const changes of [{'delta-monitor-repair.service':{Result:'exit-code'}},{'delta-monitor-repair.timer':{ActiveState:'inactive'}},{'delta-staging.service':{ActiveState:'failed'}},{'caddy.service':{LoadState:'not-found'}}])assert.ok(inspectSystemdStatus(systemdFixture(changes),false).some(c=>!c.ok));
  assert.ok(inspectSystemdStatus(good,true).some(c=>!c.ok));assert.ok(inspectSystemdStatus('',false).some(c=>!c.ok));
  assert.ok(inspectSystemdStatus(good+'\n\n'+good,false).some(c=>!c.ok));
});

test('新鲜应用和备份不能掩盖systemd故障，未请求systemd时明确覆盖范围',()=>{
 const now=Date.now(),date=new Date(now).toISOString(),m={version:1,ok:true,checkedAt:date,open:{}},b={version:1,ok:true,lastVerifiedAt:date};
 const old=inspectOpsStatus(m,b,now);assert.equal(old.ok,true);assert.equal(old.systemdChecked,false);
 const bad=inspectOpsStatus(m,b,now,inspectSystemdStatus(systemdFixture({'delta-monitor-repair.service':{Result:'exit-code',SECRET:'PRIVATE_SECRET'}}),false));assert.equal(bad.ok,false);assert.equal(bad.systemdChecked,true);assert.ok(!JSON.stringify(bad).includes('PRIVATE_SECRET'));
});
