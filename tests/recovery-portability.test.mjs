import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,renameSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import {createAuth} from '../server/auth.mjs';
import {prepareRuntimeDirectory} from '../server/config.mjs';
import {createMarket} from '../server/market.mjs';
import {createFeedback} from '../server/feedback.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {createTeams} from '../server/teams.mjs';
import {createPersonas} from '../server/personas.mjs';
import {createPrivacyGrants} from '../server/privacy-grants.mjs';
import {JPEG} from './avatar-fixture.mjs';
import {createEncryptedSnapshot,restoreEncryptedSnapshot} from '../scripts/secure-backup.mjs';

test('合成加密备份移至新目录且原目录离线后，真实HTTP身份与订单恢复',async t=>{
  const parent=realpathSync(tmpdir()),root=mkdtempSync(path.join(parent,'delta-portable-'));
  const source=path.join(root,'source'),target=path.join(root,'new-host-data'),backup=path.join(root,'encrypted');
  const key=randomBytes(32),secret=randomBytes(48).toString('base64url'),ref='isolated/portable',password=`Portable-${randomUUID()}!`,email=`portable-${randomUUID()}@example.test`;
  const oldSecret=process.env.BETTER_AUTH_SECRET;
  let child,sourceDatabase,sourceGuard;
  t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}sourceDatabase?.close();if(oldSecret===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=oldSecret;const resolved=realpathSync(root);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('delta-portable-'));rmSync(resolved,{recursive:true});});
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}`;
  process.env.BETTER_AUTH_SECRET=secret;
  prepareRuntimeDirectory({dataDirectory:source,environment:'test'});
  const {auth,database}=await createAuth({baseURL:base,dataDirectory:source,environment:'test',requireEmailVerification:false});
  sourceDatabase=database;
  const providers=createLocalProviders({directory:source});
  let user,order,cookie,feedbackId,privacyRows,privacyAudit,copyProof,storedImage;
  const privacyBodies=['correction','export','closure'].map(kind=>({category:'privacy-'+kind,content:'合成恢复隐私请求 '+kind,requestId:'portable-'+kind}));
  try {
    const registered=await auth.api.signUpEmail({body:{name:'合成恢复用户',email,password,termsAccepted:true},returnHeaders:true});
    user=registered.response.user;cookie=registered.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
    ({order}=await createMarket(database,providers).command(user,'create',{mode:'secret',rulesAccepted:true,requestId:'portable-order'}));
    createTeams(database);
    const personas=createPersonas(database);
    personas.save(user,{theme:'tactical',cover:'coast',avatar:'initial',operator:'none',texture:'none',motion:'off',gender:'unspecified',signature:'合成恢复名片',bio:'',style:'',maps:['AZ3'],modes:['机密行动'],version:0,avatarAction:'replace',avatarContent:JPEG,backgroundAction:'replace',backgroundContent:JPEG});
    personas.post(user,{action:'publish',text:'合成恢复图文',imageContent:JPEG});
    storedImage=Buffer.from(personas.avatar(user.id));
    const opinions=createFeedback(database,{assertAdmin:()=>{throw Error('No administrator actions in this fixture');}});
    feedbackId=opinions.submit({user},{category:'bug',content:'合成备份恢复中的网站意见',requestId:'portable-feedback'}).id;
    privacyRows=privacyBodies.map(body=>JSON.parse(JSON.stringify(opinions.submit({user},body))));
    privacyAudit=database.prepare("SELECT target_id,action,reason,created_at FROM audit_events WHERE actor_id=? AND action='privacy_request_submitted' ORDER BY target_id").all(user.id).map(row=>({...row}));
    assert.equal(privacyAudit.length,3);
    writeFileSync(path.join(source,'storage','portable-fixture'),'synthetic storage only');
    sourceGuard=createPrivacyGrants(database,auth);
    copyProof=await sourceGuard.issue(new Headers({origin:base,cookie}),password);
  }finally{providers.close();}
  await createEncryptedSnapshot(source,backup,key,{authSecret:secret,authKeyRef:ref});
  // Consume after snapshot creation, then restore the earlier encrypted state.
  const consumed=await sourceGuard.consume(new Headers({origin:base,cookie}),copyProof.token);assert.equal(consumed.sections.ownUploadedImages.length,3);
  await assert.rejects(sourceGuard.consume(new Headers({origin:base,cookie}),copyProof.token),e=>e.status===403);
  database.close();sourceDatabase=null;
  await restoreEncryptedSnapshot(backup,target,key,{authSecret:secret,authKeyRef:ref});
  renameSync(source,path.join(root,'source-offline'));
  assert.equal(readFileSync(path.join(target,'storage','portable-fixture'),'utf8'),'synthetic storage only');
  const keyfile=path.join(root,'separate-backup-key');writeFileSync(keyfile,key.toString('hex'),{mode:0o600});
  const env={...process.env,APP_ENV:'test',NODE_ENV:'test',AUTH_DATA_DIR:target,PORT:String(port),BETTER_AUTH_URL:base,BETTER_AUTH_SECRET:secret,AUTH_KEY_REF:ref,BACKUP_KEY_FILE:keyfile};
  for(const name of ['STAGING_ACCESS_TOKEN','ALLOW_STAGING_MOCKS','AUTH_REQUIRE_EMAIL_VERIFICATION','AUTH_PHONE_MODE','TRUSTED_PROXY_IPS'])delete env[name];
  child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',b=>logs+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('isolated restore startup timeout')),15000);child.stdout.on('data',b=>{if(String(b).includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('isolated restore exited '+code));});});
  const get=async route=>{const response=await fetch(base+route,{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json();};
  const postCopy=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  assert.equal((await get('/api/me')).user.id,user.id);
  assert.equal((await postCopy('/api/privacy/copy/download',{token:copyProof.token})).status,403);
  const fresh=await postCopy('/api/privacy/copy/proof',{password});assert.equal(fresh.status,200);
  const downloaded=await postCopy('/api/privacy/copy/download',{token:fresh.data.token});assert.equal(downloaded.status,200);
  assert.equal(downloaded.data.complete,false);assert.equal(downloaded.data.sections.ownUploadedImages.length,3);
  for(const image of downloaded.data.sections.ownUploadedImages)assert.deepEqual(Buffer.from(image.contentBase64,'base64'),storedImage);
  assert.equal(downloaded.data.sections.ownVisiblePosts[0].text,'合成恢复图文');
  assert.equal((await postCopy('/api/privacy/copy/download',{token:fresh.data.token})).status,403);
  assert.ok((await get('/api/orders')).orders.some(row=>row.id===order.id));
  const opinions=(await get('/api/site-feedback')).feedback;
  assert.equal(opinions.length,4);const ordinary=opinions.find(row=>row.id===feedbackId);
  assert.equal(ordinary.content,'合成备份恢复中的网站意见');
  assert.equal(ordinary.history[0].reason,'用户提交网站意见');
  for(const original of privacyRows){assert.deepEqual(opinions.find(row=>row.id===original.id),original);}
  const restoredDb=new DatabaseSync(path.join(target,'auth.sqlite'),{readOnly:true});
  try{
    assert.equal(restoredDb.prepare("SELECT count(*) n FROM app_migrations WHERE id='014-privacy-requests'").get().n,1);
    assert.equal(restoredDb.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.deepEqual(restoredDb.prepare("SELECT target_id,action,reason,created_at FROM audit_events WHERE actor_id=? AND action='privacy_request_submitted' ORDER BY target_id").all(user.id).map(row=>({...row})),privacyAudit);
  }finally{restoredDb.close();}
  for(let i=0;i<privacyBodies.length;i++){const repeat=await fetch(base+'/api/site-feedback',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(privacyBodies[i])});assert.equal(repeat.status,200);assert.deepEqual((await repeat.json()).feedback,privacyRows[i]);}
  assert.equal((await get('/api/site-feedback')).feedback.length,4);
  const denied=await fetch(base+'/api/site-feedback/admin',{headers:{Cookie:cookie}});assert.equal(denied.status,403);
  const login=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(login.status,200);assert.equal((await login.json()).user.id,user.id);
  assert.ok(!logs.includes(secret)&&!logs.includes(password));
});
