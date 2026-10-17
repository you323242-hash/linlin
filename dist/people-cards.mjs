import { escapeHtml as esc } from './business-api.mjs';
import { DEMO_ROOMS } from './teams-model.mjs';
import { ALL_AVATARS, BACKGROUNDS } from './persona-assets.mjs';
import './persona-space.mjs';

// Shared presentation only. These demonstration records do not grant availability or paid-order eligibility.
function avatar(person, large=false) {
  const identity=String(person.id || person.host || ''), tones=['blue','teal','violet','sand'];
  const tone=tones[Array.from(identity).reduce((sum,char)=>(sum+char.codePointAt(0))%tones.length,0)];
  const initial=Array.from(person.host || '洲')[0];
  const appearance=person.appearance || {}, custom=/^(?:\/api\/avatars\/[A-Za-z0-9-]{1,128}\?v=\d+(?:&kind=(?:social|paid))?|\/api\/team-persona-images\/[A-Za-z0-9-]{36}\?type=avatar&v=\d+)$/.test(appearance.avatarUrl || '') ? appearance.avatarUrl : null;
  const defaults=Object.fromEntries(ALL_AVATARS.map(a=>[a.id,a.src]));
  const demoAvatar=!person.live?({coast:'male-a',task:'female-b',night:'male-b',relax:'female-a'})[person.id]:null;
  const image=custom || defaults[appearance.avatar || demoAvatar];
  return `<span class="person-avatar person-avatar-${tone}${large?' person-avatar-large':''}" aria-hidden="true">${image?`<img src="${esc(image)}" alt="" loading="lazy">`:esc(initial)}</span>`;
}
export const CARD_COVERS = BACKGROUNDS;
export const CARD_THEMES = [{id:'tactical',name:'战术夜色'},{id:'aurora',name:'青屿微光'},{id:'dune',name:'沙丘日落'}];
export const CARD_MAPS = ['零号大坝','长弓溪谷','巴克什','航天基地','潮汐监狱','AZ3'];
function look(person) {
  const demoIndex=DEMO_ROOMS.findIndex(p=>p.id===person.id);
  const appearance=person.appearance || {};
  return { theme:CARD_THEMES.some(t=>t.id===appearance.theme)?appearance.theme:'tactical',cover:CARD_COVERS.some(t=>t.id===appearance.cover)?appearance.cover:demoIndex>=0?['coast','grove','space','grove'][demoIndex]:'coast',appearance };
}
export function personMini(person) {
  const feedback=person.live ? (person.reputation.kind==='restricted'?'组队受限':person.reputation.samples ? `${person.reputation.samples} 次实际反馈`:'新队友') : person.reputation.kind==='new'?'新队友':`良好 · ${person.reputation.samples} 次反馈示例`;
  return `<button type="button" class="person-mini" data-action="person" data-id="${esc(person.id)}" aria-label="查看${esc(person.host)}的名片">${avatar(person)}<span class="person-mini-copy"><strong>${esc(person.host)}</strong><small>${esc(feedback)}${person.voice?' · 有招募语音':''}</small></span><span class="person-mini-link">名片 <span aria-hidden="true">↗</span></span></button>`;
}
export function personSheet(person,context='free') {
  const paid=['paid','paid-live'].includes(context),live=['free-live','paid-live'].includes(context);
  const {theme,cover,appearance}=look(person), reputation=person.reputation || {samples:0,again:0};
  const maps=(appearance.maps || []).filter(m=>CARD_MAPS.includes(m)).slice(0,3);
  const modes=(appearance.modes?.length?appearance.modes:[person.mode]).filter(Boolean).slice(0,2);
  const statLabel=live?'组队反馈':'反馈示例';
  const background=/^(?:\/api\/persona-backgrounds\/[A-Za-z0-9-]{1,128}\?v=\d+&kind=(?:social|paid)|\/api\/team-persona-images\/[A-Za-z0-9-]{36}\?type=background&v=\d+)$/.test(appearance.backgroundUrl || '')?appearance.backgroundUrl:BACKGROUNDS.find(b=>b.id===cover)?.src;
  const gender={female:'女',male:'男',unspecified:'性别未公开'}[appearance.gender] || '性别未公开';
  return `<article class="person-sheet persona-${paid?'paid':'social'} persona-theme-${theme} persona-texture-${['none','grid'].includes(appearance.texture)?appearance.texture:'contour'}${appearance.motion==='off'?' persona-motion-off':''}" data-kind="${paid?'paid-card':'social-card'}"><div class="persona-hero persona-cover-${cover}">${background?`<img class="persona-background-image" src="${esc(background)}" alt="名片背景">`:''}<div class="persona-grid" aria-hidden="true"></div><div class="persona-topline"><span>${paid?'陪玩名片':'个人名片'}</span>${!live?'<span class="persona-demo">展示示例</span>':''}</div><div class="persona-identity">${avatar(person,true)}<div><h3>${esc(person.host)}</h3><p class="persona-signature">${esc(appearance.signature || '下一局，和有默契的人一起。')}</p></div></div><div class="persona-hero-footer"><span>三角洲行动</span><span>国服 · PC · ${gender}</span></div></div><div class="persona-main"><p class="persona-bio">${esc(appearance.bio || person.intro || '暂未填写个人简介。')}</p><div class="persona-chips">${(person.selfTags||[]).slice(0,2).map(t=>`<span>${esc(t)}</span>`).join('')}</div><section class="persona-play"><div><h4>常玩模式</h4><p>${modes.map(esc).join(' / ') || '模式不限'}</p></div><div><h4>常玩地图</h4><p>${maps.length?maps.map(esc).join(' · '):'地图不限'}</p></div><div><h4>游戏风格</h4><p>${esc(appearance.style || person.style || '随队伍安排')}</p></div></section>${paid && !live?`<section class="persona-review"><div class="persona-section-label"><h4>服务评价</h4><span>样式预览</span></div><blockquote>“需求先聊清楚，对局中及时报点，配合起来很舒服。”</blockquote><p>评价展示示例 · 后续接入真实已完成订单评价</p></section>`:paid?'<section class="persona-review"><h4>服务评价</h4><p>暂无已完成订单评价，游戏资料为本人填写。</p></section>':`<section class="persona-reputation"><div><strong>${reputation.samples || '—'}</strong><span>${statLabel}</span></div><div><strong>${reputation.again || '—'}</strong><span>愿意再组队${live?'':' · 示例'}</span></div><div><strong>${reputation.kind==='restricted'?'受限':reputation.samples?'有反馈':'新洲友'}</strong><span>${reputation.samples?'沟通与守约':'暂无历史反馈'}</span></div></section>`}${live && (person.spaceRoom || /^[A-Za-z0-9-]{20,128}$/.test(person.id || ''))?`<section class="persona-space-entry"><button type="button" data-persona-space="${esc(person.spaceRoom?'room:'+person.spaceRoom:person.id)}">查看个人空间 ↗</button><div class="persona-space-target"></div></section>`:''}</div></article>`;
}
function paidPersonCard(person) {
  const {cover}=look(person);
  return `<button type="button" class="person-card ui-surface" data-paid-person="${esc(person.id)}" aria-haspopup="dialog" aria-label="查看${esc(person.host)}的陪玩名片示例"><span class="person-card-scene persona-cover-${cover}"><span>陪玩名片 · 示例</span></span><span class="person-card-head">${avatar(person)}<span><strong>${esc(person.host)}</strong><small>${esc(person.mode)} · ${esc(person.style)}</small></span><span class="person-card-mark" aria-hidden="true">↗</span></span><span class="person-card-description">${esc(person.intro)}</span><span class="person-card-foot"><span class="person-card-tags">${person.selfTags.slice(0,2).map(t=>`<span>${esc(t)}</span>`).join('')}</span><span>查看名片</span></span></button>`;
}

if(typeof document!=='undefined') {
  const gallery=document.querySelector('#paid-people');
  if(gallery) {
    gallery.innerHTML=DEMO_ROOMS.slice(0,3).map(paidPersonCard).join('');
    gallery.addEventListener('click',async event=>{
      const button=event.target.closest('[data-paid-person]');
      if(!button)return;
      const person=DEMO_ROOMS.find(p=>p.id===button.dataset.paidPerson);
      if(person){const {show}=await import('./main.js?v=14');show('陪玩名片',personSheet(person,'paid'),button);}
    });
  }
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const fine=matchMedia('(hover:hover) and (pointer:fine)');
  let glowFrame=0, pendingGlow;
  const resetGlow=card=>{for(const key of ['--glow-x','--glow-y','--lean-x','--lean-y'])card.style.removeProperty(key);};
  // Coalesce pointer events; one update per frame, with no idle rendering loop.
  document.addEventListener('pointermove',event=>{
    if(motion.matches||!fine.matches)return;
    const card=event.target.closest('.ui-surface,.paid-page .price-card');if(!card)return;
    pendingGlow={card,x:event.clientX,y:event.clientY};
    if(glowFrame)return;
    glowFrame=requestAnimationFrame(()=>{
      glowFrame=0; const point=pendingGlow; pendingGlow=null;
      if(!point?.card.isConnected||motion.matches||!fine.matches)return;
      const box=point.card.getBoundingClientRect(); if(!box.width||!box.height)return;
      const x=Math.max(0,Math.min(1,(point.x-box.left)/box.width)),y=Math.max(0,Math.min(1,(point.y-box.top)/box.height));
      point.card.style.setProperty('--glow-x',`${x*100}%`);point.card.style.setProperty('--glow-y',`${y*100}%`);
      if(point.card.classList.contains('person-card')){point.card.style.setProperty('--lean-x',`${(0.5-y)*3}deg`);point.card.style.setProperty('--lean-y',`${(x-0.5)*3}deg`);}
    });
  },{passive:true});
  document.addEventListener('pointerout',event=>{
    const card=event.target.closest('.ui-surface,.paid-page .price-card');if(!card||card.contains(event.relatedTarget))return;
    if(pendingGlow?.card===card){cancelAnimationFrame(glowFrame);glowFrame=0;pendingGlow=null;}
    resetGlow(card);
  },{passive:true});
  motion.addEventListener('change',()=>{if(motion.matches){cancelAnimationFrame(glowFrame);glowFrame=0;pendingGlow=null;document.querySelectorAll('.ui-surface,.paid-page .price-card').forEach(resetGlow);}});
  window.addEventListener('pagehide',()=>{cancelAnimationFrame(glowFrame);glowFrame=0;pendingGlow=null;},{once:true});
  if('IntersectionObserver' in window){
    const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('ui-entered');observer.unobserve(entry.target);}}, {threshold:0.12});
    document.querySelectorAll('.paid-page .section-heading,.people-section,.paid-page .lower-grid,.paid-page .notice-links').forEach(node=>observer.observe(node));
    window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
  }
}

