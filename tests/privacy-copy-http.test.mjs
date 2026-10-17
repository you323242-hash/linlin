import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {JPEG} from './avatar-fixture.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('本人部分副本HTTP来源、权限、下载与重放边界',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'delta-r149-http-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const base=`http://127.0.0.1:${port}`,password='Disposable-http-copy-2026!';
 const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:dir,PORT:String(port),BETTER_AUTH_URL:base},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const call=async(route,cookie='',body,headers={},method=body===undefined?'GET':'POST')=>{
  const r=await fetch(base+route,{method,headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,data:await r.json(),headers:r.headers,cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
 };
 const proof='/api/privacy/copy/proof',download='/api/privacy/copy/download';
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('HTTP_FIXTURE_TIMEOUT')),15000);child.stderr.on('data',()=>{});child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('HTTP_FIXTURE_EXIT'));});});
  const a=await call('/api/auth/sign-up/email','',{name:'本人HTTP甲',email:'copy-http-a@example.test',password,termsAccepted:true});assert.equal(a.status,200);
  const b=await call('/api/auth/sign-up/email','',{name:'本人HTTP乙',email:'copy-http-b@example.test',password,termsAccepted:true});assert.equal(b.status,200);
  await t.test('匿名、跨站、非JSON、查询凭据和客户端身份拒绝',async()=>{
   assert.equal((await call(proof,'',{password})).status,401);
   assert.equal((await call(proof,a.cookie,{password},{Origin:'https://other.example'})).status,403);
   assert.equal((await call(proof,a.cookie,{password},{Origin:''})).status,403);
   assert.equal((await call(proof,a.cookie,{password},{'Content-Type':'text/plain'})).status,403);
   assert.equal((await call(proof+'?token=forbidden',a.cookie,{password})).status,400);
   assert.equal((await call(proof,a.cookie,{password,userId:b.data.user.id})).status,400);
   assert.equal((await call(proof,a.cookie)).status,405);
   assert.equal((await call(proof,a.cookie,{password:'x'.repeat(2100)})).status,413);
   assert.equal((await call('/api/auth/verify-password',a.cookie,{password})).status,404);
  });
  await t.test('密码复验、本人附件下载无缓存，跨账号和并发重放拒绝',async()=>{
   assert.equal((await call(proof,a.cookie,{password:'wrong-password-2026!'})).status,403);
   const p=await call(proof,a.cookie,{password});assert.equal(p.status,200);assert.equal(p.headers.get('cache-control'),'no-store');assert.ok(p.data.token);
   assert.equal((await call(download,b.cookie,{token:p.data.token})).status,403);
   const responses=await Promise.all([call(download,a.cookie,{token:p.data.token}),call(download,a.cookie,{token:p.data.token})]);
   assert.deepEqual(responses.map(r=>r.status).sort(),[200,403]);
   const r=responses.find(r=>r.status===200);assert.equal(r.data.complete,false);assert.equal(r.data.deliveryAvailable,true);assert.ok(r.data.excluded.length);
   assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-disposition'),/attachment; filename="qingbo-personal-partial-copy.json"/);
   assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.ok(!JSON.stringify(r.data).includes(password));
  });
  await t.test('经真实头像上传接口提交的本人图片通过领取接口原样返回',async()=>{
   const saved=await call('/api/persona',a.cookie,{theme:'tactical',cover:'coast',avatar:'initial',operator:'none',texture:'none',motion:'off',gender:'unspecified',signature:'本人HTTP图片',bio:'',style:'',maps:['AZ3'],modes:['机密行动'],version:0,avatarAction:'replace',avatarContent:JPEG,backgroundAction:'keep'});assert.equal(saved.status,200);
   const p=await call(proof,a.cookie,{password});assert.equal(p.status,200);
   const r=await call(download,a.cookie,{token:p.data.token});assert.equal(r.status,200);
   const shown=await fetch(base+'/api/avatars/'+a.data.user.id,{headers:{Cookie:a.cookie}});assert.equal(shown.status,200);const stored=Buffer.from(await shown.arrayBuffer());
   const image=r.data.sections.ownUploadedImages.find(i=>i.kind==='social-avatar');assert.ok(image);assert.deepEqual(Buffer.from(image.contentBase64,'base64'),stored);assert.notDeepEqual(stored,Buffer.from(JPEG,'base64'));assert.equal(r.data.complete,false);
   assert.equal(r.headers.get('cache-control'),'no-store');
  });
  await t.test('真实发布的招募标签数组可领取，另一房主游戏ID不进入副本',async()=>{
   const fields={title:'副本招募验证',intro:'',when:'现在可开始',need:1,mode:'机密行动',style:'任务协作',mic:'text',tags:'友善沟通,清晰报点',selfTags:'耐心配合',agree:true};
   const other=await call('/api/teams',a.cookie,{...fields,gameId:'OTHER_HOST_PRIVATE_GAME',requestId:randomUUID()});assert.equal(other.status,200);
   const own=await call('/api/teams',b.cookie,{...fields,gameId:'OWN_HOST_GAME',requestId:randomUUID()});assert.equal(own.status,200);
   const p=await call(proof,b.cookie,{password});assert.equal(p.status,200);
   const r=await call(download,b.cookie,{token:p.data.token});assert.equal(r.status,200);
   assert.equal(r.data.sections.hostedTeams.length,1);assert.equal(r.data.sections.hostedTeams[0].id,own.data.roomId);
   assert.deepEqual(r.data.sections.hostedTeams[0].settings.tags,['友善沟通','清晰报点']);
   assert.deepEqual(r.data.sections.hostedTeams[0].settings.selfTags,['耐心配合']);
   assert.equal(r.data.sections.hostedTeams[0].settings.gameId,'OWN_HOST_GAME');
   assert.ok(!JSON.stringify(r.data).includes('OTHER_HOST_PRIVATE_GAME'));assert.equal(r.data.complete,false);
   assert.equal((await call(download,b.cookie,{token:p.data.token})).status,403);
  });
  await t.test('真实保存的本人接单资料和匹配偏好进入副本，另一账号资料排除',async()=>{
   const prefs={desiredTags:['耐心配合'],matchNote:'本人偏好说明',preferTrial:true};
   assert.equal((await call('/api/preferences',b.cookie,{...prefs,requestId:randomUUID()})).status,200);
   const profile={adult:true,gameId:'OWN_PROVIDER_GAME',introduction:'本人接单介绍',modes:['secret'],stats:{secret:{kd:1.8,gear:4}},tags:['清晰报点'],trialAvailable:true,available:false};
   assert.equal((await call('/api/provider',b.cookie,{...profile,requestId:randomUUID()})).status,200);
   assert.equal((await call('/api/preferences',a.cookie,{desiredTags:[],matchNote:'OTHER_MATCH_PRIVATE',preferTrial:false,requestId:randomUUID()})).status,200);
   const p=await call(proof,b.cookie,{password});assert.equal(p.status,200);
   const r=await call(download,b.cookie,{token:p.data.token});assert.equal(r.status,200);
   assert.deepEqual(r.data.sections.ownMatchingPreferences,[prefs]);assert.deepEqual(r.data.sections.ownServiceProfiles,[profile]);
   assert.ok(!JSON.stringify(r.data).includes('OTHER_MATCH_PRIVATE'));assert.equal(r.data.complete,false);
  });
  await t.test('本人举报申诉反馈通过现有密码领取HTTP交付，他人和审核字段排除',async()=>{
   const db=new DatabaseSync(path.join(dir,'auth.sqlite')),now=Date.now(),own=a.data.user.id,other=b.data.user.id;
   try{
    db.prepare('INSERT INTO team_rooms(id,owner_id,status,payload,created_at,ended_at) VALUES(?,?,?,?,?,?)').run('copy-feedback-room',own,'ended','{"title":"副本隔离记录","need":1}',now,now);
    db.prepare('INSERT INTO team_feedback VALUES(?,?,?,?,?)').run('copy-feedback-room',own,other,'{"again":"愿意再次组队","secret":"HTTP_PRIVATE_REVIEW"}',now);
    const report=db.prepare('INSERT INTO team_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    report.run('copy-own-report','copy-feedback-room',own,other,'conduct','本人提交说明','{"secret":"HTTP_PRIVATE_SNAPSHOT"}','pending','HTTP_PRIVATE_DECISION',other,now,null);
    report.run('copy-other-report','copy-feedback-room',other,own,'conduct','HTTP_PRIVATE_OTHER_REPORT','{}','verified','',other,now,now);
    db.prepare('INSERT INTO team_appeals VALUES(?,?,?,?,?,?,?,?)').run('copy-own-appeal',own,'copy-other-report','本人申诉说明','pending','HTTP_PRIVATE_APPEAL_DECISION',now,null);
   }finally{db.close();}
   const p=await call(proof,a.cookie,{password});assert.equal(p.status,200);
   const r=await call(download,a.cookie,{token:p.data.token});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
   assert.deepEqual(r.data.sections.ownTeamFeedback,[{roomId:'copy-feedback-room',createdAt:now,settings:{again:'愿意再次组队'}}]);
   assert.deepEqual(r.data.sections.ownTeamReports.map(row=>row.id),['copy-own-report']);
   assert.deepEqual(r.data.sections.ownTeamAppeals.map(row=>row.id),['copy-own-appeal']);
   assert.equal(r.data.complete,false);
   for(const marker of [other,'HTTP_PRIVATE_REVIEW','HTTP_PRIVATE_SNAPSHOT','HTTP_PRIVATE_DECISION','HTTP_PRIVATE_OTHER_REPORT','HTTP_PRIVATE_APPEAL_DECISION'])assert.ok(!JSON.stringify(r.data).includes(marker));
   assert.equal((await call(download,b.cookie,{token:p.data.token})).status,403);
  });
  await t.test('本人售后附件通过HTTP原样交付，缺文件失败后同资格可重试',async()=>{
   const bytes=Buffer.from(JPEG,'base64'),sha=createHash('sha256').update(bytes).digest('hex'),db=new DatabaseSync(path.join(dir,'auth.sqlite')),now=Date.now();
   try{
    db.prepare('INSERT INTO orders(id,buyer_id,provider_id,status,payload,created_at) VALUES(?,?,?,?,?,?)').run('copy-evidence-order',a.data.user.id,b.data.user.id,'completed','{}',now);
    const insert=db.prepare('INSERT INTO evidence_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run('copy-own-file','copy-evidence-order','case-test',a.data.user.id,'request-own-file','fingerprint','copy-own-file.jpg','本人.jpg','image/jpeg',bytes.length,sha,'本人附件说明',now);
    insert.run('copy-other-file','copy-evidence-order','case-test',b.data.user.id,'request-other-file','fingerprint','copy-other-file.jpg','OTHER_FILENAME_PRIVATE','image/jpeg',bytes.length,sha,'OTHER_SUMMARY_PRIVATE',now);
   }finally{db.close();}
   const p=await call(proof,a.cookie,{password});assert.equal(p.status,200);
   assert.equal((await call(download,a.cookie,{token:p.data.token})).status,409);
   writeFileSync(path.join(dir,'storage','copy-own-file.jpg'),bytes,{mode:0o600});
   const r=await call(download,a.cookie,{token:p.data.token});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
   const files=r.data.sections.ownEvidenceUploads;assert.equal(files.length,1);assert.equal(files[0].id,'copy-own-file');assert.equal(files[0].sha256,sha);
   assert.deepEqual(Buffer.from(files[0].contentBase64,'base64'),bytes);assert.equal(r.data.complete,false);
   for(const marker of ['copy-other-file','OTHER_FILENAME_PRIVATE','OTHER_SUMMARY_PRIVATE','copy-own-file.jpg'])assert.ok(!JSON.stringify(r.data).includes(marker));
   assert.equal((await call(download,a.cookie,{token:p.data.token})).status,403);
  });
  await t.test('错误密码耗尽后429提供十分钟恢复提示',async()=>{
   let r;for(let i=0;i<4;i++)r=await call(proof,a.cookie,{password:'incorrect-password-2026!'});
   assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'600');assert.equal(r.headers.get('cache-control'),'no-store');
  });
 }finally{if(child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});}
});
