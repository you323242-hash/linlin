// Internal copy preparation only. Not an HTTP endpoint or identity proof.
import {BusinessError} from './market.mjs';
import {createHash} from 'node:crypto';
const MAX_ROWS=5000,MAX_BYTES=5*1024*1024;
const personaFields=['theme','cover','avatar','signature','maps','modes','bio','style','gender'];
const roomFields=['title','intro','when','need','mode','style','mic','tags','selfTags','gameId'];
const preferenceFields=['desiredTags','matchNote','preferTrial'];
const serviceFields=['gameId','introduction','modes','stats','tags','trialAvailable','adult','available'];
function ownOrderContributions(raw,userId,asBuyer){
 let order;try{order=JSON.parse(raw);}catch{throw new BusinessError('订单资料需要人工核对，未生成副本。',409);}
 const invalid=()=>{throw new BusinessError('订单资料需要人工核对，未生成副本。',409);};
 if(!order||typeof order!=='object'||Array.isArray(order))invalid();
 const list=value=>{if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.length>MAX_ROWS)invalid();return value;};
 const fields=(value,strings,numbers=[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const result=selectPayload(JSON.stringify(value),strings);
  for(const name of numbers)if(Object.hasOwn(value,name)){if(!Number.isSafeInteger(value[name])||value[name]<0)invalid();result[name]=value[name];}
  return result;
 };
 const cases=[...list(order.cases),...(order.case?[order.case]:[])];
 if(cases.length>MAX_ROWS)invalid();
 const own=value=>value&&typeof value==='object'&&!Array.isArray(value)&&value.actorId===userId;
 return {
  messages:list(order.messages).filter(own).map(value=>fields(value,['text','time'])),
  review:asBuyer&&order.review?fields(order.review,['text'],['attitude','communication','experience']):null,
  cancellationRequests:[...list(order.cancelHistory),...(order.cancelRequest?[order.cancelRequest]:[])].filter(value=>value?.by===userId).map(value=>fields(value,['reason','result'],['at'])),
  caseSubmissions:cases.filter(value=>value?.openedBy===userId).map(value=>({...fields(value,['id','kind','description'],['openedAt']),context:value.context?fields(value.context,['occurredWhen','expectation']):{}})),
  caseNotes:cases.flatMap(value=>list(value?.notes).filter(own).map(note=>({caseId:fields(value,['id']).id,...fields(note,['text'],['time'])})))
 };
}
function selectPayload(raw,fields){
 let value;try{value=JSON.parse(raw);}catch{throw new BusinessError('资料记录需要人工核对，未生成副本。',409);}if(!value||typeof value!=='object'||Array.isArray(value))throw new BusinessError('资料记录需要人工核对，未生成副本。',409);
 return Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>{
  const item=value[key],tag=['tags','selfTags','desiredTags'].includes(key);
  if(key==='stats'){
   if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length>20)throw new BusinessError('接单资料需要人工核对，未生成副本。',409);
   return [key,Object.fromEntries(Object.entries(item).map(([mode,stats])=>{
    if(!mode||mode.length>100||!stats||typeof stats!=='object'||Array.isArray(stats)||!Number.isFinite(stats.kd)||stats.kd<0||stats.kd>100||!Number.isInteger(stats.gear)||stats.gear<0||stats.gear>100)throw new BusinessError('接单资料需要人工核对，未生成副本。',409);
    return [mode,{kd:stats.kd,gear:stats.gear}];
   }))];
  }
  const valid=tag?Array.isArray(item)&&item.length<=6&&item.every(v=>typeof v==='string'&&v.length<=12):['maps','modes'].includes(key)?Array.isArray(item)&&item.length<=20&&item.every(v=>typeof v==='string'&&v.length<=100):['preferTrial','trialAvailable','adult','available'].includes(key)?typeof item==='boolean':key==='need'?Number.isSafeInteger(item)&&item>=1&&item<=2:typeof item==='string'&&item.length<=2000;
  if(!valid)throw new BusinessError('资料格式需要人工核对，未生成副本。',409);
  return [key,item];
 }));
}
export function prepareOwnPrivacyCopy(db,userId){
 if(typeof userId!=='string'||!userId)throw new BusinessError('缺少已核对的账号。',401);
 db.exec('SAVEPOINT privacy_copy');
 try{
  const columns=new Set(db.prepare('PRAGMA table_info(user)').all().map(row=>row.name));
  const fields=['name','email','emailVerified','phoneNumber','phoneNumberVerified','createdAt','updatedAt'].filter(name=>columns.has(name));
  const account=db.prepare('SELECT '+fields.map(name=>'"'+name+'"').join(',')+' FROM user WHERE id=?').get(userId);
  if(!account)throw new BusinessError('账号不存在。',404);
  const rows=(sql,...params)=>{const result=db.prepare(sql+' LIMIT '+(MAX_ROWS+1)).all(...params);if(result.length>MAX_ROWS)throw new BusinessError('资料数量较多，需要分批人工交付；未生成不完整副本。',409);return result;};
  const persona=table=>rows(`SELECT payload,version,updated_at AS updatedAt FROM ${table} WHERE user_id=?`,userId).map(({payload,...row})=>({...row,settings:selectPayload(payload,personaFields)}));
  const mediaSQL=`SELECT 'social-avatar' AS kind,NULL AS postId,avatar AS bytes FROM user_personas WHERE user_id=? AND avatar IS NOT NULL
   UNION ALL SELECT 'social-background',NULL,background FROM user_personas WHERE user_id=? AND background IS NOT NULL
   UNION ALL SELECT 'paid-avatar',NULL,avatar FROM provider_personas WHERE user_id=? AND avatar IS NOT NULL
   UNION ALL SELECT 'paid-background',NULL,background FROM provider_personas WHERE user_id=? AND background IS NOT NULL
   UNION ALL SELECT 'post-image',id,image FROM persona_posts WHERE user_id=? AND deleted_at IS NULL AND image IS NOT NULL`;
  const mediaParams=Array(5).fill(userId);
  const mediaBytes=db.prepare('SELECT coalesce(sum(length(bytes)),0) AS total FROM ('+mediaSQL+')').get(...mediaParams).total;
  if(mediaBytes>Math.floor(MAX_BYTES*3/4))throw new BusinessError('本人图片较多，需要分批人工交付；未生成缺图副本。',409);
  const ownUploadedImages=rows(mediaSQL+' ORDER BY kind,postId',...mediaParams).map(({kind,postId,bytes})=>{
   if(!(bytes instanceof Uint8Array))throw new BusinessError('图片记录需要人工核对，未生成副本。',409);
   const buffer=Buffer.from(bytes);
   if(buffer.length<4||buffer[0]!==255||buffer[1]!==216||buffer[2]!==255||buffer.at(-2)!==255||buffer.at(-1)!==217)throw new BusinessError('图片记录需要人工核对，未生成副本。',409);
   const sha256=createHash('sha256').update(buffer).digest('hex');
   return {kind,postId,fileName:kind+(postId?'-'+createHash('sha256').update(String(postId)).digest('hex').slice(0,24):'')+'.jpg',mime:'image/jpeg',byteLength:buffer.length,sha256,contentBase64:buffer.toString('base64')};
  });
  let orderSourceBytes=0;
  const sections={
   account,ownUploadedImages,
   ownFreeGameProfiles:db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='free_team_profiles'").get()?rows('SELECT channel,payload,version,updated_at AS updatedAt FROM free_team_profiles WHERE user_id=? ORDER BY channel',userId).map(({payload,...row})=>({...row,settings:selectPayload(payload,[...personaFields,'gameId'])})):[],
   socialCard:persona('user_personas'),paidCard:persona('provider_personas'),
   ownMatchingPreferences:rows('SELECT payload FROM user_preferences WHERE user_id=?',userId).map(row=>selectPayload(row.payload,preferenceFields)),
   ownServiceProfiles:rows('SELECT payload FROM provider_profiles WHERE user_id=?',userId).map(row=>selectPayload(row.payload,serviceFields)),
   ownVisiblePosts:rows('SELECT id,text,created_at AS createdAt FROM persona_posts WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at,id',userId),
   hostedTeams:rows('SELECT id,status,payload,created_at AS createdAt,ended_at AS endedAt FROM team_rooms WHERE owner_id=? ORDER BY created_at,id',userId).map(({payload,...row})=>({...row,settings:selectPayload(payload,roomFields)})),
   ownTeamMemberships:rows('SELECT room_id AS roomId,state,note,created_at AS createdAt,updated_at AS updatedAt FROM team_members WHERE user_id=? ORDER BY created_at,room_id',userId),
   ownTeamMessages:rows('SELECT room_id AS roomId,content AS text,created_at AS createdAt FROM team_messages WHERE user_id=? ORDER BY created_at,id',userId),
   ownTeamFeedback:rows('SELECT room_id AS roomId,payload,created_at AS createdAt FROM team_feedback WHERE actor_id=? ORDER BY created_at,room_id,target_id',userId).map(({payload,...row})=>({...row,settings:selectPayload(payload,['again','communication','reliable'])})),
   ownTeamReports:rows('SELECT id,room_id AS roomId,kind,reason,status,created_at AS createdAt,reviewed_at AS reviewedAt FROM team_reports WHERE actor_id=? ORDER BY created_at,id',userId),
   ownTeamAppeals:rows('SELECT id,report_id AS reportId,reason,status,created_at AS createdAt,reviewed_at AS reviewedAt FROM team_appeals WHERE user_id=? ORDER BY created_at,id',userId),
   ownRequests:rows('SELECT id,category,privacy_kind AS privacyKind,content,status,created_at AS createdAt,updated_at AS updatedAt FROM site_feedback WHERE user_id=? ORDER BY created_at,id',userId),
   ownOrderContributions:rows(`SELECT o.id AS orderId,o.payload,CASE WHEN o.buyer_id=? THEN 1 ELSE 0 END AS asBuyer
     FROM orders o WHERE o.buyer_id=? OR o.provider_id=? OR EXISTS(SELECT 1 FROM order_providers p WHERE p.order_id=o.id AND p.user_id=?)
     UNION ALL SELECT r.order_id,r.payload,0 FROM released_services r WHERE r.user_id=? AND NOT EXISTS
     (SELECT 1 FROM orders o WHERE o.id=r.order_id AND (o.buyer_id=? OR o.provider_id=? OR EXISTS(SELECT 1 FROM order_providers p WHERE p.order_id=o.id AND p.user_id=?)))
     ORDER BY orderId`,...Array(8).fill(userId)).map(({orderId,payload,asBuyer})=>{
      orderSourceBytes+=Buffer.byteLength(payload,'utf8');
      if(orderSourceBytes>MAX_BYTES)throw new BusinessError('订单资料较多，需要分批人工核对；未生成不完整副本。',409);
      return {orderId,...ownOrderContributions(payload,userId,asBuyer)};
     }),
   ownAuditActions:rows('SELECT id,action,created_at AS createdAt FROM audit_events WHERE actor_id=? ORDER BY created_at,id',userId),
   orderReferences:rows(`SELECT o.id,o.status,o.created_at AS createdAt,
     CASE WHEN o.buyer_id=? THEN 1 ELSE 0 END AS asBuyer,
     CASE WHEN o.provider_id=? OR EXISTS(SELECT 1 FROM order_providers p WHERE p.order_id=o.id AND p.user_id=?) OR EXISTS(SELECT 1 FROM released_services r WHERE r.order_id=o.id AND r.user_id=?) THEN 1 ELSE 0 END AS asProvider
     FROM orders o WHERE o.buyer_id=? OR o.provider_id=? OR EXISTS(SELECT 1 FROM order_providers p WHERE p.order_id=o.id AND p.user_id=?) OR EXISTS(SELECT 1 FROM released_services r WHERE r.order_id=o.id AND r.user_id=?) ORDER BY o.created_at,o.id`,...Array(8).fill(userId))
  };
  const copy={schema:'qingbo-private-copy-v1',preparedAt:Date.now(),deliveryAvailable:false,complete:false,
   scope:'本人提交的资料及参与记录摘要；尚未完成正式核身与安全交付',
   excluded:['密码、会话、OTP、TOTP及备份密钥','他人消息、账号资料、联系方式、评价和举报证据','举报目标身份、审核快照及处理说明：须另行核对；本人提交文字可能含他人信息','售后附件、无作者标识的旧消息/售后证据、已移除帖子及必要留存档案：须另行核对','订单完整共享资料、他人售后说明、资金账目及审计目标/理由：须按所有权及他人隐私人工核对'],sections};
  if(Buffer.byteLength(JSON.stringify(copy),'utf8')>MAX_BYTES)throw new BusinessError('副本较大，需要分批人工交付；未生成不完整副本。',409);
  db.exec('RELEASE privacy_copy');return copy;
 }catch(error){db.exec('ROLLBACK TO privacy_copy');db.exec('RELEASE privacy_copy');throw error;}
}
