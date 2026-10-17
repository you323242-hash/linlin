import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../dist/teams.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function detail(state='requested',own=false){return {room:{id:'room',title:'合成招募',mode:'机密行动',style:'稳健搜集',when:'现在',intro:'友善沟通',need:1,status:'open',tags:[],selfTags:[]},membership:{state,own},members:[],applicants:[],feedbackTargets:[]};}
async function setup(initial=detail()){
 const listeners={},nodes={},calls=[];
 function node(){return {innerHTML:'',textContent:'',hidden:false,open:false,dataset:{},scrollTop:0,isConnected:true,scrollIntoView(){},querySelectorAll(){return [];},querySelector(selector){if(selector==='form')return this.innerHTML.includes('<form')?{draft:'未提交留言'}:null;if(selector==='[data-detail-update]')return this.innerHTML.includes('data-detail-update')?{}:null;return null;},contains(){return false;},insertAdjacentHTML(position,html){this.innerHTML=position==='afterbegin'?html+this.innerHTML:this.innerHTML+html;},replaceChildren(){this.innerHTML='';},setAttribute(){},focus(){},addEventListener(event,fn){listeners[event]=fn;},showModal(){this.open=true;},close(){this.open=false;listeners.close?.();}};}
 for(const key of ['#team-dialog','#team-dialog-body','#team-dialog-title','#team-chat-rooms','#team-conversation-body','#team-toast','#team-filters','#team-result','#team-cards','[data-action="close-chat"]','[data-close-team]'])nodes[key]=node();
 const document={visibilityState:'visible',activeElement:null,querySelector:s=>nodes[s]||null,addEventListener(){}};
 let data=initial,account='account',pending=null,messagePending=null;
 const api=async route=>{calls.push(route);if(route==='/api/teams/mine')return {user:{id:account},teams:data.membership?[data]:[],blocks:[],reputation:{samples:0}};if(route.startsWith('/api/teams?'))return {rooms:[],next:null};if(route==='/api/teams/room')return pending?await pending:data;if(route.startsWith('/api/teams/room/messages'))return messagePending?await messagePending:{messages:[],writable:true};throw Error('UNEXPECTED_ROUTE');};
 const context={document,window:{addEventListener(){}},api,esc:String,personMini:()=>'',personSheet:()=>'',filterRooms:x=>x,isTeamHistory:()=>false,FormData:class{*[Symbol.iterator](){}},URLSearchParams,Date,Map,JSON,Promise,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},matchMedia:()=>({matches:true}),location:{assign(){},reload(){}},crypto:{randomUUID:()=> 'request'}};
 vm.runInNewContext(source+'\n globalThis.review={refresh,detail,chat,activeChat:()=>activeChatId,show:(view,html)=>{currentView=view;currentId="room";open(view,html);},busy:value=>busy=value};',context);
 await tick();await context.review.detail('room');
 return {review:context.review,nodes,calls,setData:value=>data=value,setAccount:value=>account=value,defer(){let resolve;pending=new Promise(r=>resolve=r);return value=>{resolve(value);pending=null;};},deferMessages(){let resolve;messagePending=new Promise(r=>resolve=r);return value=>{resolve(value);messagePending=null;};}};
}

test('已打开的详情同步确认/结束及房主申请，未变化不重复重绘',async()=>{
 const app=await setup();const body=app.nodes['#team-dialog-body'];
 assert.match(body.innerHTML,/等待房主确认/);
 app.setData(detail('confirmed'));await app.review.refresh();assert.match(body.innerHTML,/退出小队/);assert.doesNotMatch(body.innerHTML,/撤回申请/);
 body.scrollTop=83;app.nodes['#team-dialog'].scrollTop=47;
 await app.review.refresh();assert.equal(body.scrollTop,83);assert.equal(app.nodes['#team-dialog'].scrollTop,47);
 app.setData(detail('ended'));await app.review.refresh();assert.match(body.innerHTML,/查看历史消息/);assert.doesNotMatch(body.innerHTML,/退出小队/);
 const host=detail('confirmed',true);host.applicants=[{id:'member',name:'队友申请',note:'合成留言'}];app.setData(host);await app.review.refresh();assert.match(body.innerHTML,/确认入队/);assert.match(body.innerHTML,/队友申请/);
});

test('申请草稿留在原表单，举报和反馈输入不被轮询覆盖',async()=>{
 const app=await setup({...detail(),membership:null});const body=app.nodes['#team-dialog-body'];
 const original=body.innerHTML;app.setData({...detail(),membership:null,room:{...detail().room,status:'ended',need:0}});
 await app.review.refresh();assert.ok(body.innerHTML.includes(original));assert.match(body.innerHTML,/data-detail-update/);
 const first=body.innerHTML;await app.review.refresh();assert.equal(body.innerHTML,first);
 for(const kind of ['report','feedback']){app.review.show(kind,'<form>未提交输入</form>');await app.review.refresh();assert.equal(body.innerHTML,'<form>未提交输入</form>');}
});

test('延迟详情响应不能覆盖已切换窗口、关闭窗口或正在执行的操作',async()=>{
 for(const next of ['report','close','busy']){
  const app=await setup();const resolve=app.defer();const refresh=app.review.refresh();await tick();
  if(next==='report')app.review.show('report','<form>正在举报</form>');
  if(next==='close')app.nodes['#team-dialog'].close();
  if(next==='busy')app.review.busy(true);
  const before=app.nodes['#team-dialog-body'].innerHTML;
  resolve(detail('confirmed'));await refresh;assert.equal(app.nodes['#team-dialog-body'].innerHTML,before);
  if(next==='close')assert.equal(app.nodes['#team-dialog'].open,false);
 }
});

test('其他端更换登录账户时关闭旧账户的私有详情',async()=>{
 const app=await setup();app.setAccount('other-account');await app.review.refresh();assert.equal(app.nodes['#team-dialog'].open,false);
});

test('消息加载期间成员退出，迟到响应不能重新打开聊天',async()=>{
 const app=await setup(detail('confirmed'));const resolve=app.deferMessages();
 const opening=app.review.chat('room');await tick();
 app.setData(detail('left'));await app.review.refresh();
 resolve({messages:[{id:1,text:'退出前的合成消息'}],writable:true});await opening;
 assert.equal(app.review.activeChat(),null);
 assert.doesNotMatch(app.nodes['#team-conversation-body'].innerHTML,/team-chat/);
});

test('已经打开的聊天在退出后清空',async()=>{
 const app=await setup(detail('confirmed'));await app.review.chat('room');
 assert.equal(app.review.activeChat(),'room');
 app.setData(detail('left'));await app.review.refresh();
 assert.equal(app.review.activeChat(),null);assert.equal(app.nodes['#team-conversation-body'].innerHTML,'');assert.equal(app.nodes['#team-conversation-body'].hidden,true);
});
