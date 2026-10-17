import { createSnapshot, restoreSnapshot } from '../scripts/snapshot.mjs';
import { createAuth } from '../server/auth.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JPEG } from './avatar-fixture.mjs';
import net from 'node:net';
import path from 'node:path';

test('免费组队真实HTTP：跨账户、持久化、并发、权限与核实申诉闭环', async t => {
  const parent = realpathSync(tmpdir()), directory = mkdtempSync(path.join(parent, 'delta-teams-http-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child, db;
  async function start() {
    child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../server/index.mjs')], { env: { ...process.env, APP_ENV:'test', NODE_ENV:'test', PORT:String(port), BETTER_AUTH_URL:base, AUTH_DATA_DIR:directory }, stdio:['ignore','pipe','pipe'] });
    await new Promise((resolve, reject) => {
      let stderr = ''; child.stderr.on('data', b => stderr += b);
      const timer = setTimeout(() => reject(Error('组队服务启动超时')), 20000);
      child.stdout.on('data', b => { if (b.toString().includes('已启动')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error('启动失败：' + code + ' ' + stderr)); });
    });
    db = new DatabaseSync(path.join(directory, 'auth.sqlite'));
  }
  async function stop() { db?.close(); db = null; if (child?.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); }
  async function req(route, user, body, origin = base) {
    const response = await fetch(base + route, { method:body ? 'POST':'GET', headers:{ ...(user ? {Cookie:user.cookie}:{}), ...(body ? {Origin:origin,'Content-Type':'application/json'}:{}) }, ...(body ? {body:JSON.stringify(body)}:{}) });
    return { status:response.status, data:await response.json(), cookie:response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ') };
  }
  const post = (route, user, body = {}) => req(route, user, {...body,requestId:randomUUID()});
  const action = (id,user,verb,body) => post(`/api/teams/${id}/actions/${verb}`,user,body);
  const fields = { title:'本地双人组队验收', intro:'稳健搜集，友善沟通', when:'现在可开始', need:1, mode:'机密行动', style:'稳健搜集', mic:'text', tags:'愿意配合', selfTags:'耐心沟通', agree:true };
  const users = []; let room, winner, loser, reportId, appealId;
  try {
    await start();
    for (let i=0;i<5;i++) {
      const response = await req('/api/auth/sign-up/email',null,{name:'组队验收'+i,email:`team${i}@example.test`,password:'Teams-local-password-2026!',termsAccepted:true});
      assert.equal(response.status,200,JSON.stringify(response.data)); users.push({...response.data.user,cookie:response.cookie});
    }
    const [host,a,b,outsider,admin] = users;
    db.prepare("UPDATE user SET role='admin' WHERE id=?").run(admin.id);
    await t.test('公开浏览零示例；写操作必须登录和校验来源', async () => {
      assert.deepEqual((await req('/api/teams')).data.rooms,[]);
      for (const route of ['/api/teams/mine','/api/team-admin']) assert.equal((await req(route)).status,401);
      assert.equal((await post('/api/teams',null,fields)).status,401);
      assert.equal((await req('/api/teams',host,{...fields,requestId:randomUUID()},'https://invalid.example.test')).status,403);
      assert.equal((await post('/api/teams',host,{...fields,agree:false})).status,400);
      assert.equal((await post('/api/teams',host,{...fields,need:{}})).status,400);
      assert.equal((await post('/api/teams',host,{...fields,tags:[]})).status,400);
    });
    await t.test('不限模式、自定义风格、可选说明与移出后举报权限', async () => {
      const r = await post('/api/teams',host,{...fields,mode:'不限',style:'任务练习',intro:'',gameId:'GAME-PRIVATE-ID'});
      assert.equal(r.status,200,JSON.stringify(r.data)); const id=r.data.roomId;
      assert.ok((await req('/api/teams?mode=绝密行动')).data.rooms.some(room=>room.id===id));
      assert.equal((await action(id,a,'join')).status,200);
      assert.equal((await req('/api/teams/'+id,a)).data.gameId,'');
      assert.ok(!JSON.stringify((await req('/api/teams')).data).includes('GAME-PRIVATE-ID'));
      assert.equal((await action(id,host,'accept',{userId:a.id})).status,200);
      assert.equal((await req('/api/teams/'+id,a)).data.gameId,'GAME-PRIVATE-ID');
      assert.equal((await action(id,outsider,'remove',{userId:a.id})).status,403);
      assert.equal((await action(id,host,'remove',{userId:host.id})).status,409);
      assert.equal((await action(id,host,'remove',{userId:a.id})).status,200);
      assert.equal((await req('/api/teams/'+id+'/messages',a)).status,403);
      assert.equal((await req('/api/teams/'+id,a)).data.gameId,'');
      assert.equal((await action(id,a,'report',{targetId:host.id,kind:'骚扰 / 辱骂',reason:'被移出后仍可以举报实际发生的问题'})).status,200);
      assert.equal((await action(id,host,'end')).status,200);
      // This independent room must not affect the existing closed-loop fixtures.
      db.prepare('DELETE FROM team_reports WHERE room_id=?').run(id);
      db.prepare('DELETE FROM team_members WHERE room_id=?').run(id);
      db.prepare('DELETE FROM team_rooms WHERE id=?').run(id);
    });
    await t.test('创建真实招募、幂等重试、冲突请求和公开隐私', async () => {
      const request = {...fields,requestId:randomUUID()};
      const response = await req('/api/teams',host,request); assert.equal(response.status,200,JSON.stringify(response.data)); room=response.data.room;
      assert.equal((await req('/api/teams',host,request)).data.roomId,room.id);
      assert.equal((await req('/api/teams',host,{...request,title:'不同内容'})).status,409);
      assert.equal(db.prepare('SELECT count(*) AS n FROM team_rooms').get().n,1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
      const publicData = (await req('/api/teams/'+room.id)).data;
      assert.equal(publicData.room.live,true); assert.equal(publicData.membership,null); assert.deepEqual(publicData.members,[]);
      assert.ok(!JSON.stringify(publicData).includes(host.email)); assert.ok(!JSON.stringify(publicData).includes(host.id));
      assert.equal((await action(room.id,host,'join')).status,409);
    });
    await t.test('自传头像背景不向匿名招募泄露内部用户ID，图片仍可正常展示',async()=>{
      const saved=await req('/api/persona',host,{theme:'tactical',cover:'coast',avatar:'initial',operator:'none',texture:'none',motion:'off',gender:'unspecified',signature:'合成资料',bio:'',style:'',maps:['AZ3'],modes:['机密行动'],version:0,avatarAction:'replace',avatarContent:JPEG,backgroundAction:'replace',backgroundContent:JPEG});assert.equal(saved.status,200);
      const board=(await req('/api/teams')).data;
      const detail=(await req('/api/teams/'+room.id)).data;
      for(const data of [board,detail])assert.ok(!JSON.stringify(data).includes(host.id));
      const appearance=detail.room.appearance;
      for(const image of [appearance.avatarUrl,appearance.backgroundUrl]){
        const response=await fetch(base+image);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.match(response.headers.get('content-security-policy'),/sandbox/);
      }
      assert.equal((await req('/api/team-persona-images/'+room.id+'?type=private')).status,400);
      assert.equal((await req('/api/team-persona-images/'+randomUUID()+'?type=avatar')).status,404);
      assert.equal((await req('/api/persona-space/room/'+room.id)).status,401);
    });
    await t.test('申请不是确认；留言私有、申请重复与非法参数', async () => {
      assert.equal((await action(room.id,a,'join',{note:'仅房主可以看到的申请留言'})).status,200);
      assert.equal((await action(room.id,b,'join',{note:'第二位申请'})).status,200);
      assert.equal((await action(room.id,a,'join',{note:'重复'})).status,409);
      assert.equal((await req('/api/teams/'+room.id+'/messages',a)).status,403);
      assert.equal((await action(room.id,a,'message',{message:'未确认不能发言'})).status,403);
      assert.equal((await action(room.id,a,'accept',{userId:a.id})).status,403);
      assert.equal((await action(room.id,host,'accept',{userId:{}})).status,400);
      assert.deepEqual((await req('/api/teams/'+room.id,outsider)).data.applicants,[]);
      assert.equal((await req('/api/teams/'+room.id,host)).data.applicants.length,2);
    });
    await t.test('两个并发确认只能占用最后一个名额', async () => {
      const responses=await Promise.all([action(room.id,host,'accept',{userId:a.id}),action(room.id,host,'accept',{userId:b.id})]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
      winner=responses[0].status===200?a:b;loser=winner===a?b:a;
      assert.equal(db.prepare("SELECT count(*) AS n FROM team_members WHERE room_id=? AND state='confirmed'").get(room.id).n,2);
      assert.equal((await req('/api/teams/'+room.id)).data.room.need,0);
      assert.equal((await action(room.id,outsider,'join')).status,409);
    });
    await t.test('消息实际落库、重试不重复、跨人越权和限频', async () => {
      const body={message:'<script>消息只作为文字展示</script>',requestId:randomUUID()};
      assert.equal((await req(`/api/teams/${room.id}/actions/message`,winner,body)).status,200);
      assert.equal((await req(`/api/teams/${room.id}/actions/message`,winner,body)).status,200);
      const messages=(await req(`/api/teams/${room.id}/messages`,host)).data.messages;
      assert.equal(messages.length,1);assert.equal(messages[0].text,body.message);
      assert.equal((await req(`/api/teams/${room.id}/messages`,outsider)).status,403);
      assert.equal((await req(`/api/teams/${room.id}/messages`,loser)).status,403);
      assert.equal((await action(room.id,winner,'message',{message:'太快'})).status,429);
      assert.equal((await req(`/api/teams/${room.id}/messages?after=not-a-number`,host)).status,400);
      assert.equal((await req(`/api/teams/${room.id}/messages?before=${Number.MAX_SAFE_INTEGER}`,host)).data.messages.length,1);
    });
    await t.test('结束前不能反馈；房主结束、实际队友反馈一次，未确认者不能刷信誉', async () => {
      const feedback={targetId:host.id,again:'愿意再次组队',communication:'沟通友好、配合顺畅',reliable:'按约上线'};
      assert.equal((await action(room.id,winner,'feedback',feedback)).status,409);
      assert.equal((await action(room.id,winner,'end')).status,403);
      assert.equal((await action(room.id,host,'end')).status,200);
      assert.equal((await action(room.id,winner,'message',{message:'已结束不可发言'})).status,409);
      assert.equal((await action(room.id,winner,'feedback',feedback)).status,200);
      assert.equal((await action(room.id,winner,'feedback',feedback)).status,409);
      assert.equal((await action(room.id,loser,'feedback',feedback)).status,409);
      assert.equal((await action(room.id,host,'feedback',{...feedback,targetId:host.id})).status,400);
      const rep=(await req('/api/teams/mine',host)).data.reputation;assert.equal(rep.samples,1);assert.equal(rep.again,1);assert.equal(rep.kind,'feedback');
    });
    await t.test('举报保存证据快照、去重、不能自动处罚、管理员自己事件不能审核', async () => {
      const reported=await action(room.id,winner,'report',{kind:'广告招募 / 引流',reason:'测试招募说明含有需要核实的广告'});assert.equal(reported.status,200);reportId=reported.data.reportId;
      assert.equal((await action(room.id,winner,'report',{kind:'广告招募 / 引流',reason:'重复举报不能累加'})).status,409);
      assert.equal((await action(room.id,host,'report',{kind:'其他不当内容',reason:'不能举报自己'})).status,400);
      assert.equal((await req('/api/team-admin',winner)).status,403);
      assert.equal((await req('/api/teams/mine',host)).data.restriction,null);
      const data=(await req('/api/team-admin',admin)).data;assert.equal(data.reports[0].snapshot.messages.length,1);assert.equal(data.reports[0].status,'pending');
      assert.equal((await post('/api/team-admin/restrict',admin,{reportId,expiresAt:Date.now()+60000,recovery:'本地测试复核恢复条件',reason:'未经核实不应当允许限制'})).status,409);
      await action(room.id,admin,'report',{kind:'其他不当内容',reason:'管理员本人提交的举报不能自行审理'});
      const selfReport=(await req('/api/team-admin',admin)).data.reports.find(r=>r.actorId===admin.id);
      assert.equal((await post('/api/team-admin/review',admin,{id:selfReport.id,status:'verified',reason:'本人提交的举报不能自行核实'})).status,403);
    });
    await t.test('核实、明确期限限制、申诉、恢复，付费账户与服务资料不受牵连', async () => {
      assert.equal((await post('/api/team-admin/review',admin,{id:reportId,status:'verified',reason:'本地合成案例已核对招募与消息记录'})).status,200);
      assert.equal((await post('/api/team-admin/restrict',admin,{reportId,expiresAt:Date.now()+3600000,recovery:'复核相关记录或到期恢复',reason:'合成测试案例设置有期限的组队限制'})).status,200);
      assert.equal((await post('/api/teams',host,fields)).status,403);
      assert.equal((await req('/api/provider',host)).status,200);
      assert.equal(db.prepare('SELECT role FROM user WHERE id=?').get(host.id).role,'user');
      assert.equal((await post('/api/teams/appeal',winner,{reason:'没有限制不能申诉'})).status,409);
      const appeal=await post('/api/teams/appeal',host,{reason:'本地测试提出申诉要求核对'});assert.equal(appeal.status,200);appealId=appeal.data.appealId;
      assert.equal((await post('/api/teams/appeal',host,{reason:'同一限制不能重复申诉'})).status,409);
      assert.equal((await req('/api/teams/mine',host)).data.restriction.reportId,reportId);
      assert.equal((await post('/api/team-admin/appeal',admin,{id:appealId,status:'accepted',reason:'本地核对完成，接受申诉恢复组队'})).status,200);
      assert.equal((await req('/api/teams/mine',host)).data.restriction,null);
    });
    await t.test('退出撤销消息权限、撤回重申及屏蔽只影响本人', async () => {
      const fresh=(await post('/api/teams',host,{...fields,title:'退出权限验证'})).data.roomId;
      await action(fresh,winner,'join',{note:'申请'});await action(fresh,host,'accept',{userId:winner.id});
      assert.equal((await action(fresh,winner,'leave')).status,200);
      assert.equal((await req(`/api/teams/${fresh}/messages`,winner)).status,403);
      await action(fresh,winner,'join',{note:'重新申请'});assert.equal((await action(fresh,winner,'withdraw')).status,200);
      assert.equal((await action(fresh,host,'withdraw')).status,409);
      assert.equal((await action(fresh,outsider,'block')).status,200);
      assert.ok(!(await req('/api/teams',outsider)).data.rooms.some(r=>r.id===fresh));
      assert.ok((await req('/api/teams')).data.rooms.some(r=>r.id===fresh));
      await action(fresh,outsider,'unblock');assert.ok((await req('/api/teams',outsider)).data.rooms.some(r=>r.id===fresh));
    });
    await t.test('历史清除鉴权、幂等、账号隔离与重新入队；进行中不能清除', async () => {
      assert.equal((await post('/api/teams/history',null)).status,401);
      assert.equal((await req('/api/teams/history',host,{requestId:randomUUID()},'https://invalid.example.test')).status,403);
      assert.equal((await action(room.id,outsider,'dismiss')).status,403);
      const fresh=(await req('/api/teams/mine',host)).data.teams.find(d=>d.room.status==='open').room.id;
      assert.equal((await action(fresh,host,'dismiss')).status,409);
      const request={requestId:randomUUID()};
      assert.equal((await req(`/api/teams/${room.id}/actions/dismiss`,winner,request)).status,200);
      assert.equal((await req(`/api/teams/${room.id}/actions/dismiss`,winner,request)).status,200);
      assert.ok(!(await req('/api/teams/mine',winner)).data.teams.some(d=>d.room.id===room.id));
      assert.ok((await req('/api/teams/mine',host)).data.teams.some(d=>d.room.id===room.id));
      assert.equal((await req(`/api/teams/${room.id}/messages`,winner)).data.messages.length,1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM team_reports WHERE room_id=?').get(room.id).n,2);
      assert.equal((await post('/api/teams/history',host,{userId:winner.id})).status,200);
      assert.ok(!(await req('/api/teams/mine',host)).data.teams.some(d=>d.room.id===room.id));
      assert.ok((await req('/api/teams/mine',host)).data.teams.some(d=>d.room.id===fresh));
      assert.equal((await action(fresh,winner,'dismiss')).status,200);
      assert.ok(!(await req('/api/teams/mine',winner)).data.teams.some(d=>d.room.id===fresh));
      assert.equal((await action(fresh,winner,'join')).status,200);
      assert.ok((await req('/api/teams/mine',winner)).data.teams.some(d=>d.room.id===fresh));
      assert.equal(db.prepare('SELECT 1 FROM team_history_hidden WHERE user_id=? AND room_id=?').get(winner.id,fresh),undefined);
      assert.equal((await action(fresh,winner,'withdraw')).status,200);
    });
    await t.test('数据库备份恢复包含组队、消息、反馈、举报、申诉和原会话', async () => {
      await stop();
      const snapshot=path.join(directory,'backup-populated'),recovery=path.join(directory,'restore-populated');
      createSnapshot(directory,snapshot);restoreSnapshot(snapshot,recovery);
      const restored=await createAuth({baseURL:base,dataDirectory:recovery,environment:'test'});
      try {
        assert.equal((await restored.auth.api.getSession({headers:new Headers({cookie:host.cookie})})).user.id,host.id);
        for(const table of ['team_rooms','team_messages','team_feedback','team_reports','team_appeals','team_requests','team_history_hidden']) assert.ok(restored.database.prepare('SELECT count(*) AS n FROM '+table).get().n>0,table);
        assert.equal(restored.database.prepare('PRAGMA quick_check').get().quick_check,'ok');
      } finally {restored.database.close();}
      await start();
    });
    await t.test('游标分页无重复，关键词通配符作为文字处理，申请留言不公开', async () => {
      const payload={...fields,title:'分页夹具',intro:'测试分页，不是实际招募'};
      for(let i=0;i<43;i++) db.prepare("INSERT INTO team_rooms VALUES (?,?,'open',?,?,NULL,0)").run(randomUUID(),outsider.id,JSON.stringify({...payload,title:i===0?'百分号%演练':'分页夹具'+i}),10000+i);
      const first=(await req('/api/teams')).data;assert.equal(first.rooms.length,40);assert.ok(first.next);
      const second=(await req('/api/teams?before='+encodeURIComponent(first.next))).data;
      assert.equal(second.rooms.length,4);assert.equal(second.next,null);
      assert.ok(first.rooms.every(r=>!second.rooms.some(s=>s.id===r.id)));
      assert.equal((await req('/api/teams?q=%25')).data.rooms.length,1);
      assert.equal((await req('/api/teams?before=9007199254740993:bad')).status,400);
      assert.ok(!JSON.stringify(first).includes('仅房主可以看到的申请留言'));
    });
    await t.test('重启后会话、招募、消息、反馈、举报和申诉均保存；外键完整', async () => {
      await stop();await start();
      assert.equal((await req('/api/teams/'+room.id,winner)).data.membership.state,'ended');
      assert.equal((await req(`/api/teams/${room.id}/messages`,winner)).data.messages.length,1);
      assert.equal((await req('/api/teams/mine',host)).data.reputation.samples,1);
      assert.ok(!(await req('/api/teams/mine',host)).data.teams.some(d=>d.room.id===room.id));
      assert.ok(!(await req('/api/teams/mine',winner)).data.teams.some(d=>d.room.id===room.id));
      assert.equal((await req('/api/teams/mine',host)).data.appeals[0].status,'accepted');
      assert.equal((await req('/api/team-admin',admin)).data.reports.find(r=>r.id===reportId).status,'verified');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
      assert.ok(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'team_%'").get().n>10);
      assert.ok(db.prepare("SELECT 1 FROM app_migrations WHERE id='004-free-teams'").get());
      assert.equal((await req('/api/health')).status,200);
    });
  } finally {
    await stop();const resolved=realpathSync(directory);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('delta-teams-http-'));rmSync(resolved,{recursive:true});
  }
});
