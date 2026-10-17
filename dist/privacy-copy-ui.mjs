import {api,showError} from './business-api.mjs';

export function mountPrivacyCopy(root,isCurrent){
 const panel=document.createElement('details');panel.dataset.privacyCopy='';
 panel.innerHTML=`<summary>领取本人部分资料副本</summary><p>包含本人资料、名片设置、自己上传的头像和背景、可见动态的图文及部分参与记录摘要。照片保存在资料文件中；图片较多时需人工分批提供。暂不包含售后附件、完整订单售后与账目；此文件不代表完整隐私请求已处理。</p><p>请在自己的设备领取并妥善保存。密码仅用于本次核对；下载资格限当前会话、5分钟内使用一次。</p><form class="order-form"><label>当前密码<input type="password" name="password" autocomplete="current-password" minlength="12" maxlength="128" required></label><label><input type="checkbox" name="understood" required>我了解副本范围，并将在自己的设备保存</label><p role="status" aria-live="polite"></p><button type="submit" class="workspace-button">核对密码并领取</button></form>`;
 root.append(panel);
 const form=panel.querySelector('form'),button=form.querySelector('button'),status=form.querySelector('[role="status"]');
 const active=()=>panel.isConnected&&isCurrent()&&document.visibilityState!=='hidden';
 form.onsubmit=async event=>{
  event.preventDefault();if(button.disabled||!form.reportValidity())return;
  button.disabled=true;status.textContent='正在核对密码…';
  let password=form.elements.password.value,token,objectURL;
  form.elements.password.value='';
  try{
   const proof=await api('/api/privacy/copy/proof',{password});password=null;
   if(!active())return;
   token=proof.token;
   if(typeof token!=='string')throw Error('领取资格异常，请重新核对密码。');
   status.textContent='正在准备部分资料副本…';
   const copy=await api('/api/privacy/copy/download',{token});token=null;
   if(!active())return;
   if(copy.complete!==false||copy.deliveryAvailable!==true||copy.schema!=='qingbo-private-copy-v1'||!Array.isArray(copy.excluded))throw Error('副本格式异常，请重新核对密码领取。');
   objectURL=URL.createObjectURL(new Blob([JSON.stringify(copy,null,2)],{type:'application/json;charset=utf-8'}));
   const link=document.createElement('a');link.href=objectURL;link.download='qingbo-personal-partial-copy.json';panel.append(link);link.click();link.remove();
   const issuedURL=objectURL;setTimeout(()=>URL.revokeObjectURL(issuedURL),30000);objectURL=null;
   status.textContent='已发起部分资料副本下载，请检查浏览器下载记录。若文件未保存，请重新核对密码领取。隐私请求不会自动标记完成。';
  }catch(error){if(active()){status.textContent=error.message+' 若未收到文件，请重新核对密码领取。';showError(error);}}
  finally{password=null;token=null;if(objectURL)URL.revokeObjectURL(objectURL);form.elements.password.value='';button.disabled=false;}
 };
}
