import {readFileSync,lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {backupStatusOk} from '../server/monitoring.mjs';

// Independent read-only probe: never report an old monitor success as current.
export function inspectOpsStatus(monitor,backup,now=Date.now(),runtimeChecks=[]) {
  const age=now-Date.parse(monitor?.checkedAt);
  const open=monitor?.open;
  const valid=monitor?.version===1&&typeof monitor.ok==='boolean'&&open&&typeof open==='object'&&!Array.isArray(open);
  const fresh=valid&&Number.isFinite(age)&&age>=0&&age<15*60_000;
  const checks=[
    {code:'MONITOR_FRESHNESS',ok:Boolean(fresh)},
    {code:'MONITOR_HEALTH',ok:Boolean(valid&&monitor.ok&&Object.keys(open).length===0)},
    {code:'BACKUP_RECOVERY',ok:backupStatusOk(backup,now)},
    ...runtimeChecks,
  ];
  return {scope:'read-only-operations-status',productionReady:false,systemdChecked:runtimeChecks.length>0,checkedAt:new Date(now).toISOString(),ok:checks.every(c=>c.ok),checks};
}

export const OPS_UNITS=['caddy.service','delta-staging.service','delta-monitor.timer','delta-backup.timer','delta-monitor-repair.timer','delta-monitor-repair.service'];

// Only allow fixed unit names and boolean results into the report.
export function inspectSystemdStatus(raw,pending) {
  const units=new Map();
  for(const block of raw.trim().split(/\n\s*\n/)) {
    const fields=Object.fromEntries(block.split('\n').filter(line=>line.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
    if(units.has(fields.Id))return [{code:'SYSTEMD_STATUS_INVALID',ok:false}];
    units.set(fields.Id,fields);
  }
  return [...OPS_UNITS.map(id=>{
    const u=units.get(id),repair=id==='delta-monitor-repair.service';
    return {code:'SYSTEMD_'+id.toUpperCase().replace(/[^A-Z0-9]/g,'_'),ok:Boolean(u?.LoadState==='loaded'&&(repair?['inactive','active'].includes(u.ActiveState)&&u.Result==='success':u.ActiveState==='active'))};
  }),{code:'MONITOR_RECOVERY_CLEAR',ok:pending===false}];
}

function readSystemdChecks() {
  try {
    if(process.platform!=='linux')throw Error('LINUX_REQUIRED');
    const raw=execFileSync('/usr/bin/systemctl',['show','--property=Id,LoadState,ActiveState,Result',...OPS_UNITS],{encoding:'utf8',timeout:3000,maxBuffer:32768,stdio:['ignore','pipe','pipe']});
    let pending=true;
    try {lstatSync('/var/lib/delta-maintenance/monitor-pending');}
    catch(error){if(error.code==='ENOENT')pending=false;else throw error;}
    return inspectSystemdStatus(raw,pending);
  }catch{return [{code:'SYSTEMD_STATUS_UNAVAILABLE',ok:false}];}
}

function readState(filename) {
  const info=lstatSync(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('INVALID_STATE');
  return JSON.parse(readFileSync(filename,'utf8'));
}
if(import.meta.main) {
  try {
    if(![4,5].includes(process.argv.length)||(process.argv.length===5&&process.argv[4]!=='--systemd'))throw Error('INVALID_ARGUMENTS');
    const result=inspectOpsStatus(readState(process.argv[2]),readState(process.argv[3]),Date.now(),process.argv[4]==='--systemd'?readSystemdChecks():[]);
    console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
  }catch{console.error(JSON.stringify({event:'ops_status',ok:false,code:'STATE_UNAVAILABLE'}));process.exitCode=1;}
}
