import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAuth} from '../server/auth.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {createMarket} from '../server/market.mjs';
import {createTeams} from '../server/teams.mjs';
import {createPersonas} from '../server/personas.mjs';
import {createFeedback} from '../server/feedback.mjs';
import {createPrivacyGrants} from '../server/privacy-grants.mjs';

test('真实密码复验与一次性交付资格隔离专项',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'delta-r148-grants-')),baseURL='http://127.0.0.1:4188';
 const {auth,database:db}=await createAuth({baseURL,dataDirectory:dir,environment:'test',requireEmailVerification:false});
 const providers=createLocalProviders({directory:dir});createMarket(db,providers);createTeams(db);createPersonas(db);createFeedback(db,{assertAdmin:()=>{throw Error('NO_ADMIN');}});
 const password='Disposable-copy-grants-2026!';let clock=Date.now();
 const signIn=async email=>{const response=await auth.api.signInEmail({body:{email,password},asResponse:true,headers:new Headers({origin:baseURL})});assert.equal(response.status,200);return new Headers({origin:baseURL,cookie:response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')});};
 const grants=()=>createPrivacyGrants(db,auth,{now:()=>clock});
 try{
  for(const email of ['grant-a@example.test','grant-b@example.test']){const response=await auth.api.signUpEmail({body:{email,password,name:'合成副本账号',termsAccepted:true},asResponse:true,headers:new Headers({origin:baseURL})});assert.equal(response.status,200);}
  const a=await signIn('grant-a@example.test'),b=await signIn('grant-b@example.test');let guard=grants();
  await t.test('匿名和错误密码不能签发，令牌只存摘要且日志无凭据',async()=>{
   await assert.rejects(guard.issue(new Headers(),password),e=>e.status===401);await assert.rejects(guard.issue(a,'Wrong-password-123456!'),e=>e.status===403);
   const proof=await guard.issue(a,password);const rows=db.prepare("SELECT * FROM verification WHERE identifier LIKE 'privacy-copy:%'").all();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(proof.token));
   const logs=JSON.stringify(db.prepare("SELECT * FROM audit_events WHERE action LIKE 'privacy_copy_%'").all());assert.ok(!logs.includes(password));assert.ok(!logs.includes(proof.token));
  });
  await t.test('跨账号和同账号另一会话不能领取；并发两次只有一次成功',async()=>{
   const proof=await guard.issue(a,password),otherSession=await signIn('grant-a@example.test');
   await assert.rejects(guard.consume(b,proof.token),e=>e.status===403);await assert.rejects(guard.consume(otherSession,proof.token),e=>e.status===403);
   const results=await Promise.allSettled([guard.consume(a,proof.token),guard.consume(a,proof.token)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const copy=results.find(r=>r.status==='fulfilled').value;assert.equal(copy.sections.account.email,'grant-a@example.test');assert.equal(copy.complete,false);
  });
  await t.test('重建工具保持凭据，过期拒绝，新签发令旧资格失效',async()=>{
   clock+=600001;const old=await guard.issue(a,password),fresh=await guard.issue(a,password);guard=grants();await assert.rejects(guard.consume(a,old.token),e=>e.status===403);await guard.consume(a,fresh.token);
   const expiring=await guard.issue(a,password);clock+=300001;await assert.rejects(guard.consume(a,expiring.token),e=>e.status===403);
  });
  await t.test('生成或审计失败不返回成功且可恢复重试',async()=>{
   clock+=600001;const proof=await guard.issue(a,password);const failing=createPrivacyGrants(db,auth,{now:()=>clock,prepare:()=>{throw Error('SYNTHETIC_PREPARE_FAIL');}});
   await assert.rejects(failing.consume(a,proof.token),/SYNTHETIC_PREPARE_FAIL/);
   db.exec("CREATE TRIGGER test_privacy_audit BEFORE INSERT ON audit_events WHEN NEW.action='privacy_copy_prepared_for_delivery' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_AUDIT_FAIL'); END");
   try{await assert.rejects(guard.consume(a,proof.token),/SYNTHETIC_AUDIT_FAIL/);}finally{db.exec('DROP TRIGGER test_privacy_audit');}
   await guard.consume(a,proof.token);
  });
  await t.test('异步附件失败可重试，读取期间密码变化或退出均阻止交付',async()=>{
   clock+=600001;const proof=await guard.issue(a,password);
   const failed=createPrivacyGrants(db,auth,{now:()=>clock,enrich:async()=>{throw Error('SYNTHETIC_STORAGE_FAIL');}});
   await assert.rejects(failed.consume(a,proof.token),/SYNTHETIC_STORAGE_FAIL/);await guard.consume(a,proof.token);
   const changed=await guard.issue(a,password),subject=await auth.api.getSession({headers:a});
   const saved=db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").get(subject.user.id).password;
   const passwordChanged=createPrivacyGrants(db,auth,{now:()=>clock,enrich:async copy=>{
    await Promise.resolve();db.prepare("UPDATE account SET password=? WHERE userId=? AND providerId='credential'").run('SYNTHETIC_ASYNC_CHANGE',subject.user.id);return copy;
   }});
   try{await assert.rejects(passwordChanged.consume(a,changed.token),e=>e.status===403);}finally{db.prepare("UPDATE account SET password=? WHERE userId=? AND providerId='credential'").run(saved,subject.user.id);}
   const temporary=await signIn('grant-a@example.test'),logoutProof=await guard.issue(temporary,password);
   const loggedOut=createPrivacyGrants(db,auth,{now:()=>clock,enrich:async copy=>{await auth.api.signOut({headers:temporary});return copy;}});
   await assert.rejects(loggedOut.consume(temporary,logoutProof.token),e=>e.status===401);
  });
  await t.test('限频跨工具重建仍有效，密码变化或退出撤销下载资格',async()=>{
   clock+=600001;const proof=await guard.issue(a,password);const subject=await auth.api.getSession({headers:a});
   const saved=db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").get(subject.user.id).password;
   db.prepare("UPDATE account SET password=? WHERE userId=? AND providerId='credential'").run('CHANGED_SYNTHETIC',subject.user.id);
   await assert.rejects(guard.consume(a,proof.token),e=>e.status===403);db.prepare("UPDATE account SET password=? WHERE userId=? AND providerId='credential'").run(saved,subject.user.id);
   for(let i=0;i<4;i++)await assert.rejects(guard.issue(a,'Wrong-password-123456!'),e=>e.status===403);
   guard=grants();await assert.rejects(guard.issue(a,password),e=>e.status===429);
   await auth.api.signOut({headers:a});await assert.rejects(guard.consume(a,proof.token),e=>e.status===401);
  });
  await t.test('真实认证库修改密码后旧资格失效',async()=>{
   clock+=600001;const proof=await guard.issue(b,password);
   await auth.api.changePassword({headers:b,body:{currentPassword:password,newPassword:'Disposable-changed-copy-2026!',revokeOtherSessions:false}});
   await assert.rejects(guard.consume(b,proof.token),e=>e.status===403||e.status===401);
  });
 }finally{providers.close();db.close();}
});
