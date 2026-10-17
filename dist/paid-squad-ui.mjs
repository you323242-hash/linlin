import {api,requestBody,escapeHtml as esc,showError} from './business-api.mjs';
export async function mountPaidSquad(container){
  container.className='workspace-panel squad-panel';
  const consent='双方开启接单且空闲在线时，任一队友可代表小队承接完整双人订单；开始、完成及售后方案仍需各自确认。';
  async function render(){
    const {squad}=await api('/api/squads');
    container.innerHTML=`<div class="panel-heading"><h2>双人接单小队</h2><span>${squad?.members.length===2?'已组队':'自主组队'}</span></div><p>两名服务者共同承接一笔双人订单，单人价格不变。</p>${squad?`<div class="squad-members">${squad.members.map(m=>`<span><b>${esc(Array.from(m.name)[0])}</b>${esc(m.name)}</span>`).join('')}</div>${squad.members.length<2&&squad.joinCode?`<label class="squad-code">把邀请码发给队友<input readonly aria-label="小队邀请码" value="${squad.joinCode}"></label>`:''}<p class="squad-help">${squad.members.length===2?'双方开启接单，并保持服务者页面在线，即可接受双人单。每个人的装备与可用状态均需满足订单要求。':'队友先保存服务资料，再通过邀请码加入。'}</p><button type="button" data-squad-leave class="workspace-button">退出小队</button>`:`<form data-squad-form class="order-form"><label>队友邀请码（不填则创建小队）<input name="code" maxlength="32" autocomplete="off" placeholder="已有小队？填写队友发来的邀请码"></label><label class="squad-consent"><input name="consent" type="checkbox" required>${consent}</label><button class="workspace-button" type="submit">创建 / 加入小队</button></form>`}<p role="status" data-squad-status></p>`;
    const form=container.querySelector('form');
    if(form)form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const code=form.elements.code.value.trim();await api('/api/squads',requestBody({action:code?'join':'create',code,consent:form.elements.consent.checked}));await render();}catch(error){showError(error,container.querySelector('[data-squad-status]'));button.disabled=false;}};
    container.querySelector('[data-squad-leave]')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await api('/api/squads',requestBody({action:'leave'}));await render();}catch(error){showError(error,container.querySelector('[data-squad-status]'));event.currentTarget.disabled=false;}});
  }
  try{await render();}catch(error){container.textContent=error.message;}
}
