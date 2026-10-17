import { migrate } from './migrations.mjs';
import { BusinessError } from './market.mjs';
import { randomUUID } from 'node:crypto';

export const AVATAR_LIMIT = 128 * 1024;
const check = (ok, message, status = 400) => { if (!ok) throw new BusinessError(message, status); };
import { ALL_AVATARS, BACKGROUNDS } from '../dist/persona-assets.mjs';
const choices = { theme:['tactical','aurora','dune'], cover:BACKGROUNDS.map(b=>b.id), avatar:['initial',...ALL_AVATARS.map(a=>a.id)], operator:['none'], texture:['contour','grid','none'], motion:['subtle','off'] };
export const MAPS = ['零号大坝','长弓溪谷','巴克什','航天基地','潮汐监狱','AZ3'];
const MODES = ['机密行动','绝密行动'];
// Avatars are bounded JPEG images, never SVG/HTML or a caller-supplied URL.
export function validateAvatar(encoded, {limit=AVATAR_LIMIT,side=512}={}) {
  check(typeof encoded === 'string' && encoded.length <= Math.ceil(limit / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), '图片格式或大小无效。');
  const bytes = Buffer.from(encoded, 'base64');
  check(bytes.length >= 32 && bytes.length <= limit && bytes.toString('base64') === encoded, '图片超过大小限制。');
  check(bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217, '请上传有效的JPEG头像。');
  let offset = 2, size = null, scan = false;
  const clean = [bytes.subarray(0, 2)];
  while (offset < bytes.length - 2) {
    const start = offset;
    check(bytes[offset++] === 255, '头像内容无效。');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    check(offset + 2 <= bytes.length, '头像内容不完整。');
    const length = bytes.readUInt16BE(offset);
    check(length >= 2 && offset + length <= bytes.length - 2, '头像内容不完整。');
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      check(length >= 8 && !size, '头像尺寸无效。');
      size = { height:bytes.readUInt16BE(offset+3), width:bytes.readUInt16BE(offset+5) };
      check(size.width >= 16 && size.height >= 16 && size.width <= side && size.height <= side, '图片尺寸超过限制。');
    }
    offset += length;
    // Do not retain EXIF/GPS, comments or application metadata from direct API uploads.
    if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) clean.push(bytes.subarray(start, offset));
    if (marker === 0xda) { scan = true; clean.push(bytes.subarray(offset)); break; }
  }
  check(size && scan, '请上传完整的JPEG头像。');
  return Buffer.concat(clean);
}
export function createPersonas(db,{canEditPaid=()=>false}={}) {
  migrate(db, '009-persona-presentation', `CREATE TABLE user_personas(user_id TEXT PRIMARY KEY REFERENCES user(id),payload TEXT NOT NULL,avatar BLOB,version INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);`);
  migrate(db,'011-persona-space',`ALTER TABLE user_personas ADD COLUMN background BLOB;
    CREATE TABLE provider_personas(user_id TEXT PRIMARY KEY REFERENCES user(id),payload TEXT NOT NULL,avatar BLOB,version INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,background BLOB);
    CREATE TABLE persona_posts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES user(id),text TEXT NOT NULL,image BLOB,created_at INTEGER NOT NULL,deleted_at INTEGER);
    CREATE INDEX persona_posts_owner ON persona_posts(user_id,deleted_at,created_at);`);
  const table=kind=>{check(['social','paid'].includes(kind),'名片类型无效。');return kind==='paid'?'provider_personas':'user_personas';};
  const requirePaid=(id,kind)=>{if(kind==='paid')check(canEditPaid(id),'请先完善服务者资料，成为接单者后再编辑陪玩名片。',403);};
  function view(userId,kind='social') {
    const row = db.prepare(`SELECT payload,version,avatar IS NOT NULL AS custom,background IS NOT NULL AS custom_background FROM ${table(kind)} WHERE user_id=?`).get(userId);
    const defaults={theme:'tactical',cover:'coast',avatar:'initial',operator:'none',texture:'contour',motion:'subtle',signature:'',maps:[],modes:[],bio:'',style:'',gender:'unspecified',version:0,avatarUrl:null,backgroundUrl:null};
    if(!row)return defaults;
    const payload=JSON.parse(row.payload);
    return {...defaults,...payload,operator:'none',cover:choices.cover.includes(payload.cover)?payload.cover:'coast',version:row.version,avatarUrl:row.custom?`/api/avatars/${encodeURIComponent(userId)}?v=${row.version}&kind=${kind}`:null,backgroundUrl:row.custom_background?`/api/persona-backgrounds/${encodeURIComponent(userId)}?v=${row.version}&kind=${kind}`:null};
  }
  function save(user, body,kind='social') {
    requirePaid(user.id,kind);const storage=table(kind);
    for (const [key, values] of Object.entries(choices)) check(values.includes(body[key]), '请选择有效的名片样式。');
    for (const [key, values] of [['maps',MAPS],['modes',MODES]]) check(Array.isArray(body[key]) && body[key].length <= values.length && new Set(body[key]).size === body[key].length && body[key].every(v=>values.includes(v)), '地图或模式选择无效。');
    for (const key of ['bio','style','signature']) check(typeof body[key] === 'string' && body[key].length <= ({bio:120,style:24,signature:32})[key] && !/[\u0000-\u001f\u007f]/.test(body[key]), '简介、签名或游戏风格内容无效。');
    check(Number.isSafeInteger(body.version) && body.version >= 0, '名片版本无效。');
    check(['keep','replace','default'].includes(body.avatarAction), '头像操作无效。');
    check(['male','female','unspecified'].includes(body.gender || 'unspecified'),'性别选项无效。');
    const backgroundAction=body.backgroundAction || 'keep';check(['keep','replace','default'].includes(backgroundAction),'背景操作无效。');
    const replacement = body.avatarAction === 'replace' ? validateAvatar(body.avatarContent) : null;
    const backgroundReplacement=backgroundAction==='replace'?validateAvatar(body.backgroundContent,{limit:384*1024,side:1600}):null;
    const payload = Object.fromEntries([...Object.keys(choices),'maps','modes','bio','style','signature'].map(k=>[k, typeof body[k] === 'string' ? body[k].trim() : body[k]]));
    payload.gender=body.gender || 'unspecified';
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare(`SELECT avatar,background,version FROM ${storage} WHERE user_id=?`).get(user.id);
      check((old?.version || 0) === body.version, '名片已在其他页面更新，请重新打开后编辑。', 409);
      const avatar = body.avatarAction === 'keep' ? old?.avatar || null : replacement;
      const background=backgroundAction==='keep'?old?.background || null:backgroundReplacement;
      db.prepare(`INSERT INTO ${storage}(user_id,payload,avatar,version,updated_at,background) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,avatar=excluded.avatar,version=excluded.version,updated_at=excluded.updated_at,background=excluded.background`).run(user.id,JSON.stringify(payload),avatar,body.version+1,Date.now(),background);
      db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?)').run(user.id,user.id,'persona_saved','更新本人名片与头像，不改变权限或排名',Date.now());
      db.exec('COMMIT');
      return view(user.id,kind);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function avatar(userId,kind='social') { return db.prepare(`SELECT avatar FROM ${table(kind)} WHERE user_id=? AND avatar IS NOT NULL`).get(userId)?.avatar || null; }
  function background(userId,kind='social') { return db.prepare(`SELECT background FROM ${table(kind)} WHERE user_id=?`).get(userId)?.background || null; }
  function listPosts(userId){return db.prepare('SELECT id,text,created_at,image IS NOT NULL AS has_image FROM persona_posts WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 12').all(userId).map(p=>({id:p.id,text:p.text,createdAt:p.created_at,imageUrl:p.has_image?`/api/persona-post-images/${p.id}`:null}));}
  function post(user,body){
    if(body.action==='delete'){
      const row=db.prepare('SELECT user_id FROM persona_posts WHERE id=? AND deleted_at IS NULL').get(body.id);
      check(row && row.user_id===user.id,'动态不存在或无权操作。',404);
      db.prepare('UPDATE persona_posts SET deleted_at=?,image=NULL WHERE id=? AND user_id=? AND deleted_at IS NULL').run(Date.now(),body.id,user.id);
      db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?)').run(user.id,body.id,'persona_post_removed','移除本人空间展示，保留审计',Date.now());return listPosts(user.id);
    }
    check(body.action==='publish' && typeof body.text==='string' && body.text.length<=500 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body.text),'图文内容无效，最多500字。');
    const image=body.imageContent?validateAvatar(body.imageContent,{limit:384*1024,side:1600}):null;
    check(body.text.trim() || image,'请填写文字或选择图片。');
    db.exec('BEGIN IMMEDIATE');try{
      check(db.prepare('SELECT count(*) n FROM persona_posts WHERE user_id=? AND deleted_at IS NULL').get(user.id).n<12,'空间最多保留12条，请先移除旧展示。');
      const id=randomUUID();db.prepare('INSERT INTO persona_posts(id,user_id,text,image,created_at) VALUES(?,?,?,?,?)').run(id,user.id,body.text.trim(),image,Date.now());
      db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?)').run(user.id,id,'persona_post_published','本人发布图文，登录用户可见',Date.now());db.exec('COMMIT');return listPosts(user.id);
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function postImage(id){return db.prepare('SELECT image FROM persona_posts WHERE id=? AND deleted_at IS NULL').get(id)?.image || null;}
  return {view,save,avatar,background,requirePaid,listPosts,post,postImage};
}
