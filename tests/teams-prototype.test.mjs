import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ROOMS,filterRooms,recruitment,parseTags,canChat,canParticipate,isTeamHistory } from '../dist/teams-model.mjs';
test('组队原型：条件组合过滤、空结果与用户内容校验',()=>{
  assert.equal(filterRooms(DEMO_ROOMS,{mode:'绝密行动',mic:'voice'}).length,1);
  assert.equal(filterRooms(DEMO_ROOMS,{mode:'绝密行动',mic:'text'}).length,0);
  assert.equal(filterRooms(DEMO_ROOMS,{q:'清晰报点'}).length,2);
  assert.deepEqual(parseTags('友善沟通， 友善沟通,可开麦'),['友善沟通','可开麦']);
  assert.throws(()=>parseTags('一二三四五六七八九十一二三'));
  const values={title:'一起玩',intro:'友善沟通',when:'现在',need:'1',mode:'机密行动',style:'轻松开黑',mic:'text',tags:'愿意配合',selfTags:''};
  assert.equal(recruitment(values).need,1);
  assert.throws(()=>recruitment({...values,need:'5'}));
  assert.throws(()=>recruitment({...values,title:' '}));
  // Voice is optional and never appears in filtering or validation requirements.
  assert.ok(recruitment(values));
});
test('组队原型：新队友可参与，限制只影响新参与；确认前和结束后不能聊天',()=>{
  assert.equal(canParticipate('new'),true);assert.equal(canParticipate('good'),true);assert.equal(canParticipate('restricted'),false);
  for(const state of ['requested','ended','cancelled'])assert.equal(canChat({state}),false);
  assert.equal(canChat({state:'confirmed'}),true);assert.equal(canChat(null),false);
  assert.equal(DEMO_ROOMS.find(r=>r.reputation.kind==='new').reputation.samples,0);
});
test('组队历史范围与后端一致：正在组队和待确认不能清除',()=>{
  for (const state of ['confirmed','requested']) assert.equal(isTeamHistory({room:{status:'open'},membership:{state}}),false);
  for (const state of ['ended','left','withdrawn','rejected']) assert.equal(isTeamHistory({room:{status:'open'},membership:{state}}),true);
  assert.equal(isTeamHistory({room:{status:'ended'},membership:{state:'confirmed'}}),true);
});
