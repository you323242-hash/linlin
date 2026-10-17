import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
test('端游手游隔离：大厅、详情、申请、聊天、名片及重启',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'qingbo-platform-test-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const base='http://127.0.0.1:'+port;let child;
 async function start(){child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:dir,PORT:String(port),BETTER_AUTH_URL:base},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('START_TIMEOUT')),15000);child.stderr.on('data',()=>{});child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('START_FAILED'));});});}
 async function stop(){if(child?.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});}
 async function call(route,cookie='',body,origin=base){const res=await fetch(base+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json(),cookie:res.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};}
 const fields={title:'合成平台招募',intro:'匹配测试',when:'在线等',need:1,mode:'机密行动',style:'正常配装',mic:'text',tags:'',selfTags:'',agree:true};
 const post=(route,cookie,body={})=>call(route,cookie,{...body,requestId:randomUUID()});
 try{
  await start();const users=[];for(let i=0;i<2;i++){const r=await call('/api/auth/sign-up/email','',{name:'平台测试'+i,email:'platform'+i+'@example.test',password:'Synthetic-platform-test-2026!',termsAccepted:true});assert.equal(r.status,200);users.push(r.cookie);}
  const [a,b]=users,pc=await post('/api/teams',a,{...fields,title:'端游招募',gameId:'PC_PRIVATE_ID'}),mobile=await post('/api/teams?channel=mobile',a,{...fields,title:'手游招募',gameId:'MOBILE_PRIVATE_ID'});assert.equal(pc.status,200);assert.equal(mobile.status,200);
  const pcId=pc.data.roomId,mobileId=mobile.data.roomId;
  await t.test('默认与历史为端游，筛选由后端隔离且非法渠道拒绝',async()=>{
   const db=new DatabaseSync(path.join(dir,'auth.sqlite'));try{const payload=JSON.parse(db.prepare('SELECT payload FROM team_rooms WHERE id=?').get(pcId).payload);delete payload.channel;db.prepare('UPDATE team_rooms SET payload=? WHERE id=?').run(JSON.stringify(payload),pcId);}finally{db.close();}
   assert.deepEqual((await call('/api/teams')).data.rooms.map(r=>r.id),[pcId]);assert.deepEqual((await call('/api/teams?channel=mobile')).data.rooms.map(r=>r.id),[mobileId]);
   assert.equal((await call('/api/teams?channel=qq')).status,400);
   assert.equal((await call('/api/teams/'+pcId+'?channel=mobile',a)).status,404);assert.equal((await call('/api/teams/'+mobileId,a)).status,404);
   assert.ok(!JSON.stringify((await call('/api/teams?channel=mobile')).data).includes('MOBILE_PRIVATE_ID'));
  });
  await t.test('申请确认和聊天不能跨平台，自己的工作区不混合',async()=>{
   assert.equal((await post('/api/teams/'+mobileId+'/actions/join',b,{note:'错误平台'})).status,404);
   assert.equal((await post('/api/teams/'+mobileId+'/actions/join?channel=mobile',b,{note:'手游申请'})).status,200);
   assert.equal((await call('/api/teams/mine',b)).data.teams.length,0);
   assert.equal((await call('/api/teams/mine?channel=mobile',b)).data.teams.length,1);
   const detail=await call('/api/teams/'+mobileId+'?channel=mobile',a),userId=detail.data.applicants[0].id;
   assert.equal((await post('/api/teams/'+mobileId+'/actions/accept?channel=mobile',a,{userId})).status,200);
   assert.equal((await post('/api/teams/'+mobileId+'/actions/message?channel=mobile',b,{message:'手游小队合成消息'})).status,200);
   assert.equal((await call('/api/teams/'+mobileId+'/messages',b)).status,404);
   assert.equal((await call('/api/teams/'+mobileId+'/messages?channel=mobile',b)).data.messages.length,1);
  });
  await t.test('每平台名片独立，游戏ID私有、版本冲突和来源检查保留',async()=>{
   const profile={version:0,cover:'coast',avatar:'male-a',gender:'male',maps:['零号大坝'],modes:['机密行动'],style:'正常配装',signature:'端游签名',bio:'端游介绍',gameId:'PC_PROFILE_PRIVATE'};
   assert.equal((await call('/api/teams/profile',a,profile)).status,200);
   assert.equal((await call('/api/teams/profile?channel=mobile',a)).data.profile.gameId,'');
   assert.equal((await call('/api/teams/profile?channel=mobile',a,{...profile,signature:'手游签名',gameId:'MOBILE_PROFILE_PRIVATE'})).status,200);
   assert.equal((await call('/api/teams/profile',a)).data.profile.signature,'端游签名');
   assert.equal((await call('/api/teams/profile?channel=mobile',a,profile)).status,409);
   assert.equal((await call('/api/teams/profile?channel=mobile',a,{...profile,version:1},'https://other.example')).status,403);
   assert.equal((await call('/api/teams/profile?channel=mobile',b)).data.profile.signature,'');
   const board=(await call('/api/teams?channel=mobile')).data;assert.equal(board.rooms[0].appearance.signature,'手游签名');assert.ok(!JSON.stringify(board).includes('PROFILE_PRIVATE'));
  });
  await t.test('资料副本含本人两平台设置，手游不读取端游空间',async()=>{
   assert.equal((await call('/api/persona-space/room/'+mobileId,a)).status,404);
   const proof=await call('/api/privacy/copy/proof',a,{password:'Synthetic-platform-test-2026!'});assert.equal(proof.status,200);
   const copy=await call('/api/privacy/copy/download',a,{token:proof.data.token});assert.equal(copy.status,200);
   assert.deepEqual(copy.data.sections.ownFreeGameProfiles.map(p=>p.channel),['mobile','pc']);
   assert.deepEqual(copy.data.sections.ownFreeGameProfiles.map(p=>p.settings.signature),['手游签名','端游签名']);
  });
  await stop();await start();
  await t.test('重启后渠道和资料保留，端游手游切换仍不混合',async()=>{
   assert.equal((await call('/api/teams/profile?channel=mobile',a)).data.profile.signature,'手游签名');
   assert.equal((await call('/api/teams/profile',a)).data.profile.signature,'端游签名');
   assert.deepEqual((await call('/api/teams/mine?channel=mobile',a)).data.teams.map(t=>t.room.id),[mobileId]);
   assert.deepEqual((await call('/api/teams/mine',a)).data.teams.map(t=>t.room.id),[pcId]);
  });
  await t.test('结束反馈按平台统计，清除手游历史不影响端游历史',async()=>{
   assert.equal((await post('/api/teams/'+mobileId+'/actions/end?channel=mobile',a)).status,200);
   assert.equal((await post('/api/teams/'+pcId+'/actions/end',a)).status,200);
   const owner=(await call('/api/teams/mine?channel=mobile',a)).data.user.id;
   assert.equal((await post('/api/teams/'+mobileId+'/actions/feedback?channel=mobile',b,{targetId:owner,again:'愿意再次组队',communication:'沟通友好、配合顺畅',reliable:'按约上线'})).status,200);
   assert.equal((await call('/api/teams/mine?channel=mobile',a)).data.reputation.samples,1);
   assert.equal((await call('/api/teams/mine',a)).data.reputation.samples,0);
   assert.equal((await post('/api/teams/history?channel=mobile',a)).status,200);
   assert.equal((await call('/api/teams/mine?channel=mobile',a)).data.teams.length,0);
   assert.equal((await call('/api/teams/mine',a)).data.teams.length,1);
  });
 }finally{await stop();}
});
