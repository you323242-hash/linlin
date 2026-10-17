import {migrate} from './migrations.mjs';
import {BusinessError} from './market.mjs';
import {ALL_AVATARS,BACKGROUNDS} from '../dist/persona-assets.mjs';
import {MAPS} from './personas.mjs';
const MODES=['机密行动','绝密行动'];
export function teamChannel(value='pc'){
 if(!['pc','mobile'].includes(value))throw new BusinessError('请选择端游或手游平台。',400);
 return value;
}
export function createTeamProfiles(db,{legacy=()=>null}={}){
 migrate(db,'015-free-team-profiles',`CREATE TABLE free_team_profiles(user_id TEXT NOT NULL REFERENCES user(id),channel TEXT NOT NULL CHECK(channel IN ('pc','mobile')),payload TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,channel));`);
 const defaults={theme:'tactical',cover:'coast',avatar:'initial',gender:'unspecified',maps:[],modes:[],style:'',signature:'',bio:'',gameId:''};
 function view(userId,channel='pc'){
  teamChannel(channel);const row=db.prepare('SELECT payload,version FROM free_team_profiles WHERE user_id=? AND channel=?').get(userId,channel);
  if(row)return {...defaults,...JSON.parse(row.payload),version:row.version,channel};
  // Existing social cards belong to the legacy PC lobby only; never copy them to mobile.
  return {...defaults,...(channel==='pc'?legacy(userId)||{}:{}),version:0,channel};
 }
 function appearance(userId,channel){
  if(channel==='pc'&&!db.prepare('SELECT 1 FROM free_team_profiles WHERE user_id=? AND channel=?').get(userId,channel))return legacy(userId);
  const {gameId,...card}=view(userId,channel);return card;
 }
 function save(user,body,channel='pc'){
  teamChannel(channel);const fail=message=>{throw new BusinessError(message,400);};
  if(!Number.isSafeInteger(body.version)||body.version<0)fail('名片版本无效，请刷新。');
  const data={...defaults};
  for(const [key,limit] of [['style',12],['signature',60],['bio',240],['gameId',64]]){if(typeof body[key]!=='string'||body[key].length>limit||/[\x00-\x1f\x7f]/.test(body[key]))fail('名片文字长度或格式无效。');data[key]=body[key].trim();}
  for(const [key,values] of [['maps',MAPS],['modes',MODES]]){if(!Array.isArray(body[key])||body[key].length>values.length||new Set(body[key]).size!==body[key].length||body[key].some(v=>!values.includes(v)))fail('地图或模式无效。');data[key]=body[key];}
  for(const [key,values] of [['cover',BACKGROUNDS.map(v=>v.id)],['avatar',['initial',...ALL_AVATARS.map(v=>v.id)]],['gender',['unspecified','male','female']]]){if(!values.includes(body[key]))fail('名片选项无效。');data[key]=body[key];}
  db.exec('BEGIN IMMEDIATE');try{
   const previous=db.prepare('SELECT version FROM free_team_profiles WHERE user_id=? AND channel=?').get(user.id,channel);
   if((previous?.version||0)!==body.version)throw new BusinessError('名片已更新，请刷新后再保存。',409);
   db.prepare('INSERT INTO free_team_profiles VALUES(?,?,?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET payload=excluded.payload,version=excluded.version,updated_at=excluded.updated_at').run(user.id,channel,JSON.stringify(data),body.version+1,Date.now());
   db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?)').run(user.id,user.id,'free_game_profile_saved',channel+'游戏名片保存；不记录资料内容',Date.now());
   db.exec('COMMIT');return view(user.id,channel);
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 return {view,appearance,save};
}
