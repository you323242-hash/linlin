import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';

test('注销前只读检查按本人双重身份汇总，不泄漏他人数据或改变受理',async()=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(path.join(parent,'delta-privacy-preflight-'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}`;
  const env={...process.env,APP_ENV:'test',NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:base,AUTH_DATA_DIR:dir};
  for(const key of ['BETTER_AUTH_SECRET','STAGING_ACCESS_TOKEN','TRUSTED_PROXY_IPS','AUTH_REQUIRE_EMAIL_VERIFICATION','AUTH_PHONE_MODE','BACKUP_KEY_FILE','AUTH_KEY_REF'])delete env[key];
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server/index.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const route='/api/privacy/closure-preflight';
  const call=async(url,cookie='',body)=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:base,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};};
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),15000);child.stdout.on('data',b=>{if(String(b).includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('startup failed'));});});
    const users=[];
    for(let i=0;i<4;i++)users.push(await call('/api/auth/sign-up/email','',{email:`preflight${i}@example.test`,name:'测试用户'+i,password:'Privacy-preflight-2026!',termsAccepted:true}));
    assert.ok(users.every(u=>u.status===200));const [a,b,c,d]=users;
    assert.equal((await call(route)).status,401);
    assert.equal((await call(route,a.cookie,{})).status,405);
    const empty=await call(route,c.cookie);assert.equal(empty.status,200);assert.equal(empty.data.preflight.executionAvailable,false);
    assert.deepEqual(empty.data.preflight.counts,{openOrders:0,openCases:0,pendingPayments:0,openTeams:0,pendingReports:0,pendingAppeals:0});
    assert.deepEqual(empty.data.preflight.footprint,{paidOrders:0,hostedTeams:0,joinedTeams:0,teamMessages:0,personaPosts:0,evidenceUploads:0,privacyRequests:0});
    const db=new DatabaseSync(path.join(dir,'auth.sqlite'));db.exec('PRAGMA foreign_keys=ON');
    try{
      const paid='paid-preflight',clean='clean-preflight',room='room-preflight',now=Date.now();
      db.prepare('INSERT INTO orders(id,buyer_id,provider_id,status,payload,created_at) VALUES (?,?,?,?,?,?)').run(paid,a.data.user.id,b.data.user.id,'active',JSON.stringify({case:{stage:'appeal'},payment:{status:'refund_pending'}}),now);
      db.prepare('INSERT INTO order_providers(order_id,user_id,live) VALUES (?,?,1)').run(paid,b.data.user.id);
      db.prepare('INSERT INTO order_providers(order_id,user_id,live) VALUES (?,?,1)').run(paid,d.data.user.id);
      db.prepare("INSERT INTO payment_jobs(id,order_id,action,amount,reason,status) VALUES (?,?,?,?,?,'pending')").run('job-preflight',paid,'refund',1088,'test');
      db.prepare('INSERT INTO orders(id,buyer_id,provider_id,status,payload,created_at) VALUES (?,?,?,?,?,?)').run(clean,c.data.user.id,null,'completed',JSON.stringify({payment:{status:'paid'}}),now);
      db.prepare('INSERT INTO released_services(order_id,user_id,payload) VALUES (?,?,?)').run(clean,d.data.user.id,'{}');
      db.prepare("INSERT INTO team_rooms(id,owner_id,status,payload,created_at) VALUES (?,?,'open',?,?)").run(room,a.data.user.id,'{}',now);
      db.prepare("INSERT INTO team_members(room_id,user_id,state,note,created_at,updated_at) VALUES (?,?,'confirmed','',?,?)").run(room,b.data.user.id,now,now);
      db.prepare("INSERT INTO team_reports(id,room_id,actor_id,target_id,kind,reason,snapshot,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)").run('report-preflight',room,a.data.user.id,b.data.user.id,'other','test','{}',now);
      db.prepare("INSERT INTO team_appeals(id,user_id,report_id,reason,status,created_at) VALUES (?,?,?,?,'pending',?)").run('appeal-preflight',b.data.user.id,'report-preflight','test',now);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
      const before={orders:db.prepare('SELECT count(*) n FROM orders').get().n,reports:db.prepare('SELECT count(*) n FROM team_reports').get().n};
      const pa=(await call(route,a.cookie)).data.preflight,pb=(await call(route,b.cookie)).data.preflight,pc=(await call(route,c.cookie)).data.preflight,pd=(await call(route,d.cookie)).data.preflight;
      assert.deepEqual(pa.counts,{openOrders:1,openCases:1,pendingPayments:1,openTeams:1,pendingReports:1,pendingAppeals:0});
      assert.deepEqual(pb.counts,{openOrders:1,openCases:1,pendingPayments:1,openTeams:1,pendingReports:1,pendingAppeals:1});
      assert.deepEqual(pc.counts,{openOrders:0,openCases:0,pendingPayments:0,openTeams:0,pendingReports:0,pendingAppeals:0});
      assert.deepEqual(pd.counts,{openOrders:1,openCases:1,pendingPayments:1,openTeams:0,pendingReports:0,pendingAppeals:0});
      assert.equal(pa.footprint.paidOrders,1);assert.equal(pb.footprint.paidOrders,1);assert.equal(pc.footprint.paidOrders,1);
      assert.equal(pd.footprint.paidOrders,2,'已退出的历史服务者仍应在本人数据清单内');
      assert.equal(pa.footprint.hostedTeams,1);assert.equal(pb.footprint.joinedTeams,1);assert.equal(pc.footprint.hostedTeams,0);
      assert.equal(pa.advisoryOnly,true);assert.equal(JSON.stringify(pa).includes(paid),false);
      assert.deepEqual(before,{orders:db.prepare('SELECT count(*) n FROM orders').get().n,reports:db.prepare('SELECT count(*) n FROM team_reports').get().n});
      const submitted=await call('/api/site-feedback',a.cookie,{category:'privacy-closure',content:'申请注销，请先受理并核对未结事项',requestId:'privacy-preflight-request'});
      assert.equal(submitted.status,200);assert.equal(submitted.data.feedback.status,'pending');
      assert.equal((await call(route,a.cookie)).data.preflight.footprint.privacyRequests,1);
      db.prepare("UPDATE user SET role='admin' WHERE id=?").run(c.data.user.id);
      assert.equal((await call(route,c.cookie)).data.preflight.adminReview,true);
    }finally{db.close();}
  }finally{
    if(child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill();});
    const resolved=realpathSync(dir);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('delta-privacy-preflight-'));rmSync(resolved,{recursive:true});
  }
});
