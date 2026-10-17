import {randomUUID,createHash} from 'node:crypto';
import {migrate} from './migrations.mjs';
import {BusinessError} from './market.mjs';
import {inspectClosureDependencies} from './privacy-lifecycle.mjs';

// Website suggestions are separate from order disputes and never move money.
export function createFeedback(db,{assertAdmin,now=Date.now}={}) {
  if(typeof assertAdmin!=='function')throw Error('FEEDBACK_ADMIN_GUARD_REQUIRED');
  migrate(db,'013-site-feedback',`
CREATE TABLE site_feedback (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id),
 request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('bug','experience','suggestion')),
 content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','handling','resolved','rejected')),
 version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, UNIQUE(user_id,request_id)
);
CREATE INDEX site_feedback_owner ON site_feedback(user_id,created_at);
CREATE TABLE site_feedback_events (
 id INTEGER PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES site_feedback(id),
 actor_id TEXT NOT NULL REFERENCES user(id), status TEXT NOT NULL,
 reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
`);
  migrate(db,'014-privacy-requests',`ALTER TABLE site_feedback ADD COLUMN privacy_kind TEXT CHECK(privacy_kind IS NULL OR privacy_kind IN ('correction','export','closure'));`);
  const actor=s=>{if(!s?.user?.id)throw new BusinessError('请先登录。',401);return s.user.id;};
  const text=(v,min,max)=>typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max;
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  function view(row) {
    return {id:row.id,category:row.privacy_kind?'privacy-'+row.privacy_kind:row.category,content:row.content,status:row.status,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,
      history:db.prepare('SELECT status,reason,created_at AS createdAt FROM site_feedback_events WHERE feedback_id=? ORDER BY id').all(row.id)};
  }
  function submit(session,body={}) {
    const user=actor(session);
    const privacyKind=['privacy-correction','privacy-export','privacy-closure'].includes(body.category)?body.category.slice(8):null;
    if((!privacyKind&&!['bug','experience','suggestion'].includes(body.category))||!text(body.content,5,2000)||!text(body.requestId,8,80))throw new BusinessError('请选择类型并填写5—2000字意见。',400);
    const content=body.content.trim(),request=body.requestId.trim(),hash=createHash('sha256').update(JSON.stringify([body.category,content])).digest('hex');
    return transaction(()=>{
      const previous=db.prepare('SELECT * FROM site_feedback WHERE user_id=? AND request_id=?').get(user,request);
      if(previous){if(previous.payload_hash!==hash)throw new BusinessError('重复请求内容不一致。',409);return view(previous);}
      const id=randomUUID(),time=now();
      db.prepare('INSERT INTO site_feedback(id,user_id,request_id,payload_hash,category,content,created_at,updated_at,privacy_kind) VALUES (?,?,?,?,?,?,?,?,?)').run(id,user,request,hash,privacyKind?'suggestion':body.category,content,time,time,privacyKind);
      db.prepare('INSERT INTO site_feedback_events(feedback_id,actor_id,status,reason,created_at) VALUES (?,?,?,?,?)').run(id,user,'pending',privacyKind?'用户提交隐私请求；受理不等于执行删除或导出':'用户提交网站意见',time);
      db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(user,id,privacyKind?'privacy_request_submitted':'feedback_submitted',privacyKind?'提交隐私请求；不自动执行删除/导出':'提交网站意见；不涉及订单资金',time);
      return view(db.prepare('SELECT * FROM site_feedback WHERE id=?').get(id));
    });
  }
  function list(session,{admin=false,offset=0,limit=20}={}) {
    const user=actor(session);if(admin)assertAdmin(session);
    if(!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new BusinessError('分页参数无效。',400);
    const rows=admin?db.prepare('SELECT * FROM site_feedback ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(limit,offset):db.prepare('SELECT * FROM site_feedback WHERE user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(user,limit,offset);
    return rows.map(view);
  }
  function handle(session,id,body={}) {
    const user=actor(session);assertAdmin(session);
    if(!['handling','resolved','rejected'].includes(body.status)||!text(body.reason,5,500)||!Number.isSafeInteger(body.version))throw new BusinessError('请选择处理状态并填写5—500字原因。',400);
    return transaction(()=>{
      const row=db.prepare('SELECT * FROM site_feedback WHERE id=?').get(id);
      if(!row)throw new BusinessError('意见不存在。',404);
      if(row.version!==body.version||['resolved','rejected'].includes(row.status))throw new BusinessError('意见已更新或结束，请刷新查看。',409);
      if(row.status===body.status)throw new BusinessError('状态未改变。',409);
      const time=now();
      db.prepare('UPDATE site_feedback SET status=?,version=version+1,updated_at=? WHERE id=?').run(body.status,time,id);
      db.prepare('INSERT INTO site_feedback_events(feedback_id,actor_id,status,reason,created_at) VALUES (?,?,?,?,?)').run(id,user,body.status,body.reason.trim(),time);
      db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(user,id,row.privacy_kind?'privacy_request_answered':'feedback_handled',(row.privacy_kind?'记录隐私请求答复；不代表已执行：':'处理网站意见：')+body.status,time);
      return view(db.prepare('SELECT * FROM site_feedback WHERE id=?').get(id));
    });
  }
  function closurePreflight(session,id) {
    const user=actor(session);assertAdmin(session);
    const row=db.prepare("SELECT user_id FROM site_feedback WHERE id=? AND privacy_kind='closure'").get(id);
    if(!row)throw new BusinessError('账号注销申请不存在。',404);
    if(row.user_id===user)throw new BusinessError('不能核对自己的注销申请。',403);
    const preflight=inspectClosureDependencies(db,row.user_id);
    db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(user,id,'privacy_preflight_viewed','管理员查看账号注销申请的只读待办摘要；未执行注销',now());
    return preflight;
  }
  return {submit,list,handle,closurePreflight};
}
