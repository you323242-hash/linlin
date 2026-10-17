import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAuth} from '../server/auth.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {createMarket} from '../server/market.mjs';
import {createTeams} from '../server/teams.mjs';
import {createPersonas} from '../server/personas.mjs';
import {createFeedback} from '../server/feedback.mjs';
import {createPrivacyGrants} from '../server/privacy-grants.mjs';

test('隔离旧快照恢复：原会话保留但已消费副本资格不能重放',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'delta-r151-restore-')),baseURL='http://127.0.0.1:4191',password='Synthetic-restore-copy-2026!';
 const config={baseURL,dataDirectory:dir,environment:'test',requireEmailVerification:false};
 let state=await createAuth(config),db=state.database,providers=createLocalProviders({directory:dir});
 try{
  createMarket(db,providers);createTeams(db);createPersonas(db);createFeedback(db,{assertAdmin:()=>{throw Error('NO_ADMIN');}});
  const r=await state.auth.api.signUpEmail({body:{name:'恢复合成账号',email:'restore-copy@example.test',password,termsAccepted:true},asResponse:true,headers:new Headers({origin:baseURL})});assert.equal(r.status,200);
  const headers=new Headers({origin:baseURL,cookie:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')});
  const guard=createPrivacyGrants(db,state.auth),proof=await guard.issue(headers,password);
  // Test-only snapshot, no real user files or production database.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const snapshot=path.join(dir,'synthetic-before-consumption.sqlite');copyFileSync(path.join(dir,'auth.sqlite'),snapshot);
  await createPrivacyGrants(db,state.auth).consume(headers,proof.token);
  await assert.rejects(guard.consume(headers,proof.token),e=>e.status===403);
  providers.close();providers=null;db.close();db=null;
  copyFileSync(snapshot,path.join(dir,'auth.sqlite'));
  state=await createAuth(config);db=state.database;
  assert.ok(await state.auth.api.getSession({headers,query:{disableCookieCache:true}}));
  assert.equal(db.prepare("SELECT count(*) n FROM verification WHERE identifier LIKE 'privacy-copy:%'").get().n,1);
  const restored=createPrivacyGrants(db,state.auth);await assert.rejects(restored.consume(headers,proof.token),e=>e.status===403);
  const fresh=await restored.issue(headers,password),copy=await restored.consume(headers,fresh.token);
  assert.equal(copy.sections.account.email,'restore-copy@example.test');assert.equal(copy.complete,false);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{providers?.close();db?.close();}
});
