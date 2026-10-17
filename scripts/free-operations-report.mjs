import {DatabaseSync} from 'node:sqlite';

const DAY=86400000,OFFSET=8*3600000;
const date=ms=>new Date(ms+OFFSET).toISOString().slice(0,10);
export function freeOperationsReport(db,{now=Date.now(),days=7}={}){
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-DAY||!Number.isInteger(days)||days<1||days>31)throw Error('时间参数无效：days须为1—31。');
 const start=Math.floor((now+OFFSET)/DAY)*DAY-OFFSET-(days-1)*DAY;
 const daily=Array.from({length:days},(_,i)=>({date:date(start+i*DAY),partial:i===days-1,publishedRooms:0,firstConfirmedRooms:0,endedRooms:0,endedWithTeamRecords:0,activeAccounts:0,feedbackSubmissions:0,reportSubmissions:0,appealSubmissions:0}));
 const group=(sql,field)=>{for(const row of db.prepare(sql).all(start,now)){const day=daily.find(d=>d.date===row.day);if(day)day[field]=row.n;}};
 const daySQL=column=>`date(${column}/1000,'unixepoch','+8 hours')`;
 db.exec('SAVEPOINT free_operations_report');
 try{
  group(`SELECT ${daySQL('created_at')} day,count(*) n FROM team_rooms WHERE created_at>=? AND created_at<=? GROUP BY day`,'publishedRooms');
  group(`SELECT ${daySQL('first_at')} day,count(*) n FROM (SELECT target_id,min(created_at) first_at FROM audit_events WHERE action='team_accept' GROUP BY target_id) WHERE first_at>=? AND first_at<=? GROUP BY day`,'firstConfirmedRooms');
  group(`SELECT ${daySQL('ended_at')} day,count(*) n FROM team_rooms WHERE status='ended' AND ended_at>=? AND ended_at<=? GROUP BY day`,'endedRooms');
  group(`SELECT ${daySQL('r.ended_at')} day,count(*) n FROM team_rooms r WHERE r.status='ended' AND r.ended_at>=? AND r.ended_at<=? AND (SELECT count(*) FROM team_members m WHERE m.room_id=r.id AND m.state='ended')>=2 GROUP BY day`,'endedWithTeamRecords');
  const activity="action IN ('team_published','team_join','team_accept','team_message','team_end','team_feedback','team_leave','team_withdraw')";
  group(`SELECT ${daySQL('created_at')} day,count(DISTINCT actor_id) n FROM audit_events WHERE ${activity} AND created_at>=? AND created_at<=? GROUP BY day`,'activeAccounts');
  for(const [table,field] of [['team_feedback','feedbackSubmissions'],['team_reports','reportSubmissions'],['team_appeals','appealSubmissions']])group(`SELECT ${daySQL('created_at')} day,count(*) n FROM ${table} WHERE created_at>=? AND created_at<=? GROUP BY day`,field);
  const queue=table=>{const r=db.prepare(`SELECT count(*) n,min(created_at) oldest FROM ${table} WHERE status='pending' AND created_at<=?`).get(now);return {pending:r.n,oldestPendingHours:r.oldest===null?null:Math.floor((now-r.oldest)/3600000)};};
  const repeat=db.prepare(`SELECT count(*) n FROM (SELECT actor_id FROM audit_events WHERE ${activity} AND created_at>=? AND created_at<=? AND actor_id IS NOT NULL GROUP BY actor_id HAVING count(DISTINCT ${daySQL('created_at')})>=2)`).get(start,now).n;
  const report={version:1,scope:'host-readonly-free-operations',asOf:new Date(now).toISOString(),timezone:'Asia/Shanghai',from:date(start),through:date(now),daily,repeatActiveAccounts:repeat,queues:{reports:queue('team_reports'),appeals:queue('team_appeals')},limitations:['活动账号包含内测和管理操作，不等于真实玩家、访客或注册增长','首次确认不是实际完成对局；结束成员记录也不能证明游戏内履约','待处理队列是当前库快照，不是历史时点复原；举报待核实，不自动处罚','未统计首次等待时间、留存率或消息正文；不输出账号、联系方式及举报证据']};
  db.exec('RELEASE free_operations_report');return report;
 }catch(error){db.exec('ROLLBACK TO free_operations_report');db.exec('RELEASE free_operations_report');throw error;}
}
if(import.meta.main){
 const [filename,daysRaw]=process.argv.slice(2);
 if(!filename||process.argv.length>4){process.stderr.write('用法：node scripts/free-operations-report.mjs <数据库路径> [1—31天]\n');process.exitCode=1;}
 else{let db;try{db=new DatabaseSync(filename,{readOnly:true});console.log(JSON.stringify(freeOperationsReport(db,{days:daysRaw===undefined?7:Number(daysRaw)}),null,2));}catch{process.stderr.write('运营汇总失败：请核对只读数据路径和时间参数。未输出原始记录。\n');process.exitCode=1;}finally{db?.close();}}
}
