import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { validateAvatar } from '../server/personas.mjs';
import { JPEG } from './avatar-fixture.mjs';

test('头像拒绝脚本、超限和截断图片，并去除EXIF与注释', () => {
  for (const value of ['<svg/>',Buffer.from('<svg/>').toString('base64'),JPEG.slice(0,-8), 'A'.repeat(180000)]) assert.throws(()=>validateAvatar(value));
  const source=Buffer.from(JPEG,'base64'), metadata=Buffer.from('EXIF-GPS-PRIVATE');
  const app=Buffer.alloc(metadata.length+4);app[0]=255;app[1]=225;app.writeUInt16BE(metadata.length+2,2);metadata.copy(app,4);
  const cleaned=validateAvatar(Buffer.concat([source.subarray(0,2),app,source.subarray(2)]).toString('base64'));
  assert.ok(!cleaned.includes(metadata));assert.equal(cleaned[0],255);assert.equal(cleaned.at(-1),217);
});

test('名片真实HTTP：本人权限、并发版本、上传删除、审计与重启恢复',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'delta-persona-http-'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base=`http://127.0.0.1:${port}`;let child,db;
  const start=async()=>{child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env:{...process.env,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('名片服务启动超时')),20000);child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timeout);resolve();}});child.once('exit',c=>{clearTimeout(timeout);reject(Error('服务启动失败 '+c));});});db=new DatabaseSync(path.join(dir,'auth.sqlite'));};
  const stop=async()=>{db?.close();db=null;if(child?.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});};
  const req=async(route,user,body,origin=base)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{...(user?{Cookie:user.cookie}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};};
  const fields={theme:'aurora',cover:'grove',avatar:'fox',operator:'none',texture:'contour',motion:'off',signature:'友善沟通，默契配合',bio:'本地合成资料',style:'任务协作',maps:['零号大坝'],modes:['机密行动'],version:0,avatarAction:'keep'};
  try{
    await start();const users=[];for(let i=0;i<2;i++){const r=await req('/api/auth/sign-up/email',null,{name:'名片验收'+i,email:`persona${i}@example.test`,password:'Persona-test-only-2026!',termsAccepted:true});assert.equal(r.status,200);users.push({...r.data.user,cookie:r.cookie});}const [a,b]=users;
    await t.test('匿名拒绝，跨站写入拒绝，忽略伪造用户ID',async()=>{
      assert.equal((await req('/api/persona')).status,401);assert.equal((await req('/api/persona',null,fields)).status,401);
      assert.equal((await req('/api/persona',a,fields,'https://evil.test')).status,403);
      assert.equal((await req('/api/persona',a,{...fields,userId:b.id})).status,200);
      assert.equal((await req('/api/persona',a)).data.persona.signature,fields.signature);
      assert.equal((await req('/api/persona',b)).data.persona.signature,'');
      assert.equal(db.prepare('SELECT count(*) n FROM audit_events WHERE action=?').get('persona_saved').n,1);
    });
    await t.test('非法选择、重复地图与脚本头像被拒，过期版本不覆盖',async()=>{
      assert.equal((await req('/api/persona',a,{...fields,version:1,operator:'../../secret'})).status,400);
      assert.equal((await req('/api/persona',a,{...fields,version:1,maps:['零号大坝','零号大坝']})).status,400);
      assert.equal((await req('/api/persona',a,{...fields,version:1,avatarAction:'replace',avatarContent:Buffer.from('<svg onload="alert(1)"/>').toString('base64')})).status,400);
      assert.equal((await req('/api/persona',a,fields)).status,409);
    });
    let avatarURL;
    await t.test('两个同版本保存只有一个成功，头像以受限图片响应',async()=>{
      const responses=await Promise.all([req('/api/persona',a,{...fields,version:1,avatarAction:'replace',avatarContent:JPEG}),req('/api/persona',a,{...fields,version:1,avatarAction:'replace',avatarContent:JPEG})]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);avatarURL=responses.find(r=>r.status===200).data.persona.avatarUrl;
      const r=await fetch(base+avatarURL);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/jpeg');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-security-policy'),/sandbox/);assert.equal(r.headers.get('cache-control'),'no-store');
      assert.ok((await r.arrayBuffer()).byteLength>32);
    });
    await t.test('重启后登录与名片恢复，选择默认头像移除旧图片',async()=>{
      await stop();await start();const saved=await req('/api/persona',a);assert.equal(saved.status,200);assert.equal(saved.data.persona.version,2);assert.equal(saved.data.persona.avatarUrl,avatarURL);
      assert.equal((await req('/api/persona',a,{...fields,version:2,avatarAction:'default'})).status,200);
      assert.equal((await fetch(base+avatarURL)).status,404);
      assert.equal((await req('/api/persona',a)).data.persona.avatarUrl,null);
      assert.equal(db.prepare('SELECT count(*) n FROM audit_events WHERE action=?').get('persona_saved').n,3);
    });
    await t.test('AZ3前后端目录一致，保存与重启恢复，未知地图仍拒绝',async()=>{
      const {CARD_MAPS}=await import('../dist/people-cards.mjs');
      const {MAPS}=await import('../server/personas.mjs');
      assert.deepEqual(CARD_MAPS,MAPS);assert.ok(MAPS.includes('AZ3'));
      const registered=await req('/api/auth/sign-up/email',null,{name:'地图验收',email:'az3-map@example.test',password:'Persona-test-only-2026!',termsAccepted:true});assert.equal(registered.status,200);
      const mapUser={...registered.data.user,cookie:registered.cookie};
      assert.equal((await req('/api/persona',mapUser,{...fields,maps:['AZ3']})).status,200);
      await stop();await start();assert.deepEqual((await req('/api/persona',mapUser)).data.persona.maps,['AZ3']);
      assert.equal((await req('/api/persona',mapUser,{...fields,version:1,maps:['不存在的地图']})).status,400);
    });
    await t.test('背景与性别保存，陪玩名片资格与独立数据，图文权限和重启恢复',async()=>{
      assert.equal((await req('/api/persona?kind=paid',b)).status,403);
      assert.equal((await req('/api/persona?kind=paid',b,fields)).status,403);
      const social=await req('/api/persona',b,{...fields,gender:'female',avatar:'female-a',backgroundAction:'replace',backgroundContent:JPEG});assert.equal(social.status,200);
      assert.equal(social.data.persona.gender,'female');assert.equal((await fetch(base+social.data.persona.backgroundUrl)).status,200);
      assert.equal((await req('/api/provider',b,{requestId:'persona-provider-setup-58',adult:true,gameId:'SYNTHETIC',introduction:'测试资料',modes:['secret'],stats:{secret:{kd:1.2,gear:4}},available:false})).status,200);
      const paid=await req('/api/persona?kind=paid',b,{...fields,signature:'陪玩服务签名',gender:'male',avatar:'male-a'});assert.equal(paid.status,200);
      assert.equal((await req('/api/persona',b)).data.persona.signature,fields.signature);assert.equal((await req('/api/persona?kind=paid',b)).data.persona.signature,'陪玩服务签名');
      assert.equal((await req('/api/persona-space/'+b.id)).status,401);
      assert.equal((await req('/api/persona-space',b,{action:'publish',text:'战绩图文'},'https://evil.test')).status,403);
      const published=await req('/api/persona-space',b,{action:'publish',text:'<script>战绩</script>\n合成图文',imageContent:JPEG,userId:a.id});assert.equal(published.status,200);const post=published.data.posts[0];
      assert.equal((await fetch(base+post.imageUrl)).status,401);assert.equal((await fetch(base+post.imageUrl,{headers:{cookie:a.cookie}})).status,200);
      assert.equal((await req('/api/persona-space/'+a.id,a)).data.posts.length,0);
      assert.equal((await req('/api/persona-space',a,{action:'delete',id:post.id})).status,404);
      await stop();await start();assert.equal((await req('/api/persona-space/'+b.id,b)).data.posts[0].id,post.id);assert.equal((await req('/api/persona',b)).data.persona.gender,'female');
      assert.equal((await req('/api/persona-space',b,{action:'delete',id:post.id})).data.posts.length,0);assert.equal((await fetch(base+post.imageUrl,{headers:{cookie:b.cookie}})).status,404);
    });
  }finally{await stop();const target=realpathSync(dir);assert.equal(path.dirname(target),realpathSync(tmpdir()));assert.ok(path.basename(target).startsWith('delta-persona-'));rmSync(target,{recursive:true,force:true});}
});

