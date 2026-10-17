import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createTeams} from '../server/teams.mjs';
import {freeOperationsReport} from '../scripts/free-operations-report.mjs';

test('只读免费运营日报：北京时间边界、去重、待处理口径与隐私',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'qingbo-operations-')),file=path.join(dir,'fixture.sqlite');
 let db=new DatabaseSync(file);const now=Date.parse('2026-10-13T02:00:00Z'),beforeMidnight=Date.parse('2026-10-12T15:59:59Z'),afterMidnight=Date.parse('2026-10-12T16:00:00Z');
 db.exec('CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE audit_events(actor_id TEXT,target_id TEXT,action TEXT,reason TEXT,created_at INTEGER);');
 db.prepare('INSERT INTO user VALUES(?,?)').run('PRIVATE_ACCOUNT','PRIVATE_NAME');db.prepare('INSERT INTO user VALUES(?,?)').run('OTHER_ACCOUNT','OTHER_NAME');createTeams(db);
 const room=db.prepare('INSERT INTO team_rooms(id,owner_id,status,payload,created_at,ended_at) VALUES(?,?,?,?,?,?)');
 room.run('a','PRIVATE_ACCOUNT','ended','{"private":"PRIVATE_GAME_ID"}',beforeMidnight,afterMidnight);room.run('b','PRIVATE_ACCOUNT','ended','{}',afterMidnight,now);room.run('future','PRIVATE_ACCOUNT','open','{}',now+1,null);
 const member=db.prepare('INSERT INTO team_members VALUES(?,?,?,?,?,?)');for(const id of ['PRIVATE_ACCOUNT','OTHER_ACCOUNT'])member.run('a',id,'ended','PRIVATE_NOTE',beforeMidnight,afterMidnight);member.run('b','PRIVATE_ACCOUNT','ended','',now,now);
 const audit=db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)');audit.run('PRIVATE_ACCOUNT','a','team_published','PRIVATE_REASON',beforeMidnight);audit.run('PRIVATE_ACCOUNT','a','team_accept','',beforeMidnight);audit.run('PRIVATE_ACCOUNT','a','team_accept','',afterMidnight);audit.run('PRIVATE_ACCOUNT','a','team_message','PRIVATE_MESSAGE',afterMidnight);audit.run('OTHER_ACCOUNT','a','team_message','',afterMidnight);audit.run('OTHER_ACCOUNT','a','team_report_reviewed','',beforeMidnight);audit.run('FUTURE_ACCOUNT','future','team_published','',now+1);
 db.prepare('INSERT INTO team_reports(id,room_id,actor_id,target_id,kind,reason,snapshot,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('report','a','PRIVATE_ACCOUNT','OTHER_ACCOUNT','其他不当内容','PRIVATE_EVIDENCE','PRIVATE_SNAPSHOT','pending',now-2*3600000);
 db.prepare('INSERT INTO team_appeals(id,user_id,report_id,reason,status,created_at) VALUES(?,?,?,?,?,?)').run('appeal','OTHER_ACCOUNT','report','PRIVATE_APPEAL','accepted',now-3600000);
 db.close();const hash=()=>createHash('sha256').update(readFileSync(file)).digest('hex'),before=hash();db=new DatabaseSync(file,{readOnly:true});
 try{
  const report=freeOperationsReport(db,{now,days:2});assert.deepEqual(report.daily.map(d=>d.date),['2026-10-12','2026-10-13']);
  assert.deepEqual(report.daily.map(d=>d.publishedRooms),[1,1]);assert.deepEqual(report.daily.map(d=>d.firstConfirmedRooms),[1,0]);assert.deepEqual(report.daily.map(d=>d.activeAccounts),[1,2]);
  assert.equal(report.daily[1].endedRooms,2);assert.equal(report.daily[1].endedWithTeamRecords,1);assert.equal(report.daily[1].reportSubmissions,1);assert.equal(report.daily[1].appealSubmissions,1);assert.equal(report.repeatActiveAccounts,1);
  assert.deepEqual(report.queues.reports,{pending:1,oldestPendingHours:2});assert.deepEqual(report.queues.appeals,{pending:0,oldestPendingHours:null});assert.equal(report.daily[1].partial,true);
  const serialized=JSON.stringify(report);for(const marker of ['PRIVATE_ACCOUNT','OTHER_ACCOUNT','PRIVATE_NAME','PRIVATE_REASON','PRIVATE_GAME_ID','PRIVATE_NOTE','PRIVATE_MESSAGE','PRIVATE_EVIDENCE','PRIVATE_SNAPSHOT','PRIVATE_APPEAL'])assert.ok(!serialized.includes(marker));
  assert.throws(()=>freeOperationsReport(db,{now,days:0}));assert.throws(()=>freeOperationsReport(db,{now,days:32}));assert.throws(()=>freeOperationsReport(db,{now:NaN}));
  assert.equal(hash(),before);
 }finally{db.close();}
 const script=path.resolve(import.meta.dirname,'../scripts/free-operations-report.mjs');
 const cli=spawnSync(process.execPath,[script,file,'2'],{encoding:'utf8',timeout:10000});assert.equal(cli.status,0);assert.equal(JSON.parse(cli.stdout).scope,'host-readonly-free-operations');assert.equal(hash(),before);
 const absent=path.join(dir,'absent.sqlite'),invalid=spawnSync(process.execPath,[script,absent],{encoding:'utf8',timeout:10000});assert.equal(invalid.status,1);assert.equal(invalid.stdout,'');assert.equal(existsSync(absent),false);
 const bad=spawnSync(process.execPath,[script,file,'32'],{encoding:'utf8',timeout:10000});assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.equal(hash(),before);
});
