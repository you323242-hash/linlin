import test from 'node:test';
import assert from 'node:assert/strict';
import { demandPreview, demandSummary, bindTagButtons } from '../dist/matching-ui.mjs';
test('接单需求展示转义用户输入，不泄露私有资料', () => {
  const order = { desiredTags:['耐心沟通'], matchNote:'<img src=x onerror=alert(1)>', preferTrial:true, preference:'PRIVATE', customer:'PRIVATE', match:{matchedTags:['耐心沟通'],trialMatched:true} };
  for (const html of [demandPreview(order), demandSummary(order)]) { assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('PRIVATE')); assert.ok(html.includes('1个标签')); }
  assert.equal(demandPreview({}), '');
});
test('标签按钮支持增减，上限错误可纠正，输入不被错误覆盖', () => {
  const listeners = {}, input = { value:'耐心沟通', setCustomValidity(m){this.error=m;}, reportValidity(){this.reported=true;} };
  const button = { dataset:{tagField:'tags',tag:'积极报点'}, setAttribute(k,v){this[k]=v;} };
  const form = { elements:{tags:input}, querySelectorAll(){return [button];}, addEventListener(k,f){listeners[k]=f;} };
  bindTagButtons(form);
  const click=()=>listeners.click({target:{closest(){return button;}}});
  click(); assert.equal(input.value,'耐心沟通，积极报点'); assert.equal(button['aria-pressed'],'true');
  click(); assert.equal(input.value,'耐心沟通');
  input.value='耐心沟通，新手友好，轻松聊天，安静配合，战术协作，任务协助'; const before=input.value;
  click(); assert.equal(input.value,before); assert.ok(input.error); assert.ok(input.reported);
  input.value='耐心沟通'; listeners.input(); assert.equal(input.error,''); click(); assert.equal(input.value,'耐心沟通，积极报点');
});
