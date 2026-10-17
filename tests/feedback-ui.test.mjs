import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../dist/feedback-ui.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/,'').replace('export function','function');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(admin=false){
 const requests=[],list={children:[],append(item){this.children.push(item);},replaceChildren(){this.children=[];}},status={},more={},refresh={},button={},preflight={hidden:true},summary={};
 const form={elements:{category:{value:'bug'},content:{value:'第一段问题说明'}},querySelector:()=>button,reset(){this.elements.category.value='bug';this.elements.content.value='';}};
 const nodes={'#feedback-status':status,'#feedback-list':list,'#feedback-more':more,'#feedback-refresh':refresh,'#feedback-form':admin?null:form,'#privacy-preflight':preflight,'#privacy-preflight-summary':summary};
 const panel={querySelector:selector=>nodes[selector]};
 const document={querySelector:selector=>selector==='main'?{append(){}}:null,createElement:tag=>tag==='section'?panel:{children:[],append(...items){this.children.push(...items);},setAttribute(){}}};
 const api=(route,body)=>{const task=deferred();requests.push({route,body,...task});return task.promise;};
 vm.runInNewContext(source+(admin?'\nmountFeedback();':''),{document,location:{pathname:admin?'/admin.html':'/account.html'},api,escapeHtml:null,esc:value=>String(value),showError:(error,target)=>{target.textContent=error.message;},crypto:{randomUUID:()=>`request-${requests.length}`},Date});
 return {requests,list,status,more,refresh,form,button,preflight,summary};
}
const row=content=>({id:'id',category:'bug',status:'pending',content,createdAt:Date.now(),history:[]});

test('意见请求等待期间新编辑的草稿不被提交成功清空',async()=>{
 const app=setup();app.requests[0].resolve({feedback:[]});await tick();
 const submission=app.form.onsubmit({preventDefault(){}});
 assert.equal(app.requests[1].body.content,'第一段问题说明');
 app.form.elements.content.value='等待期间新写的第二条建议';
 app.requests[1].resolve({});await tick();
 app.requests[2].resolve({feedback:[row('第一段问题说明')]});await submission;
 assert.equal(app.form.elements.content.value,'等待期间新写的第二条建议');
 assert.equal(app.button.disabled,false);
});

test('加载期间请求刷新，旧响应不能覆盖更新后的列表',async()=>{
 const app=setup();app.refresh.onclick();
 app.requests[0].resolve({feedback:[row('过期列表')]});await tick();
 assert.equal(app.requests.length,2,'必须补执行刷新请求');
 assert.equal(app.list.children.length,0,'丢弃过期响应');
 app.requests[1].resolve({feedback:[row('最新列表')]});await tick();
 assert.equal(app.list.children.length,1);assert.match(app.list.children[0].innerHTML,/最新列表/);
});

test('提交失败保留内容和幂等编号，重试成功后清空已提交草稿',async()=>{
 const app=setup();app.requests[0].resolve({feedback:[]});await tick();
 const first=app.form.onsubmit({preventDefault(){}});const requestId=app.requests[1].body.requestId;
 app.requests[1].reject(new Error('网络中断'));await first;
 assert.equal(app.form.elements.content.value,'第一段问题说明');
 const retry=app.form.onsubmit({preventDefault(){}});assert.equal(app.requests[2].body.requestId,requestId);
 app.requests[2].resolve({});await tick();app.requests[3].resolve({feedback:[]});await retry;
 assert.equal(app.form.elements.content.value,'');assert.equal(app.button.disabled,false);
});

test('隐私申请显示已答复，不把状态冒充已注销',async()=>{
 const app=setup();app.requests[0].resolve({feedback:[{...row('隐私请求说明'),category:'privacy-closure',status:'resolved',history:[{status:'resolved',reason:'仅记录答复'}]}]});await tick();
 assert.match(app.list.children[0].innerHTML,/账号注销申请 · 已答复/);
 assert.doesNotMatch(app.list.children[0].innerHTML,/已解决|已注销/);
});

test('注销申请展示本人待处理事项；核对失败或旧响应不拦截申请',async()=>{
 const app=setup();app.requests[0].resolve({feedback:[]});await tick();
 app.form.elements.category.value='privacy-closure';const first=app.form.elements.category.onchange();
 assert.equal(app.requests[1].route,'/api/privacy/closure-preflight');assert.equal(app.preflight.hidden,false);
 app.requests[1].resolve({preflight:{counts:{openOrders:1,openCases:0,pendingPayments:1,openTeams:0,pendingReports:0,pendingAppeals:0}}});await first;
 assert.match(app.summary.textContent,/未结订单 1 项/);assert.match(app.summary.textContent,/待处理退款或支付任务 1 项/);
 app.form.elements.category.value='bug';await app.form.elements.category.onchange();assert.equal(app.preflight.hidden,true);
 app.form.elements.category.value='privacy-closure';const stale=app.form.elements.category.onchange();
 app.form.elements.category.value='bug';await app.form.elements.category.onchange();app.requests[2].resolve({preflight:{counts:{openOrders:99}}});await stale;
 assert.equal(app.preflight.hidden,true);assert.doesNotMatch(app.summary.textContent,/99/);
 app.form.elements.category.value='privacy-closure';const failed=app.form.elements.category.onchange();app.requests[3].reject(Error('断网'));await failed;
 assert.match(app.summary.textContent,/仍可提交申请/);
 const submit=app.form.onsubmit({preventDefault(){}});assert.equal(app.requests[4].body.category,'privacy-closure');
 app.requests[4].resolve({});await tick();app.requests[5].resolve({feedback:[]});await submit;
 assert.equal(app.button.disabled,false);
});

test('后台只对注销申请提供核对按钮，显示摘要并恢复按钮状态',async()=>{
 const app=setup(true);app.requests[0].resolve({feedback:[{...row('核对申请'),category:'privacy-closure',status:'resolved'},{...row('普通意见'),status:'resolved'}]});await tick();
 assert.equal(app.list.children[0].children.length,2);assert.equal(app.list.children[1].children.length,0);
 const [button,box]=app.list.children[0].children;
 const load=button.onclick();assert.equal(button.disabled,true);assert.equal(box.hidden,false);
 assert.equal(app.requests[1].route,'/api/site-feedback/id/closure-preflight');
 app.requests[1].resolve({preflight:{counts:{openOrders:2,openCases:0,pendingPayments:0,openTeams:1,pendingReports:0,pendingAppeals:0}}});await load;
 assert.match(box.textContent,/未结订单 2 项/);assert.match(box.textContent,/开放组队 1 项/);assert.match(box.textContent,/不代表已执行注销/);assert.equal(button.disabled,false);
});
