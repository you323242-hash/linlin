import { statfsSync } from 'node:fs';
import { inspectPaymentJournal } from './payment-journal.mjs';
import { REQUIRED_MIGRATIONS } from './upgrade-backup.mjs';

export function backupStatusOk(status,now=Date.now()) {
  const age=now-Date.parse(status?.lastVerifiedAt);
  return status?.version===1&&status.ok===true&&Number.isFinite(age)&&age>=0&&age<36*3600_000;
}

// One read transaction, no migrations, repair, identities or private payloads.
export function inspectRuntime(db, directory, {now=Date.now(),statfs=statfsSync}={}) {
  const checks=[];
  db.exec('BEGIN');
  try {
    const versions=db.prepare('SELECT id FROM app_migrations').all().map(r=>r.id);
    checks.push({code:'DATABASE_INTEGRITY',ok:db.prepare('PRAGMA quick_check').get().quick_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0});
    checks.push({code:'MIGRATIONS',ok:REQUIRED_MIGRATIONS.every(id=>versions.includes(id))});
    const journal=inspectPaymentJournal(db);
    checks.push({code:'PAYMENT_LEDGER',ok:journal.ok&&journal.legacyUncovered===0});
    const tasks=db.prepare('SELECT state,started_at,next_at,failures FROM runtime_tasks').all();
    checks.push({code:'WORKER_HEARTBEAT',ok:tasks.length>0&&tasks.every(r=>r.failures===0&&(r.state==='running'?Number.isSafeInteger(r.started_at)&&now-r.started_at<180_000:now<=r.next_at+180_000))});
    const failures=db.prepare("SELECT count(*) n FROM operation_alerts WHERE resolved_at IS NULL AND kind<>'attention'").get().n;
    checks.push({code:'OPERATION_ALERTS',ok:failures===0,count:failures});
    for(const table of ['payment_jobs','notification_jobs']) {
      const join=table==='payment_jobs'?'orders source ON source.id=j.order_id':'notifications source ON source.id=j.id';
      const stuck=db.prepare(`SELECT count(*) n FROM ${table} j JOIN ${join} WHERE j.status<>'done' AND (j.status='blocked' OR (? - CASE WHEN j.updated_at>0 THEN j.updated_at ELSE source.created_at END)>900000)`).get(now).n;
      checks.push({code:table==='payment_jobs'?'PAYMENT_TASKS':'NOTIFICATION_TASKS',ok:stuck===0,count:stuck});
    }
    const disk=statfs(directory),available=BigInt(disk.bavail)*BigInt(disk.bsize);
    checks.push({code:'DISK_SPACE',ok:available>=256n*1024n*1024n});
    return {scope:'restricted-mock-only',productionReady:false,checkedAt:new Date(now).toISOString(),checks};
  } finally {db.exec('ROLLBACK');}
}

const MONITOR_CODES=new Set(['DATABASE_INTEGRITY','MIGRATIONS','PAYMENT_LEDGER','WORKER_HEARTBEAT','OPERATION_ALERTS','PAYMENT_TASKS','NOTIFICATION_TASKS','DISK_SPACE','DATABASE_CHECK_FAILED','BACKUP_RECOVERY','HTTPS_HEALTH','MONITOR_STATE_INVALID']);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const keys=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));

// Reject unexpected/private fields instead of copying them into future logs/history.
export function validMonitorState(state) {
  return keys(state,['version','checkedAt','ok','open','history'])&&state.version===1&&timestamp(state.checkedAt)&&typeof state.ok==='boolean'
    &&record(state.open)&&Object.entries(state.open).every(([code,value])=>MONITOR_CODES.has(code)&&keys(value,['since','lastSeen'])&&timestamp(value.since)&&timestamp(value.lastSeen))
    &&state.ok===(Object.keys(state.open).length===0)&&Array.isArray(state.history)&&state.history.length<=100
    &&state.history.every(event=>keys(event,['at','code','event'])&&timestamp(event.at)&&MONITOR_CODES.has(event.code)&&['opened','resolved'].includes(event.event));
}

// Stable issue keys, bounded history, no accounts/evidence/amounts/secrets.
export function updateMonitorState(previous, checks, now=Date.now()) {
  const timestamp=new Date(now).toISOString(),events=[];
  const old=previous?.version===1?previous.open||{}:{};
  const open={...old};
  for(const c of checks) if(!c.ok) {
    open[c.code]={since:old[c.code]?.since||timestamp,lastSeen:timestamp};
    if(!old[c.code])events.push({at:timestamp,code:c.code,event:'opened'});
  } else if(open[c.code]) {
    delete open[c.code];events.push({at:timestamp,code:c.code,event:'resolved'});
  }
  if(checks.some(c=>c.code==='DATABASE_INTEGRITY'&&c.ok)&&!checks.some(c=>c.code==='DATABASE_CHECK_FAILED')&&open.DATABASE_CHECK_FAILED) {
    delete open.DATABASE_CHECK_FAILED;events.push({at:timestamp,code:'DATABASE_CHECK_FAILED',event:'resolved'});
  }
  return {transitions:events,version:1,checkedAt:timestamp,ok:Object.keys(open).length===0,open,history:[...(previous?.version===1&&Array.isArray(previous.history)?previous.history:[]),...events].slice(-100)};
}
