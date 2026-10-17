// Original vector assets, independently constructed from paths; no character references.
export const AVATARS=[['scout','山峰'],['medic','星环'],['pilot','棱镜'],['night','浮岛'],['fox','折纸'],['signal','声波']].map(([id,name])=>({id,name,src:'./assets/original/avatar-'+id+'.svg'}));
export const CHARACTER_AVATARS=[['female-a','晴岚','female'],['female-b','知夏','female'],['male-a','云川','male'],['male-b','时屿','male']].map(([id,name,gender])=>({id,name,gender,src:`./assets/original/avatar-${id}.webp`}));
export const ALL_AVATARS=[...CHARACTER_AVATARS,...AVATARS];
export const BACKGROUNDS=[
 {id:'coast',name:'海岸晨光',kind:'风景',src:'./assets/original/coastal-outpost.webp'},
 {id:'moonport',name:'月港夜航',kind:'风景',src:'./assets/original/background-moonport.webp'},
 {id:'sunrise',name:'山海日出',kind:'风景',src:'./assets/original/background-sunrise.webp'},
 {id:'grove',name:'琥珀伙伴',kind:'人物',src:'./assets/original/amber-outpost.webp'},
 {id:'space',name:'赤铜伙伴',kind:'人物',src:'./assets/original/copper-outpost.webp'},
 {id:'jade',name:'青玉伙伴',kind:'人物',src:'./assets/original/companion-jade.webp'}
];
