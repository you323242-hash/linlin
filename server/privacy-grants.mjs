// Delivery guard; the HTTP boundary enforces Origin and no-store.
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {BusinessError} from './market.mjs';
import {createPersistentLimiter} from './limits.mjs';
import {prepareOwnPrivacyCopy} from './privacy-copy.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
// Not persisted: reopened/restored databases require a fresh password proof.
const deliveryEpochs=new WeakMap();
const fail=(message,status=403)=>{throw new BusinessError(message,status);};
export function createPrivacyGrants(db,auth,{now=Date.now,prepare=prepareOwnPrivacyCopy,enrich=copy=>copy}={}){
 if(!deliveryEpochs.has(db))deliveryEpochs.set(db,randomBytes(32).toString('base64url'));
 const deliveryEpoch=deliveryEpochs.get(db);
 const allow=createPersistentLimiter(db,{namespace:'privacy-password',limit:5,windowMs:600000,now});
 const allowDownload=createPersistentLimiter(db,{namespace:'privacy-download',limit:10,windowMs:600000,now});
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 function current(session){
  const row=db.prepare('SELECT id,userId,expiresAt FROM session WHERE id=?').get(session?.session?.id||'');
  if(!row||row.userId!==session?.user?.id||row.expiresAt<=now())fail('请重新登录后核对身份。',401);
  const credential=db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").get(row.userId);
  if(!credential?.password)fail('该账号需要另行核对身份，暂不支持密码交付。',409);
  return {userId:row.userId,sessionId:row.id,passwordRevision:digest(credential.password)};
 }
 async function identity(headers){return current(await auth.api.getSession({headers,query:{disableCookieCache:true}}));}
 const audit=(user,action)=>db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?)').run(user,user,action,'本人副本交付准备；非完整导出或注销；不记录密码/下载令牌',now());
 async function issue(headers,password){
  const before=await identity(headers);
  if(!allow(before.userId))fail('身份核对过于频繁，请稍后重试。',429);
  if(typeof password!=='string'||password.length<12||password.length>128)fail('密码核对失败，请重新登录后重试。');
  try{const result=await auth.api.verifyPassword({headers,body:{password}});if(result.status!==true)fail('密码核对失败。');}catch{fail('密码核对失败或会话需要重新登录。');}
  return transaction(()=>{
   const after=current({user:{id:before.userId},session:{id:before.sessionId}});
   if(after.passwordRevision!==before.passwordRevision)fail('账号凭据已变化，请重新核对。');
   const token=randomBytes(32).toString('base64url'),time=now(),expiresAt=time+300000;
   db.prepare("DELETE FROM verification WHERE identifier LIKE 'privacy-copy:%' AND (expiresAt<=? OR (json_valid(value) AND json_extract(value,'$.userId')=?))").run(time,after.userId);
   db.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(randomUUID(),'privacy-copy:'+digest(token),JSON.stringify({...after,deliveryEpoch}),expiresAt,time,time);
   audit(after.userId,'privacy_copy_identity_verified');return {token,expiresAt};
  });
 }
 async function consume(headers,token){
  const subject=await identity(headers);
  if(!allowDownload(subject.userId))fail('下载尝试过于频繁，请稍后重试。',429);
  if(typeof token!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(token))fail('下载资格无效或已过期。');
  const validate=()=>{
   const currentSubject=current({user:{id:subject.userId},session:{id:subject.sessionId}});
   const identifier='privacy-copy:'+digest(token),row=db.prepare('SELECT value,expiresAt FROM verification WHERE identifier=?').get(identifier);
   if(!row||row.expiresAt<=now())fail('下载资格无效或已过期。');
   let proof;try{proof=JSON.parse(row.value);}catch{fail('下载资格无效。');}
   if(proof.deliveryEpoch!==deliveryEpoch||proof.userId!==currentSubject.userId||proof.sessionId!==currentSubject.sessionId||proof.passwordRevision!==currentSubject.passwordRevision)fail('领取资格已失效，请在当前会话重新核对密码。');
   return {currentSubject,identifier};
  };
  const copy=transaction(()=>{const {currentSubject}=validate();return prepare(db,currentSubject.userId);});
  const result=await enrich(copy,subject.userId);
  return transaction(()=>{
   const {currentSubject,identifier}=validate();
   if(db.prepare('DELETE FROM verification WHERE identifier=?').run(identifier).changes!==1)fail('下载资格已使用。');
   audit(currentSubject.userId,'privacy_copy_prepared_for_delivery');return result;
  });
 }
 return {issue,consume};
}
