import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createFeedback} from '../server/feedback.mjs';
import {migrate} from '../server/migrations.mjs';

test('013旧意见原内容和幂等保持，014隐私请求不执行账号/证据操作',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("PRAGMA foreign_keys=ON;CREATE TABLE user(id TEXT PRIMARY KEY);INSERT INTO user VALUES ('a'),('b'),('admin');CREATE TABLE audit_events(id INTEGER PRIMARY KEY,actor_id TEXT,target_id TEXT,action TEXT,reason TEXT,created_at INTEGER);");
 const a={user:{id:'a'}},b={user:{id:'b'}},admin={user:{id:'admin'}};
 const guard=s=>{if(s.user.id!=='admin')throw Object.assign(Error('forbidden'),{status:403});};
 try{
  const sql=readFileSync(new URL('../server/feedback.mjs',import.meta.url),'utf8').match(/migrate\(db,'013-site-feedback',`([\s\S]*?)`\);/)[1];migrate(db,'013-site-feedback',sql);
  const old={category:'bug',content:'旧版意见不得改变',requestId:'legacy-opinion'};
  const hash=createHash('sha256').update(JSON.stringify([old.category,old.content])).digest('hex');
  db.prepare('INSERT INTO site_feedback VALUES (?,?,?,?,?,?,?,?,?,?)').run('old','a',old.requestId,hash,'bug',old.content,'pending',1,1,1);
  const original=db.prepare('SELECT * FROM site_feedback').get();
  let f=createFeedback(db,{assertAdmin:guard});const migrated=db.prepare('SELECT * FROM site_feedback').get();
  assert.equal(migrated.privacy_kind,null);delete migrated.privacy_kind;assert.deepEqual(migrated,original);
  assert.equal(f.submit(a,old).id,'old');
  for(const kind of ['correction','export','closure']){
   const body={category:'privacy-'+kind,content:'请处理本人隐私请求，不包含敏感凭据',requestId:'privacy-'+kind,userId:'b',status:'resolved'};
   const row=f.submit(a,body);assert.equal(row.category,body.category);assert.equal(row.status,'pending');assert.equal(f.submit(a,body).id,row.id);
   assert.throws(()=>f.submit(a,{...body,category:'privacy-export',content:'不同内容的重复编号'}),e=>e.status===409);
   assert.equal(f.list(b).length,0);assert.throws(()=>f.handle(b,row.id,{version:1,status:'resolved',reason:'冒名处理隐私请求'}),e=>e.status===403);
   const done=f.handle(admin,row.id,{version:1,status:'resolved',reason:'已答复申请；未执行账号注销或数据删除'});assert.equal(done.status,'resolved');
   assert.equal(db.prepare('SELECT count(*) n FROM user').get().n,3);
   assert.throws(()=>f.handle(admin,row.id,{version:2,status:'handling',reason:'不能回退已答复状态'}),e=>e.status===409);
  }
  assert.throws(()=>f.submit(a,{category:'privacy-delete-all',content:'非法隐私请求类型',requestId:'invalid-privacy'}),e=>e.status===400);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE action='privacy_request_submitted'").get().n,3);
  f=createFeedback(db,{assertAdmin:guard});assert.equal(f.list(a).length,4);
  assert.equal(db.prepare("SELECT count(*) n FROM app_migrations WHERE id='014-privacy-requests'").get().n,1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{db.close();}
});
