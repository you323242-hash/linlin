import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {localConfig,PROJECT_ROOT} from '../server/config.mjs';
import {inspectRuntime,updateMonitorState,backupStatusOk,validMonitorState} from '../server/monitoring.mjs';

// Read-only DB inspection while the worker runs; not cross-database channel reconciliation.
let db;
try {
  const config=localConfig(),filename=process.env.MONITOR_STATE_FILE;
  if(!filename||!path.isAbsolute(filename))throw Error('STATE_PATH_REQUIRED');
  const target=path.resolve(filename),relative=path.relative(PROJECT_ROOT,target);
  if(relative===''||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))||target.startsWith(config.dataDirectory+path.sep))throw Error('PRIVATE_EXTERNAL_STATE_REQUIRED');
  mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  if(existsSync(target)&&(lstatSync(target).isSymbolicLink()||!lstatSync(target).isFile()||lstatSync(target).size>1024*1024))throw Error('INVALID_STATE_FILE');
  let previous={},stateInvalid=false;
  if(existsSync(target)) {
    const raw=readFileSync(target,'utf8');
    try {
      previous=JSON.parse(raw);
      if(!validMonitorState(previous))throw Error('INVALID_STATE_SCHEMA');
    }catch {
      // Keep the bounded regular original in its private directory for diagnosis.
      renameSync(target,target+'.invalid-'+randomUUID()+'.json');
      previous={};stateInvalid=true;
    }
  }
  let checks=[];
  try {
    db=new DatabaseSync(path.join(config.dataDirectory,'auth.sqlite'),{readOnly:true});
    checks=inspectRuntime(db,config.dataDirectory).checks;
  }catch{checks=[{code:'DATABASE_CHECK_FAILED',ok:false}];}
  finally{db?.close();db=null;}
  if(process.env.MONITOR_BACKUP_STATUS_FILE) {
    try {
      const filename=process.env.MONITOR_BACKUP_STATUS_FILE;
      if(lstatSync(filename).isSymbolicLink()||lstatSync(filename).size>4096)throw Error('INVALID_BACKUP_STATUS');
      const status=JSON.parse(readFileSync(filename,'utf8'));
      checks.push({code:'BACKUP_RECOVERY',ok:backupStatusOk(status)});
    }catch{checks.push({code:'BACKUP_RECOVERY',ok:false});}
  }
  try {
    // Normal CA verification remains enabled; staging uses a trusted private root.
    const response=await fetch(config.baseURL+'/api/health',{signal:AbortSignal.timeout(8000),redirect:'error'});
    const health=await response.json();
    checks.push({code:'HTTPS_HEALTH',ok:response.status===200&&health.app==='delta-companion'&&health.status==='ok'&&health.environment===config.environment});
  }catch{checks.push({code:'HTTPS_HEALTH',ok:false});}
  checks.push({code:'MONITOR_STATE_INVALID',ok:!stateInvalid});
  const {transitions,...state}=updateMonitorState(previous,checks);
  const temporary=target+'.'+process.pid+'.tmp';
  writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,target);
  console.log(JSON.stringify({event:'monitor_check',ok:state.ok,checks,openCount:Object.keys(state.open).length}));
  // Local journal only. A later delivery adapter must replay history with a cursor.
  for(const transition of transitions) {
    const {at,code,event:kind}=transition;
    const id=createHash('sha256').update(JSON.stringify([config.environment,at,code,kind])).digest('hex');
    console.log(JSON.stringify({event:'monitor_transition',id,at,code,kind,delivery:'not-configured'}));
  }
  if(!state.ok)process.exitCode=1;
}catch{console.error(JSON.stringify({event:'monitor_error',code:'MONITOR_FAILED'}));process.exitCode=1;}
finally{db?.close();}
