import test from 'node:test';
import assert from 'node:assert/strict';

test('登录表单429显示等待时间并允许用户稍后手动重试，不跳转或自动重复登录',async()=>{
  const saved={fetch:globalThis.fetch,BroadcastChannel:globalThis.BroadcastChannel,location:globalThis.location};
  globalThis.BroadcastChannel=undefined;let submitHandler,calls=0,redirects=0;
  const message={textContent:''},button={disabled:false};
  const form={dataset:{mode:'login'},elements:{email:{value:'synthetic@example.test'},password:{value:'Synthetic-test-password!'}},reset(){},
    querySelector:s=>s==='#auth-message'?message:s==='[type="submit"]'?button:null,
    addEventListener:(event,handler)=>{if(event==='submit')submitHandler=handler;}};
  const container={querySelector:s=>s==='#auth-form'?form:null,querySelectorAll:()=>[]};
  globalThis.location={href:'http://local.test/?login=1',replace:()=>redirects++};
  try{
    const {mountAuthPanel}=await import('../dist/auth-ui.js');mountAuthPanel(container);
    globalThis.fetch=async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'60'}});};
    await submitHandler({preventDefault(){}});
    assert.equal(message.textContent,'请求过于频繁，请等待约60秒后重试。');assert.equal(button.disabled,false);assert.equal(calls,1);assert.equal(redirects,0);
    globalThis.fetch=async()=>{calls++;return new Response('{}',{status:200});};
    await submitHandler({preventDefault(){}});assert.equal(calls,2);assert.equal(redirects,1);assert.equal(button.disabled,false);
  }finally{Object.assign(globalThis,saved);}
});
