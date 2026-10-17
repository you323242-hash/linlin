import {randomUUID} from 'node:crypto';
import {migrate} from './migrations.mjs';
import {BusinessError} from './market.mjs';
const check=(ok,message,status=409)=>{if(!ok)throw new BusinessError(message,status);};
export function createPaidSquads(db,{profile,busy,log,now=Date.now}) {
  migrate(db,'010-paid-squads',`
    CREATE TABLE paid_squads(id TEXT PRIMARY KEY,join_code TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
    CREATE TABLE paid_squad_members(user_id TEXT PRIMARY KEY REFERENCES user(id),squad_id TEXT NOT NULL REFERENCES paid_squads(id),leader INTEGER NOT NULL CHECK(leader IN (0,1)));
    CREATE INDEX squad_members ON paid_squad_members(squad_id);
    CREATE TABLE order_providers(order_id TEXT NOT NULL REFERENCES orders(id),user_id TEXT NOT NULL REFERENCES user(id),live INTEGER NOT NULL CHECK(live IN (0,1)),PRIMARY KEY(order_id,user_id));
    CREATE UNIQUE INDEX one_live_provider ON order_providers(user_id) WHERE live=1;
    INSERT INTO order_providers SELECT id,provider_id,CASE WHEN status IN ('ready','active','finishing','confirming','aftercare') THEN 1 ELSE 0 END FROM orders WHERE provider_id IS NOT NULL;
    ALTER TABLE dispatch_offers ADD COLUMN partner_id TEXT REFERENCES user(id);
  `);
  const membership=id=>db.prepare('SELECT * FROM paid_squad_members WHERE user_id=?').get(id);
  const members=id=>db.prepare('SELECT m.user_id AS id,m.leader,u.name FROM paid_squad_members m JOIN user u ON u.id=m.user_id WHERE squad_id=? ORDER BY leader DESC,user_id').all(id);
  function view(userId){const row=membership(userId);if(!row)return null;const squad=db.prepare('SELECT * FROM paid_squads WHERE id=?').get(row.squad_id);return{id:squad.id,members:members(squad.id),joinCode:row.leader?squad.join_code:null};}
  // Called inside market's idempotent BEGIN IMMEDIATE transaction.
  function command(user,action,body){
    check(body.consent===true||action==='leave','请明确同意双人小队接单约定。',400);
    if(action==='create'){
      check(profile(user.id)&&!busy(user.id),'请先填写服务资料并完成已有订单。');check(!membership(user.id),'你已有接单小队，请先退出。');
      const id=randomUUID(),code=randomUUID().replaceAll('-','');
      db.prepare('INSERT INTO paid_squads VALUES(?,?,?)').run(id,code,now());db.prepare('INSERT INTO paid_squad_members VALUES(?,?,1)').run(user.id,id);log(user.id,id,'squad_created','本人同意组成双人接单小队');
    }else if(action==='join'){
      check(profile(user.id)&&!busy(user.id),'请先填写服务资料并完成已有订单。');check(!membership(user.id),'你已有接单小队，请先退出。');
      check(typeof body.code==='string'&&/^[a-f0-9]{32}$/.test(body.code),'小队邀请码无效。',400);
      const squad=db.prepare('SELECT id FROM paid_squads WHERE join_code=?').get(body.code);check(squad&&members(squad.id).length===1,'邀请码已失效或小队已满。');
      db.prepare('INSERT INTO paid_squad_members VALUES(?,?,0)').run(user.id,squad.id);log(user.id,squad.id,'squad_joined','本人同意：双方开启接单且空闲时，任一队友可代表小队承接完整双人订单；开始、完成和售后仍各自确认');
    }else if(action==='leave'){
      const member=membership(user.id);check(member&&!busy(user.id),'有服务订单时不能退出接单小队。');
      db.prepare('DELETE FROM paid_squad_members WHERE user_id=?').run(user.id);const remaining=members(member.squad_id);
      if(remaining.length)db.prepare('UPDATE paid_squad_members SET leader=1 WHERE user_id=?').run(remaining[0].id);
      else db.prepare('DELETE FROM paid_squads WHERE id=?').run(member.squad_id);
      // Rotate invitations whenever membership changes, preventing old codes from joining the remaining squad.
      if(remaining.length)db.prepare('UPDATE paid_squads SET join_code=? WHERE id=?').run(randomUUID().replaceAll('-',''),member.squad_id);
      log(user.id,member.squad_id,'squad_left','退出接单小队，保留历史订单与记录');
    }else throw new BusinessError('小队操作无效。',400);
    return {squad:view(user.id)};
  }
  const pair=userId=>{const row=membership(userId);const list=row?members(row.squad_id):[];return list.length===2?list:null;};
  return {view,command,pair};
}
