import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../dist/privacy-copy-ui.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/,'').replace('export function','function');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const requests=[],button={disabled:false},status={},form={elements:{password:{value:'Synthetic-password-2026!'}},reportValidity:()=>true,querySelector:s=>s==='button'?button:status};
 const panel={isConnected:true,dataset:{},querySelector:()=>form,append(){}};
 let valid=true,clicks=0;const timers=[],revoked=[];
 const document={visibilityState:'visible',createElement:tag=>tag==='details'?panel:{click(){clicks++;},remove(){}}};
 const api=(route,body)=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});requests.push({route,body,resolve,reject});return promise;};
 vm.runInNewContext(source+'\nmountPrivacyCopy(root,isCurrent);',{root:{append(){}},isCurrent:()=>valid,document,api,showError(){},Blob,URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL:url=>revoked.push(url)},setTimeout:fn=>timers.push(fn)});
 return {requests,form,button,status,panel,document,timers,revoked,invalidate(){valid=false;},get clicks(){return clicks;},submit:()=>form.onsubmit({preventDefault(){}})};
}
test('领取途中立即清除密码、防重复提交、凭据只用于正文且下载释放URL',async()=>{
 const app=setup(),pending=app.submit();assert.equal(app.form.elements.password.value,'');assert.equal(app.button.disabled,true);await app.submit();assert.equal(app.requests.length,1);
 app.requests[0].resolve({token:'synthetic-proof'});await tick();assert.equal(app.requests[1].route,'/api/privacy/copy/download');assert.equal(app.requests[1].body.token,'synthetic-proof');
 app.requests[1].resolve({schema:'qingbo-private-copy-v1',complete:false,deliveryAvailable:true,excluded:['images']});await pending;
 assert.equal(app.clicks,1);assert.equal(app.button.disabled,false);assert.match(app.status.textContent,/请检查浏览器下载记录/);app.timers[0]();assert.deepEqual(app.revoked,['blob:synthetic']);
});
test('退出或切换页面后密码响应迟到，不再发起领取',async()=>{
 const app=setup(),pending=app.submit();app.invalidate();app.requests[0].resolve({token:'synthetic-proof'});await pending;assert.equal(app.requests.length,1);assert.equal(app.clicks,0);
});
test('下载响应迟到或页面隐藏，不触发私有文件保存',async()=>{
 const app=setup(),pending=app.submit();app.requests[0].resolve({token:'synthetic-proof'});await tick();app.document.visibilityState='hidden';
 app.requests[1].resolve({schema:'qingbo-private-copy-v1',complete:false,deliveryAvailable:true,excluded:[]});await pending;assert.equal(app.clicks,0);
});
test('领取失败说明重新复验，不自动重放或错误提示完成',async()=>{
 const app=setup(),pending=app.submit();app.requests[0].resolve({token:'synthetic-proof'});await tick();app.requests[1].reject(Error('下载资格已过期'));await pending;
 assert.equal(app.requests.length,2);assert.equal(app.clicks,0);assert.match(app.status.textContent,/重新核对密码/);assert.equal(app.form.elements.password.value,'');assert.equal(app.button.disabled,false);
});
