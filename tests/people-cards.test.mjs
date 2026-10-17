import {test} from 'node:test';
import assert from 'node:assert/strict';
import {personMini,personSheet} from '../dist/people-cards.mjs';
import {DEMO_ROOMS} from '../dist/teams-model.mjs';

test('公开名片转义用户内容，不生成外部联系方式或指定购买入口',()=>{
  const unsafe={...DEMO_ROOMS[0],id:'"><img src=x onerror=alert(1)>',host:'<script>unsafe</script>',intro:'<img src=x onerror=alert(1)>',selfTags:['<iframe>','&danger','第三项不展示']};
  for(const html of [personMini(unsafe),personSheet(unsafe),personSheet(unsafe,'paid')]){
    assert.doesNotMatch(html,/<(?:script|iframe)\b|<img[^>]*\bonerror=/);
    assert.match(html,/&lt;/);
    assert.doesNotMatch(html,/href=|mailto:|tel:/);
  }
  assert.doesNotMatch(personSheet(unsafe),/第三项不展示/);
  assert.match(personSheet(unsafe,'paid'),/展示示例/);
});
test('免费名片不把新用户或示例反馈当成真实认证',()=>{
  assert.match(personMini(DEMO_ROOMS[1]),/新队友/);
  assert.match(personSheet(DEMO_ROOMS[1]),/暂无历史反馈/);
  assert.match(personSheet(DEMO_ROOMS[0]),/>24<\/strong><span>反馈示例/);
  assert.doesNotMatch(personSheet(DEMO_ROOMS[0]),/认证|评级优秀|person-disclosure/);
  assert.match(personSheet(DEMO_ROOMS[0],'paid'),/评价展示示例/);
});

test('社交与陪玩名片分版式，拒绝任意头像地址，签名和简介安全展示',()=>{
  const p={...DEMO_ROOMS[0],appearance:{signature:'<script>x</script>',bio:'<iframe>bio',avatarUrl:'https://evil.test/me.svg',operator:'../../evil',texture:'bad',motion:'off',maps:['零号大坝','<bad>']}};
  const free=personSheet(p,'free-live'),paid=personSheet(p,'paid');
  assert.match(free,/persona-social/);assert.match(paid,/persona-paid/);
  assert.doesNotMatch(free,/evil\.test|\.\.\/|<script>|<iframe>|<bad>/);
  assert.match(free,/&lt;script&gt;/);assert.match(free,/persona-motion-off/);
  assert.match(free,/零号大坝/);assert.doesNotMatch(free,/服务评价/);
  assert.match(paid,/服务评价/);assert.doesNotMatch(paid,/组队反馈/);
});

test('名片头像稳定配色且保留完整Unicode昵称首字符',()=>{
  const person={...DEMO_ROOMS[0],id:'stable-person',host:'🎮洲友',intro:''};
  const mini=personMini(person),sheet=personSheet(person);
  assert.match(mini,/person-avatar-(blue|teal|violet|sand)/);
  assert.equal(mini.match(/person-avatar-(blue|teal|violet|sand)/)[1],sheet.match(/person-avatar-(blue|teal|violet|sand)/)[1]);
  assert.match(mini,/aria-hidden="true">🎮<\/span>/);
  assert.match(sheet,/暂未填写个人简介/);
});
