import test from 'node:test';
import assert from 'node:assert/strict';

test('找回密码页限流/网络失败可理解且无自动重试，密码与历史令牌清除',async()=>{
 const names=['fetch','document','location','history'],saved=Object.fromEntries(names.map(n=>[n,globalThis[n]]));
 const cases=[
  {response:new Response('{}',{status:429,headers:{'Retry-After':'60'}}),message:/约60秒/},
  {response:new Response('{}',{status:429,headers:{'X-Retry-After':'90'}}),message:/约90秒/},
  {response:new Response('{}',{status:429,headers:{'Retry-After':'<bad>'}}),message:/稍后重试/},
  {error:Object.assign(new Error('RAW_ENGLISH_TIMEOUT'),{name:'TimeoutError'}),message:/超时.*无法确认/},
  {error:new TypeError('RAW_NETWORK_FAILURE'),message:/连接.*无法确认/},
  {response:new Response('{}',{status:503}),message:/真实邮件服务尚未接入/},
  {response:new Response('{}',{status:200}),message:/密码已更新/}
 ];
 try{for(let i=0;i<cases.length;i++){
  let calls=0,historyPath;const status={textContent:''},button={disabled:false};
  const inputs=[{value:'Disposable-reset-test-password!'},{value:'Disposable-reset-test-password!'}];
  const form={elements:{newPassword:inputs[0],confirm:inputs[1]},hidden:false,querySelector:()=>button,querySelectorAll:()=>inputs,reset(){inputs.forEach(v=>v.value='');}};
  const root={innerHTML:'',querySelector:()=>form};
  globalThis.document={querySelector:s=>s==='#recovery-content'?root:status};
  globalThis.location={hash:'#reset=SYNTHETIC_PRIVATE_TOKEN',pathname:'/recovery.html'};
  globalThis.history={replaceState:(_a,_b,url)=>{historyPath=url;}};
  globalThis.fetch=async()=>{calls++;if(cases[i].error)throw cases[i].error;return cases[i].response;};
  await import('../dist/recovery.mjs?feedback='+i);
  await form.onsubmit({preventDefault(){},currentTarget:form});
  assert.match(status.textContent,cases[i].message);assert.equal(calls,1);assert.equal(button.disabled,false);assert.equal(historyPath,'/recovery.html');
  assert.ok(inputs.every(v=>v.value===''));for(const marker of ['SYNTHETIC_PRIVATE_TOKEN','RAW_ENGLISH_TIMEOUT','RAW_NETWORK_FAILURE'])assert.ok(!status.textContent.includes(marker));
  assert.equal(form.hidden,i===cases.length-1);
 }}finally{for(const name of names){if(saved[name]===undefined)delete globalThis[name];else globalThis[name]=saved[name];}}
});
