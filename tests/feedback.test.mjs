import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFeedback} from '../server/feedback.mjs';
import {BusinessError} from '../server/market.mjs';

test('网站意见：本人隔离、幂等、分页、管理校验、冲突和事务审计',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE user(id TEXT PRIMARY KEY);INSERT INTO user VALUES ('a'),('b'),('admin');
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY,actor_id TEXT,target_id TEXT,action TEXT,reason TEXT,created_at INTEGER);`);
  const a={user:{id:'a'}},b={user:{id:'b'}},admin={user:{id:'admin',role:'admin'}};
  let guards=0;
  const options={assertAdmin:s=>{guards++;if(s.user.role!=='admin')throw new BusinessError('拒绝',403);}};
  try {
    const f=createFeedback(db,options),body={category:'bug',content:'手机页面无法打开',requestId:'request-0001'};
    assert.throws(()=>f.submit(null,body),e=>e.status===401);
    assert.throws(()=>f.submit(a,{...body,content:'短'}),e=>e.status===400);
    const first=f.submit(a,body);
    assert.equal(f.submit(a,body).id,first.id);
    assert.throws(()=>f.submit(a,{...body,content:'内容已改变需要新的请求'}),e=>e.status===409);
    assert.equal(f.list(b).length,0);assert.equal(f.list(a).length,1);
    assert.ok(!('user_id' in f.list(a)[0]));assert.ok(!('payload_hash' in first));
    assert.throws(()=>f.list(a,{limit:51}),e=>e.status===400);
    assert.throws(()=>f.list(a,{admin:true}),e=>e.status===403);
    assert.throws(()=>f.handle(a,first.id,{status:'resolved',reason:'普通用户尝试处理',version:1}),e=>e.status===403);
    assert.throws(()=>f.handle(admin,first.id,{status:'resolved',reason:'',version:1}),e=>e.status===400);
    const working=f.handle(admin,first.id,{status:'handling',reason:'已经复现正在处理',version:1});
    assert.equal(working.version,2);
    assert.throws(()=>f.handle(admin,first.id,{status:'resolved',reason:'过期页面尝试处理',version:1}),e=>e.status===409);
    const done=f.handle(admin,first.id,{status:'resolved',reason:'修复并完成实际复测',version:2});
    assert.equal(done.history.length,3);assert.equal(done.status,'resolved');
    assert.throws(()=>f.handle(admin,first.id,{status:'handling',reason:'禁止倒退已结束状态',version:3}),e=>e.status===409);
    assert.equal(createFeedback(db,options).list(a)[0].status,'resolved');
    assert.equal(db.prepare('SELECT count(*) n FROM audit_events').get().n,3);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.ok(guards>=5);
    // Audit write failure must also roll back the opinion and its history.
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test audit failure'); END;");
    assert.throws(()=>f.submit(b,{...body,requestId:'request-0002'}));
    assert.equal(f.list(b).length,0);
    assert.equal(db.prepare('SELECT count(*) n FROM site_feedback_events').get().n,3);
  }finally{db.close();}
});
