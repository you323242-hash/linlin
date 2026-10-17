import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {prepareOwnPrivacyCopy} from '../server/privacy-copy.mjs';
import {JPEG} from './avatar-fixture.mjs';

test('本人副本准备：真实模型、白名单、双人角色、完整性与未开放交付',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'delta-r147-copy-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const base=`http://127.0.0.1:${port}`;let db;
 const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:dir,PORT:String(port),BETTER_AUTH_URL:base},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const call=async(route,cookie='',body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:base,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};};
 const signature=()=>{const h=createHash('sha256');for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()){const quoted='"'+name.replaceAll('"','""')+'"';h.update(JSON.stringify([name,db.prepare('SELECT * FROM '+quoted).all().map(r=>JSON.stringify(r)).sort()]));}return h.digest('hex');};
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('COPY_FIXTURE_TIMEOUT')),15000);child.stderr.on('data',()=>{});child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('COPY_FIXTURE_EXIT'));});});
  const users=[];for(let i=0;i<3;i++){const r=await call('/api/auth/sign-up/email','',{name:'副本测试'+i,email:`copy${i}@example.test`,password:'Disposable-copy-test-2026!',termsAccepted:true});assert.equal(r.status,200);users.push(r);}
  const [a,b,c]=users,own=a.data.user.id,other=b.data.user.id,third=c.data.user.id;db=new DatabaseSync(path.join(dir,'auth.sqlite'));const now=Date.now();
  const persona=JSON.stringify({signature:'本人签名',maps:['AZ3'],gender:'female',secret:'UNKNOWN_PAYLOAD_SECRET'});
  db.prepare('INSERT INTO user_personas(user_id,payload,updated_at) VALUES(?,?,?)').run(own,persona,now);
  db.prepare('INSERT INTO provider_personas(user_id,payload,updated_at) VALUES(?,?,?)').run(own,persona,now);
  const post=db.prepare('INSERT INTO persona_posts(id,user_id,text,created_at,deleted_at) VALUES(?,?,?,?,?)');post.run('own-post',own,'本人照片说明',now,null);post.run('removed-post',own,'REMOVED_PRIVATE',now,now);post.run('other-post',other,'OTHER_PRIVATE',now,null);
  db.prepare('INSERT INTO team_rooms(id,owner_id,status,payload,created_at) VALUES(?,?,?,?,?)').run('room',own,'open',JSON.stringify({title:'本人房间',need:1,gameId:'本人游戏ID',extra:'OTHER_PRIVATE'}),now);
  const member=db.prepare('INSERT INTO team_members VALUES(?,?,?,?,?,?)');member.run('room',own,'confirmed','本人留言',now,now);member.run('room',other,'confirmed','OTHER_PRIVATE',now,now);
  const message=db.prepare('INSERT INTO team_messages(room_id,user_id,content,created_at) VALUES(?,?,?,?)');message.run('room',own,'本人消息',now);message.run('room',other,'OTHER_PRIVATE',now);
  db.prepare('INSERT INTO site_feedback(id,user_id,request_id,payload_hash,category,content,created_at,updated_at,privacy_kind) VALUES(?,?,?,?,?,?,?,?,?)').run('request',own,'request-copy','hash','suggestion','本人复制请求',now,now,'export');
  const order=db.prepare('INSERT INTO orders(id,buyer_id,provider_id,status,payload,created_at) VALUES(?,?,?,?,?,?)');
  for(const [id,buyer,provider] of [['buyer',own,other],['provider',other,own],['second',other,third],['released',other,third],['unrelated',other,third]])order.run(id,buyer,provider,'completed',JSON.stringify({private:'OTHER_PRIVATE'}),now);
  db.prepare('INSERT INTO order_providers(order_id,user_id,live) VALUES(?,?,1)').run('second',own);db.prepare('INSERT INTO released_services VALUES(?,?,?)').run('released',own,'{"private":"OTHER_PRIVATE"}');
  await t.test('只返回本人字段，不返回另一方记录、嵌套未知字段或凭据',()=>{
   const before=signature(),copy=prepareOwnPrivacyCopy(db,own),encoded=JSON.stringify(copy);
   assert.equal(copy.complete,false);assert.equal(copy.deliveryAvailable,false);assert.equal(copy.sections.socialCard[0].settings.gender,'female');assert.equal(copy.sections.paidCard.length,1);
   assert.equal(copy.sections.ownVisiblePosts.length,1);assert.equal(copy.sections.ownTeamMessages.length,1);assert.equal(copy.sections.ownRequests.length,1);
   for(const marker of ['OTHER_PRIVATE','REMOVED_PRIVATE','UNKNOWN_PAYLOAD_SECRET',other,third])assert.ok(!encoded.includes(marker));
   for(const table of ['account','session'])for(const row of db.prepare('SELECT * FROM '+table).all())for(const key of ['password','token'])if(row[key])assert.ok(!encoded.includes(row[key]));
   assert.equal(signature(),before);
  });
  await t.test('本人组队反馈举报申诉进入副本，目标身份和审核快照不外泄',()=>{
   db.exec('SAVEPOINT own_team_requests');try{
    const feedback=db.prepare('INSERT INTO team_feedback VALUES(?,?,?,?,?)');
    feedback.run('room',own,other,JSON.stringify({again:'愿意再次组队',communication:'沟通顺畅',reliable:'配合可靠',secret:'UNKNOWN_REVIEW_PRIVATE'}),now);
    feedback.run('room',other,own,JSON.stringify({again:'OTHER_REVIEW_PRIVATE'}),now);
    const report=db.prepare('INSERT INTO team_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    report.run('own-report','room',own,other,'conduct','本人举报说明','{"secret":"REVIEW_SNAPSHOT_PRIVATE"}','pending','REVIEW_DECISION_PRIVATE',third,now,null);
    report.run('other-report','room',other,own,'conduct','OTHER_REPORT_PRIVATE','{}','verified','',third,now,now);
    const appeal=db.prepare('INSERT INTO team_appeals VALUES(?,?,?,?,?,?,?,?)');
    appeal.run('own-appeal',own,'other-report','本人申诉说明','pending','APPEAL_DECISION_PRIVATE',now,null);
    appeal.run('other-appeal',other,'own-report','OTHER_APPEAL_PRIVATE','pending','',now,null);
    const before=signature(),copy=prepareOwnPrivacyCopy(db,own),sections=copy.sections;
    assert.deepEqual(sections.ownTeamFeedback,[{roomId:'room',createdAt:now,settings:{again:'愿意再次组队',communication:'沟通顺畅',reliable:'配合可靠'}}]);
    assert.deepEqual(sections.ownTeamReports.map(row=>({...row})),[{id:'own-report',roomId:'room',kind:'conduct',reason:'本人举报说明',status:'pending',createdAt:now,reviewedAt:null}]);
    assert.deepEqual(sections.ownTeamAppeals.map(row=>({...row})),[{id:'own-appeal',reportId:'other-report',reason:'本人申诉说明',status:'pending',createdAt:now,reviewedAt:null}]);
    for(const marker of [other,third,'OTHER_REVIEW_PRIVATE','OTHER_REPORT_PRIVATE','OTHER_APPEAL_PRIVATE','UNKNOWN_REVIEW_PRIVATE','REVIEW_SNAPSHOT_PRIVATE','REVIEW_DECISION_PRIVATE','APPEAL_DECISION_PRIVATE'])assert.ok(!JSON.stringify(copy).includes(marker));
    assert.equal(signature(),before);assert.equal(copy.complete,false);
    db.prepare('UPDATE team_feedback SET payload=? WHERE actor_id=?').run('{"again":{"secret":"HIDDEN"}}',own);
    const broken=signature();assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);assert.equal(signature(),broken);
   }finally{db.exec('ROLLBACK TO own_team_requests');db.exec('RELEASE own_team_requests');}
   assert.equal(prepareOwnPrivacyCopy(db,own).sections.ownTeamFeedback.length,0);
  });
  await t.test('买方、服务者、第二服务者和已释放服务历史均列入本人摘要',()=>{
   const orders=prepareOwnPrivacyCopy(db,own).sections.orderReferences;assert.deepEqual(orders.map(o=>o.id).sort(),['buyer','provider','released','second']);assert.equal(orders.find(o=>o.id==='buyer').asBuyer,1);assert.equal(orders.find(o=>o.id==='second').asProvider,1);
  });
  await t.test('订单本人贡献以明确作者及数据库买方归属，双人同角色和释放后新内容不混入',()=>{
   db.exec('SAVEPOINT own_order_contributions');try{
    const payload={buyerId:other,messages:[{actorId:own,role:'provider',actorName:'HIDDEN_NAME',text:'本人订单消息',time:'2026-10-14T00:00:00Z'},{actorId:other,role:'provider',text:'OTHER_SAME_ROLE_PRIVATE',time:'2026-10-14T00:00:00Z'},{role:'provider',text:'LEGACY_UNKNOWN_PRIVATE'}],review:{attitude:5,communication:4,experience:3,text:'本人买方评价',unknown:'UNKNOWN_REVIEW_PRIVATE'},cancelHistory:[{by:own,reason:'本人取消说明',at:now,result:'declined',accepted:[other]},{by:other,reason:'OTHER_CANCEL_PRIVATE',at:now}],case:{id:'own-case',kind:'complaint',openedBy:own,openedAt:now,description:'本人售后说明',context:{expectation:'explanation',occurredWhen:'结束后',secret:'PRIVATE_CONTEXT'},evidence:['UNATTRIBUTED_EVIDENCE_PRIVATE'],proposal:{reason:'OTHER_PROPOSAL_PRIVATE'},notes:[{actorId:own,role:'provider',text:'本人补充材料说明',time:now},{actorId:other,role:'provider',text:'OTHER_CASE_NOTE_PRIVATE',time:now},{role:'provider',text:'LEGACY_CASE_NOTE_PRIVATE',time:now}]}};
    for(const id of ['buyer','second'])db.prepare('UPDATE orders SET payload=? WHERE id=?').run(JSON.stringify(payload),id);
    db.prepare('UPDATE released_services SET payload=? WHERE order_id=?').run(JSON.stringify({...payload,messages:[{actorId:own,text:'本人释放前消息',time:'2026-10-14T00:00:00Z'}],review:{text:'OTHER_RELEASE_REVIEW_PRIVATE'}}),'released');
    db.prepare('UPDATE orders SET payload=? WHERE id=?').run(JSON.stringify({messages:[{actorId:own,text:'POST_RELEASE_PRIVATE'}]}),'released');
    db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?)').run(own,other,'message','AUDIT_REASON_PRIVATE',now);
    db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?)').run(other,own,'OTHER_AUDIT_PRIVATE','',now);
    const before=signature(),copy=prepareOwnPrivacyCopy(db,own),contributions=copy.sections.ownOrderContributions;
    const buyer=contributions.find(row=>row.orderId==='buyer'),second=contributions.find(row=>row.orderId==='second'),released=contributions.find(row=>row.orderId==='released');
    assert.deepEqual(buyer.messages,[{text:'本人订单消息',time:'2026-10-14T00:00:00Z'}]);
    assert.deepEqual(buyer.review,{text:'本人买方评价',attitude:5,communication:4,experience:3});assert.equal(second.review,null);
    assert.deepEqual(second.caseNotes,[{caseId:'own-case',text:'本人补充材料说明',time:now}]);
    assert.equal(buyer.cancellationRequests.length,1);assert.equal(buyer.caseSubmissions[0].description,'本人售后说明');
    assert.equal(released.messages[0].text,'本人释放前消息');assert.equal(released.review,null);
    assert.equal(copy.sections.ownAuditActions.filter(row=>row.action==='message').length,1);
    assert.ok(copy.sections.ownAuditActions.every(row=>Object.keys(row).sort().join(',')==='action,createdAt,id'));
    for(const marker of [other,third,'HIDDEN_NAME','OTHER_SAME_ROLE_PRIVATE','LEGACY_UNKNOWN_PRIVATE','UNKNOWN_REVIEW_PRIVATE','OTHER_CANCEL_PRIVATE','PRIVATE_CONTEXT','UNATTRIBUTED_EVIDENCE_PRIVATE','OTHER_PROPOSAL_PRIVATE','OTHER_CASE_NOTE_PRIVATE','LEGACY_CASE_NOTE_PRIVATE','OTHER_RELEASE_REVIEW_PRIVATE','POST_RELEASE_PRIVATE','AUDIT_REASON_PRIVATE','OTHER_AUDIT_PRIVATE'])assert.ok(!JSON.stringify(copy).includes(marker));
    assert.equal(signature(),before);assert.equal(copy.complete,false);
    db.prepare('UPDATE orders SET payload=? WHERE id=?').run(JSON.stringify({messages:[{actorId:own,text:{secret:'INVALID'}}]}),'buyer');
    const broken=signature();assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);assert.equal(signature(),broken);
    db.prepare('UPDATE orders SET payload=? WHERE id=?').run(JSON.stringify({messages:[],extra:'x'.repeat(5*1024*1024)}),'buyer');
    assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409&&e.message.includes('订单资料较多'));
   }finally{db.exec('ROLLBACK TO own_order_contributions');db.exec('RELEASE own_order_contributions');}
   assert.equal(prepareOwnPrivacyCopy(db,own).sections.ownOrderContributions.find(row=>row.orderId==='buyer').messages.length,0);
  });
  await t.test('本人头像背景与可见动态原图可还原，他人和已移除图片不进入副本',()=>{
   db.exec('SAVEPOINT own_images');try{
    const bytes=Buffer.from(JPEG,'base64');
    for(const table of ['user_personas','provider_personas'])db.prepare('UPDATE '+table+' SET avatar=?,background=? WHERE user_id=?').run(bytes,bytes,own);
    db.prepare('UPDATE persona_posts SET image=? WHERE id=?').run(bytes,'own-post');
    db.prepare('UPDATE persona_posts SET image=? WHERE id=?').run(Buffer.from('REMOVED_IMAGE_PRIVATE'),'removed-post');
    db.prepare('UPDATE persona_posts SET image=? WHERE id=?').run(Buffer.from('OTHER_IMAGE_PRIVATE'),'other-post');
    db.prepare('INSERT INTO user_personas(user_id,payload,avatar,updated_at) VALUES(?,?,?,?)').run(other,persona,Buffer.from('OTHER_AVATAR_PRIVATE'),now);
    const before=signature(),copy=prepareOwnPrivacyCopy(db,own),images=copy.sections.ownUploadedImages;
    assert.equal(images.length,5);assert.equal(copy.complete,false);assert.equal(signature(),before);
    for(const image of images){assert.equal(image.mime,'image/jpeg');assert.equal(image.byteLength,bytes.length);assert.deepEqual(Buffer.from(image.contentBase64,'base64'),bytes);assert.equal(image.sha256,createHash('sha256').update(bytes).digest('hex'));assert.match(image.fileName,/^[a-z0-9-]+\.jpg$/);}
    assert.deepEqual(images.filter(i=>i.kind==='post-image').map(i=>i.postId),['own-post']);
    assert.ok(!JSON.stringify(copy).includes(Buffer.from('OTHER_IMAGE_PRIVATE').toString('base64')));
   }finally{db.exec('ROLLBACK TO own_images');db.exec('RELEASE own_images');}
  });
  await t.test('过大的原图在读取前失败，损坏图片不伪称交付成功',()=>{
   db.exec('SAVEPOINT image_limit');try{
    db.prepare('UPDATE user_personas SET avatar=? WHERE user_id=?').run(Buffer.alloc(4*1024*1024),own);
    assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409&&e.message.includes('图片较多'));
    db.prepare('UPDATE user_personas SET avatar=? WHERE user_id=?').run(Buffer.from('bad-image'),own);
    assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409&&e.message.includes('图片记录'));
   }finally{db.exec('ROLLBACK TO image_limit');db.exec('RELEASE image_limit');}
  });
  await t.test('非法身份和异常嵌套资料失败关闭，未改变原库',()=>{
   assert.throws(()=>prepareOwnPrivacyCopy(db,null),e=>e.status===401);assert.throws(()=>prepareOwnPrivacyCopy(db,"' OR 1=1 --"),e=>e.status===404);
   db.prepare('UPDATE user_personas SET payload=? WHERE user_id=?').run('{"signature":{"token":"HIDDEN"}}',own);const before=signature();assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);assert.equal(signature(),before);
   db.prepare('UPDATE user_personas SET payload=? WHERE user_id=?').run('{invalid-json',own);assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);
   db.prepare('UPDATE user_personas SET payload=? WHERE user_id=?').run(persona,own);
  });
  await t.test('超过批量上限不悄悄截断，且失败后可以再次生成',()=>{
   db.exec('SAVEPOINT copy_limit');try{const insert=db.prepare('INSERT INTO team_messages(room_id,user_id,content,created_at) VALUES(?,?,?,?)');for(let i=0;i<5000;i++)insert.run('room',own,'合成上限测试',now+i);
   assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);}finally{db.exec('ROLLBACK TO copy_limit');db.exec('RELEASE copy_limit');}assert.equal(prepareOwnPrivacyCopy(db,own).sections.ownTeamMessages.length,1);
  });
  await t.test('招募空标签与上限标签保持，异常嵌套/过量/超长标签失败后可恢复',()=>{
   db.exec('SAVEPOINT room_tags');try{
    const update=settings=>db.prepare('UPDATE team_rooms SET payload=? WHERE id=?').run(JSON.stringify({title:'本人房间',need:1,...settings}),'room');
    update({tags:[],selfTags:[]});assert.deepEqual(prepareOwnPrivacyCopy(db,own).sections.hostedTeams[0].settings.tags,[]);
    const tags=Array.from({length:6},(_,i)=>String(i).repeat(12));update({tags,selfTags:tags});assert.deepEqual(prepareOwnPrivacyCopy(db,own).sections.hostedTeams[0].settings.selfTags,tags);
    for(const key of ['tags','selfTags'])for(const value of [[{secret:'HIDDEN'}],Array(7).fill('标签'),['长'.repeat(13)],'错误字符串']){
     update({[key]:value});const before=signature();assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);assert.equal(signature(),before);
    }
   }finally{db.exec('ROLLBACK TO room_tags');db.exec('RELEASE room_tags');}
   assert.equal(prepareOwnPrivacyCopy(db,own).sections.hostedTeams.length,1);
  });
  await t.test('本人接单和偏好白名单排除他人、未知嵌套与后台限制备注，异常不改变原库',()=>{
   db.exec('SAVEPOINT service_copy');try{
    const prefs={desiredTags:['耐心配合'],matchNote:'本人默认偏好',preferTrial:false};
    const service={gameId:'本人服务ID',introduction:'本人接单介绍',modes:['secret'],stats:{secret:{kd:2.1,gear:4}},tags:['清晰报点'],trialAvailable:true,adult:true,available:false};
    db.prepare('INSERT INTO user_preferences(user_id,payload) VALUES(?,?)').run(own,JSON.stringify({...prefs,unknown:'UNKNOWN_PREFERENCE_SECRET'}));
    db.prepare('INSERT INTO user_preferences(user_id,payload) VALUES(?,?)').run(other,JSON.stringify({...prefs,matchNote:'OTHER_PREFERENCE_PRIVATE'}));
    db.prepare('INSERT INTO provider_profiles(user_id,payload,reason) VALUES(?,?,?)').run(own,JSON.stringify({...service,stats:{secret:{...service.stats.secret,unknown:'UNKNOWN_STATS_SECRET'}},unknown:'UNKNOWN_SERVICE_SECRET'}),'INTERNAL_REVIEW_PRIVATE');
    db.prepare('INSERT INTO provider_profiles(user_id,payload) VALUES(?,?)').run(other,JSON.stringify({...service,gameId:'OTHER_SERVICE_PRIVATE'}));
    const before=signature(),copy=prepareOwnPrivacyCopy(db,own);assert.equal(signature(),before);
    assert.deepEqual(copy.sections.ownMatchingPreferences,[prefs]);assert.deepEqual(copy.sections.ownServiceProfiles,[service]);
    for(const marker of ['UNKNOWN_PREFERENCE_SECRET','OTHER_PREFERENCE_PRIVATE','UNKNOWN_STATS_SECRET','UNKNOWN_SERVICE_SECRET','INTERNAL_REVIEW_PRIVATE','OTHER_SERVICE_PRIVATE'])assert.ok(!JSON.stringify(copy).includes(marker));
    for(const stats of [null,[],{secret:{kd:'2.1',gear:4}},{secret:{kd:2.1,gear:4.5}},{secret:{kd:101,gear:4}}]){
     db.prepare('UPDATE provider_profiles SET payload=? WHERE user_id=?').run(JSON.stringify({...service,stats}),own);
     const original=signature();assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);assert.equal(signature(),original);
    }
    db.prepare('UPDATE provider_profiles SET payload=? WHERE user_id=?').run(JSON.stringify(service),own);
    db.prepare('UPDATE user_preferences SET payload=? WHERE user_id=?').run(JSON.stringify({...prefs,preferTrial:'false'}),own);
    assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);
   }finally{db.exec('ROLLBACK TO service_copy');db.exec('RELEASE service_copy');}
   assert.deepEqual(prepareOwnPrivacyCopy(db,own).sections.ownMatchingPreferences,[]);
  });
  await t.test('下载路径未开放，普通登录不能直接取得副本',async()=>{
   assert.equal((await call('/api/privacy/export',a.cookie)).status,404);assert.equal((await call('/api/privacy/export',a.cookie,{})).status,405);
  });
  await t.test('超过总字节上限明确拒绝，未写出明文或改变原记录',()=>{
   db.exec('SAVEPOINT copy_bytes');try{
    db.prepare('UPDATE persona_posts SET text=? WHERE id=?').run('大'.repeat(2*1024*1024),'own-post');const before=signature();assert.throws(()=>prepareOwnPrivacyCopy(db,own),e=>e.status===409);assert.equal(signature(),before);
   }finally{db.exec('ROLLBACK TO copy_bytes');db.exec('RELEASE copy_bytes');}
  });
 }finally{db?.close();if(child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});}
});
