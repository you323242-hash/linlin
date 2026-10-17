// Browser-only demonstration data. Never used for real permissions, ranking or enforcement.
export const DEMO_ROOMS = [
  { id:'coast', title:'稳健搜集，找一位会报点的队友', host:'北岸', mode:'机密行动', style:'稳健搜集', when:'现在可开始', need:1, mic:'voice', tags:['友善沟通','清晰报点','稳健搜集'], selfTags:['愿意配合','可开麦'], intro:'不抢物资，先沟通路线。想找节奏相近的队友，安心打几局。', reputation:{kind:'good', samples:24, again:21} },
  { id:'task', title:'一起清任务，节奏不用太赶', host:'晚风', mode:'机密行动', style:'任务协作', when:'今晚 20:00', need:2, mic:'text', tags:['任务协作','耐心沟通','文字也可以'], selfTags:['耐心配合','任务优先'], intro:'主要做任务，需要时互相掩护。新队友也欢迎，需求提前说清楚。', reputation:{kind:'new', samples:0, again:0} },
  { id:'night', title:'绝密双排，路线和打法先聊好', host:'零点', mode:'绝密行动', style:'积极交战', when:'今晚 21:00', need:1, mic:'voice', tags:['积极交战','清晰报点','可开麦'], selfTags:['进攻配合','节奏明确'], intro:'偏好主动配合，遇到情况及时交流。战绩资料自行说明，不保证撤离。', reputation:{kind:'good', samples:12, again:10} },
  { id:'relax', title:'轻松开黑，有空就一起玩', host:'山间', mode:'机密行动', style:'轻松开黑', when:'现在可开始', need:2, mic:'text', tags:['轻松开黑','友善沟通','不责怪队友'], selfTags:['休闲节奏','文字也可以'], intro:'下班放松几局，正常失误不责怪。一起玩得舒服最重要。', reputation:{kind:'good', samples:8, again:7} },
];
// Player preferences, not official game modes. Existing custom values remain valid.
export const TACTICAL_STYLES = ['轻松跑刀','任务协作','正常配装','猛攻配合','以小博大','战术堵桥','稳健撤离','单挑练习'];
export function filterRooms(rooms, {mode='all',style='all',mic='all',q=''}={}) {
  const keyword=q.trim().toLocaleLowerCase();
  return rooms.filter(r=>(mode==='all'||r.mode===mode||r.mode==='不限')&&(style==='all'||r.style===style)&&(mic==='all'||r.mic===mic||r.mic==='text')&&(!keyword||[r.title,r.intro,r.host,...r.tags].join(' ').toLocaleLowerCase().includes(keyword)));
}
export function parseTags(value) {
  const tags=[...new Set(value.normalize('NFKC').split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean))];
  if(tags.length>6||tags.some(t=>t.length>12)) throw new Error('最多6个标签，每个不超过12字。');
  return tags;
}
export function recruitment(values) {
  const title=String(values.title||'').trim(), intro=String(values.intro||'').trim(), when=String(values.when||'').trim(), need=Number(values.need);
  if(!title||title.length>32||intro.length>120||!when||when.length>30) throw new Error('请填写标题和开始时间，并遵守字数限制。');
  if(!['机密行动','绝密行动','不限'].includes(values.mode)||!values.style||values.style.length>12||!['voice','text'].includes(values.mic)||![1,2].includes(need)) throw new Error('请选择有效的模式、战术风格、沟通方式与人数。');
  const gameId=String(values.gameId||'').trim();
  if(gameId.length>64||/[\u0000-\u001f\u007f]/.test(gameId)) throw new Error('游戏内名称或ID最多64字，不能含控制字符。');
  return {title,intro,when,need,mode:values.mode,style:values.style,mic:values.mic,tags:parseTags(String(values.tags||'')),selfTags:parseTags(String(values.selfTags||'')),gameId};
}
export function canParticipate(reputation) { return reputation!=='restricted'; }
export function canChat(membership) { return membership?.state==='confirmed'; }
export function isTeamHistory(team) { return team.room.status === 'ended' || ['ended','left','withdrawn','rejected'].includes(team.membership.state); }

