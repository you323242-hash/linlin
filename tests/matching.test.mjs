import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createLocalProviders } from '../server/providers/local.mjs';
import { createMarket } from '../server/market.mjs';
import { normalizeTags, matchFit } from '../dist/matching.mjs';

test('标签规范化、去重与输入边界', () => {
  assert.deepEqual(normalizeTags([' 耐心沟通 ', '耐心沟通', 'PC配合']), ['耐心沟通', 'pc配合']);
  for (const value of [null, '聊天', ['<img>'], [''], Array(7).fill('报点'), ['a'.repeat(13)]]) assert.throws(() => normalizeTags(value));
  assert.deepEqual(matchFit({}, {}), { matchedTags: [], trialMatched: false });
});

test('匹配偏好持久化、标签优先与非强制试音', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delta-match-'));
  let db, providers, market, clock = Date.now();
  const setup = async () => { const a = await createAuth({ baseURL: 'http://127.0.0.1:4174', dataDirectory: directory }); db = a.database; providers = createLocalProviders({directory}); market = createMarket(db, providers, {now: () => clock}); return a.auth; };
  const call = (u,s,b={}) => market.command(u,s,{requestId:randomUUID(),...b});
  const users = [];
  try {
    const auth = await setup();
    for(let i=0;i<4;i++) users.push((await auth.api.signUpEmail({body:{name:`匹配验收${i}`,email:`match${i}@example.test`,password:'Local-matching-test!',termsAccepted:true}})).user);
    const [buyer,other] = users;
    const [a,b] = users.slice(2).sort((a,b)=>a.id.localeCompare(b.id));
    const profile = (u,tags,trialAvailable=false) => call(u,'profile',{adult:true,gameId:'LOCAL-MATCH',introduction:'仅测试标签匹配',available:true,modes:['secret'],stats:{secret:{kd:1.1,gear:4}},tags,trialAvailable});
    const paid = async fields => { let o=(await call(buyer,'create',{mode:'secret',rulesAccepted:true,preference:'私有入队资料',...fields})).order; return (await call(buyer,`${o.id}:pay`,{version:o.version})).order; };
    const offer = o=>db.prepare("SELECT * FROM dispatch_offers WHERE order_id=? AND status='pending'").get(o.id);
    const cancel = o=>call(buyer,`${o.id}:cancel`,{version:market.readOrder(o.id,buyer).version});
    await t.test('默认需求仅本人，订单保留快照且可覆盖',async()=>{
      await call(buyer,'preferences',{desiredTags:['耐心沟通'],matchNote:'请耐心讲解，轻松交流',preferTrial:true});
      assert.deepEqual(market.preferences(other.id).desiredTags,[]);
      const o=await paid(); assert.deepEqual(o.desiredTags,['耐心沟通']); assert.equal(o.preferTrial,true);
      await call(buyer,'preferences',{desiredTags:['积极报点'],matchNote:'新的偏好',preferTrial:false});
      assert.deepEqual(market.readOrder(o.id,buyer).desiredTags,['耐心沟通']); await cancel(o);
      const overridden=await paid({desiredTags:[],matchNote:'',preferTrial:false}); assert.deepEqual(overridden.desiredTags,[]); assert.equal(overridden.matchNote,''); await cancel(overridden);
    });
    await t.test('标签优先于试音，队列仅公开匹配备注，不泄漏私有需求',async()=>{
      await profile(a,['耐心沟通'],true); await profile(b,['耐心沟通','积极报点'],false); market.heartbeat(a); market.heartbeat(b);
      const o=await paid({desiredTags:['耐心沟通','积极报点'],matchNote:'这是公开派单备注',preferTrial:true});
      assert.equal(offer(o).user_id,b.id);
      const q=market.queue(b).find(q=>q.id===o.id); assert.equal(q.matchNote,'这是公开派单备注'); assert.equal(q.preference,''); assert.deepEqual(q.match.matchedTags,['耐心沟通','积极报点']); assert.ok(!JSON.stringify(q).includes(buyer.id));
      await cancel(o);
    });
    await t.test('同等标签时参考试音；无人匹配时仍派给合格者',async()=>{
      await profile(a,['耐心沟通'],false); await profile(b,['耐心沟通'],true);
      // Make the willing provider the more recently invited candidate, so preference overrides fairness.
      db.prepare("INSERT INTO dispatch_offers(id,order_id,user_id,status,created_at,expires_at,reason) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),db.prepare('SELECT id FROM orders LIMIT 1').get().id,b.id,'expired',clock+1,clock+2,'测试历史邀请');
      const o=await paid({desiredTags:['耐心沟通'],preferTrial:true}); assert.equal(offer(o).user_id,b.id); await cancel(o);
      await profile(b,[],false); const fallback=await paid({desiredTags:['不存在标签'],preferTrial:true}); assert.ok(offer(fallback)); await cancel(fallback);
    });
    await t.test('非法标签拒绝，旧资料更新保留标签和试音，重启保留偏好',async()=>{
      await assert.rejects(call(buyer,'preferences',{desiredTags:['<script>']}),{status:400});
      await assert.rejects(call(a,'profile',{adult:true,gameId:'LOCAL',introduction:'仅测试',available:true,modes:['secret'],stats:{secret:{kd:1,gear:4}},trialAvailable:'yes'}),{status:400});
      await profile(a,['新手友好'],true); await call(a,'profile',{adult:true,gameId:'LOCAL',introduction:'仅测试修改简介',available:false,modes:['secret'],stats:{secret:{kd:1,gear:4}}});
      assert.deepEqual(market.profile(a.id).tags,['新手友好']); assert.equal(market.profile(a.id).trialAvailable,true);
      providers.close(); db.close(); await setup(); assert.deepEqual(market.preferences(buyer.id).desiredTags,['积极报点']); assert.deepEqual(market.profile(a.id).tags,['新手友好']);
    });
  } finally { providers?.close(); db?.close(); rmSync(directory,{recursive:true,force:true}); }
});
