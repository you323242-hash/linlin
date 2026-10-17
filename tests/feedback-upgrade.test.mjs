import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createAuth} from '../server/auth.mjs';
import {createMarket} from '../server/market.mjs';
import {createTeams} from '../server/teams.mjs';
import {createSecurity} from '../server/security.mjs';
import {createEvidence} from '../server/evidence.mjs';
import {createPersonas} from '../server/personas.mjs';
import {createFeedback} from '../server/feedback.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {createEncryptedSnapshot,restoreEncryptedSnapshot} from '../scripts/secure-backup.mjs';

test('012旧库加密恢复后演练013：原表内容、密码会话密钥保持，迁移幂等',async()=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(path.join(parent,'delta-feedback-upgrade-'));
 const source=path.join(root,'source'),backup=path.join(root,'backup'),restored=path.join(root,'restored'),key=randomBytes(32);
 let db,providers;
 const previous=process.env.BETTER_AUTH_SECRET;delete process.env.BETTER_AUTH_SECRET;
 const hash=v=>createHash('sha256').update(v).digest('hex');
 const fingerprints=database=>Object.fromEntries(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('app_migrations','sqlite_sequence') ORDER BY name").all().map(({name})=>[name,hash(JSON.stringify(database.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()))]));
 const noAdmin=()=>{throw Error('No administrator in upgrade fixture');};
 try{
  const created=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:source,environment:'test'});db=created.database;
  providers=createLocalProviders({directory:source});const market=createMarket(db,providers);
  createTeams(db);createSecurity(db,created.auth);createEvidence(db,market,providers.storage);createPersonas(db);
  const account=await created.auth.api.signUpEmail({body:{email:'feedback-upgrade@example.test',name:'升级合成账户',password:'Synthetic-upgrade-password-2026!',termsAccepted:true},returnHeaders:true});
  const cookie=account.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const {order}=await market.command(account.response.user,'create',{mode:'secret',requestId:'upgrade-order',rulesAccepted:true});
  const before=fingerprints(db),secretHash=hash(readFileSync(path.join(source,'auth-secret')));
  assert.equal(db.prepare("SELECT count(*) n FROM app_migrations WHERE id='013-site-feedback'").get().n,0);
  providers.close();providers=null;db.close();db=null;
  await createEncryptedSnapshot(source,backup,key);await restoreEncryptedSnapshot(backup,restored,key);
  db=new DatabaseSync(path.join(restored,'auth.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual(fingerprints(db),before);
  createFeedback(db,{assertAdmin:noAdmin});createFeedback(db,{assertAdmin:noAdmin});
  const after=fingerprints(db);for(const [table,fingerprint] of Object.entries(before))assert.equal(after[table],fingerprint,table);
  assert.equal(db.prepare("SELECT count(*) n FROM app_migrations WHERE id='013-site-feedback'").get().n,1);
  assert.equal(db.prepare('SELECT id FROM orders WHERE id=?').get(order.id).id,order.id);
  assert.equal(hash(readFileSync(path.join(restored,'auth-secret'))),secretHash);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();db=null;
  const reopened=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:restored,environment:'test'});db=reopened.database;
  assert.equal((await reopened.auth.api.getSession({headers:new Headers({cookie})})).user.id,account.response.user.id);
  const original=new DatabaseSync(path.join(source,'auth.sqlite'),{readOnly:true});try{assert.deepEqual(fingerprints(original),before);assert.equal(original.prepare("SELECT count(*) n FROM app_migrations WHERE id='013-site-feedback'").get().n,0);}finally{original.close();}
 }finally{
  providers?.close();db?.close();if(previous===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=previous;
  const resolved=realpathSync(root);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('delta-feedback-upgrade-'));rmSync(resolved,{recursive:true});
 }
});
