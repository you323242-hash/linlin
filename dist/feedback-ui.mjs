import {api,escapeHtml as esc,showError} from './business-api.mjs';

export function mountFeedback(){
if(document.querySelector('#site-feedback'))return;
const admin=location.pathname.endsWith('/admin.html');
const panel=document.createElement('section');panel.className='workspace-panel';panel.id='site-feedback';
panel.innerHTML=`<h2>意见与隐私请求</h2><p>反馈页面问题或使用建议。订单退款与服务纠纷请在对应订单申请售后。隐私请求受理后需核实；答复不代表已完成注销、删除或导出。请勿提交密码、验证码或证件照片。</p>
${admin?'':`<form class="order-form" id="feedback-form"><label>请求类型<select name="category"><option value="bug">页面问题</option><option value="experience">使用体验</option><option value="suggestion">功能建议</option><option value="privacy-correction">隐私 · 资料更正</option><option value="privacy-export">隐私 · 数据导出</option><option value="privacy-closure">隐私 · 账号注销</option></select></label><div class="privacy-check" id="privacy-preflight" hidden><strong>注销前事项核对</strong><p id="privacy-preflight-summary" role="status" aria-live="polite"></p><small>仅供了解当前记录。申请可以照常提交；处理仍需核实身份及未结业务，不代表已注销或可自动注销。</small></div><label>具体说明<textarea name="content" minlength="5" maxlength="2000" rows="4" required placeholder="请描述问题或建议，不要填写密码、验证码或敏感凭据。"></textarea></label><button class="workspace-button" type="submit">提交请求</button></form>`}
<p role="status" aria-live="polite" id="feedback-status"></p><button class="workspace-button" id="feedback-refresh" type="button">刷新记录</button><div id="feedback-list"></div><button class="workspace-button" id="feedback-more" type="button" hidden>查看更多</button>`;
document.querySelector('main')?.append(panel);
const status=panel.querySelector('#feedback-status'),list=panel.querySelector('#feedback-list'),more=panel.querySelector('#feedback-more');
const labels={pending:'待处理',handling:'处理中',resolved:'已解决',rejected:'不采纳'},categories={bug:'页面问题',experience:'使用体验',suggestion:'功能建议','privacy-correction':'资料更正申请','privacy-export':'数据导出申请','privacy-closure':'账号注销申请'};
let offset=0,loading=false,refreshQueued=false,pending=null;
async function load(reset=false){
 if(loading){if(reset)refreshQueued=true;return;}loading=true;more.disabled=true;
 try{
  const start=reset?0:offset;
  const result=await api(`/api/site-feedback${admin?'/admin':''}?offset=${start}&limit=20`);
  if(refreshQueued)return;
  if(reset)list.replaceChildren();
  for(const row of result.feedback){
   const privacy=row.category.startsWith('privacy-'),stateLabels=privacy?{...labels,resolved:'已答复',rejected:'未予办理'}:labels;
   const item=document.createElement('article');item.className='workspace-panel';
   item.innerHTML=`<h3>${esc(categories[row.category])} · ${esc(stateLabels[row.status])}</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(row.content)}</p><small>${esc(new Date(row.createdAt).toLocaleString('zh-CN'))}</small><ol class="service-timeline">${row.history.map(e=>`<li>${esc(stateLabels[e.status])}：${esc(e.reason)}</li>`).join('')}</ol>`;
   if(admin&&row.category==='privacy-closure'){
    const button=document.createElement('button'),box=document.createElement('div');
    button.type='button';button.className='workspace-button';button.textContent='核对未结事项';
    box.className='privacy-check';box.hidden=true;box.setAttribute('role','status');
    button.onclick=async()=>{
     button.disabled=true;box.hidden=false;box.textContent='正在核对申请账号的当前事项…';
     try{
      const {preflight}=await api(`/api/site-feedback/${row.id}/closure-preflight`);
      const names={openOrders:'未结订单',openCases:'处理中售后',pendingPayments:'待处理支付或退款',openTeams:'开放组队',pendingReports:'待处理举报',pendingAppeals:'待处理申诉'};
      const items=Object.entries(names).filter(([key])=>preflight.counts[key]>0).map(([key,label])=>`${label} ${preflight.counts[key]} 项`);
      box.textContent=(items.length?items.join('、'):'未发现上述未结事项')+'。仅供核对，不代表已执行注销。';
     }catch(e){showError(e,box);}finally{button.disabled=false;}
    };
    item.append(button,box);
   }
   if(admin&&!['resolved','rejected'].includes(row.status)){
    const form=document.createElement('form');form.className='order-form';
    form.innerHTML='<label>处理状态<select name="status" required><option value="">请选择</option><option value="handling">处理中</option><option value="resolved">已解决</option><option value="rejected">不采纳</option></select></label><label>处理原因<textarea name="reason" minlength="5" maxlength="500" required></textarea></label><button class="workspace-button" type="submit">记录处理结果</button>';
    if(privacy)form.innerHTML=form.innerHTML.replace('已解决','已答复').replace('不采纳','未予办理');
    form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await api(`/api/site-feedback/${row.id}/handle`,{status:form.elements.status.value,reason:form.elements.reason.value,version:row.version});status.textContent='处理结果已记录。';await load(true);}catch(e){showError(e,status);}finally{button.disabled=false;}};
    item.append(form);
   }
   list.append(item);
  }
  offset=start+result.feedback.length;more.hidden=result.feedback.length<20||offset>=10000;
  if(!offset)list.textContent=admin?'暂无意见或隐私请求。':'你还没有提交请求。';
 }catch(e){showError(e,status);}finally{loading=false;more.disabled=false;if(refreshQueued){refreshQueued=false;await load(true);}}
}
panel.querySelector('#feedback-refresh').onclick=()=>load(true);more.onclick=()=>load();
const form=panel.querySelector('#feedback-form');
if(form){
 const box=panel.querySelector('#privacy-preflight'),summary=panel.querySelector('#privacy-preflight-summary');let checkVersion=0;
 form.elements.category.onchange=async()=>{
  const version=++checkVersion;
  box.hidden=form.elements.category.value!=='privacy-closure';
  if(box.hidden)return;
  summary.textContent='正在核对本人相关记录…';
  try{
   const {preflight}=await api('/api/privacy/closure-preflight');
   if(version!==checkVersion||box.hidden)return;
   const c=preflight.counts;
   const items=[['未结订单',c.openOrders],['处理中售后',c.openCases],['待处理退款或支付任务',c.pendingPayments],['开放组队',c.openTeams],['待处理举报',c.pendingReports],['待处理申诉',c.pendingAppeals]].filter(([,n])=>n>0);
   summary.textContent=items.length?`当前发现：${items.map(([label,n])=>`${label} ${n} 项`).join('、')}。`:'当前未发现上述未结事项；历史数据仍需单独核实。';
  }catch{
   if(version===checkVersion&&!box.hidden)summary.textContent='暂时无法核对记录；仍可提交申请，由平台后续核实。';
  }
 };
}
if(form)form.onsubmit=async event=>{
 event.preventDefault();const button=form.querySelector('button');button.disabled=true;
 const fields={category:form.elements.category.value,content:form.elements.content.value};
 const fingerprint=JSON.stringify(fields);
 if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,requestId:crypto.randomUUID()};
 try{await api('/api/site-feedback',{...fields,requestId:pending.requestId});pending=null;if(JSON.stringify({category:form.elements.category.value,content:form.elements.content.value})===fingerprint)form.reset();status.textContent='请求已提交，可在下方查看处理进度。';await load(true);}catch(e){showError(e,status);}finally{button.disabled=false;}
};
load(true);

}
if(!location.pathname.endsWith('/admin.html'))mountFeedback();

