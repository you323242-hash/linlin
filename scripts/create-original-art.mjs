// Original mathematical compositions. No image input, game artwork, logos or character references.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../dist/assets/original/', import.meta.url));
mkdirSync(root, { recursive:true });
const palettes = {
  coast:['#123d50','#527f8c','#a5d3cd','#e3dbbf'],
  grove:['#163a3c','#698e7b','#bfd5ad','#f0debb'],
  space:['#182e51','#63739a','#b4c8e0','#e6c5a0'],
};
for (const [name,[dark,mid,light,gold]] of Object.entries(palettes)) {
  const ridges = Array.from({length:15},(_,i)=>{
    const y=320+i*24;
    return `<path d="M-100 ${y} C140 ${y-220},280 ${y+180},520 ${y-80} S830 ${y-200},1060 ${y-100} S1350 ${y+120},1700 ${y-180}" fill="none" stroke="${light}" stroke-width="${i%4===0?2:1}" opacity="${.08+i*.014}"/>`;
  }).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient><radialGradient id="glow"><stop stop-color="${gold}" stop-opacity=".7"/><stop offset="1" stop-color="${gold}" stop-opacity="0"/></radialGradient><linearGradient id="ridge" x2="0" y2="1"><stop stop-color="${light}" stop-opacity=".42"/><stop offset="1" stop-color="${dark}" stop-opacity=".05"/></linearGradient><pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7" fill="${light}" opacity=".16"/></pattern></defs><rect width="1600" height="1000" fill="url(#bg)"/><ellipse cx="1200" cy="260" rx="590" ry="470" fill="url(#glow)"/><circle cx="1190" cy="265" r="124" fill="${gold}" opacity=".1"/><circle cx="1190" cy="265" r="148" fill="none" stroke="${gold}" opacity=".28"/><path d="M-30 790 210 520 380 620 730 220 955 475 1120 340 1640 680V1100H-30Z" fill="url(#ridge)"/><path d="M-30 790 210 520 380 620 730 220 955 475 1120 340 1640 680" fill="none" stroke="${light}" stroke-opacity=".5" stroke-width="2"/><path d="M170 1000 380 690 545 830 1025 450 1210 625 1670 430V1100Z" fill="${dark}" opacity=".34"/>${ridges}<rect width="1600" height="1000" fill="url(#dots)"/><g fill="none" stroke="${gold}" opacity=".5"><path d="M1190 53v46m0 332v46M978 265h46m332 0h46"/><circle cx="730" cy="220" r="8"/><circle cx="730" cy="220" r="21" opacity=".5"/><path d="M755 220h76l36-36h90"/></g><path d="M1395 900h90v-90M75 145V65h80" stroke="${light}" fill="none" stroke-width="2" opacity=".35"/></svg>`;
  writeFileSync(root+name+'.svg',svg);
}
const glyphs=[
  '<path d="m70 150 58-85 58 85Z"/><path d="m104 142 24-37 24 37"/>',
  '<circle cx="128" cy="126" r="48"/><path d="M128 55v142M57 126h142"/>',
  '<path d="m67 126 61-61 61 61-61 61Z"/><circle cx="128" cy="126" r="18"/>',
  '<path d="M77 100q51-55 102 0v69q-51 27-102 0Z"/><path d="M77 100q51 30 102 0M101 129h54"/>',
  '<path d="m68 158 20-83 40 22 40-22 20 83-60 28Z"/><path d="m94 133 17 7m34-7 17 7m-34 14v15"/>',
  '<path d="M78 164v-41m25 41V97m25 67V67m25 97V97m25 67v-41"/>',
];
['scout','medic','pilot','night','fox','signal'].forEach((id,i)=>{
  const [dark,mid,light,gold]=Object.values(palettes)[i%3];
  writeFileSync(root+'avatar-'+id+'.svg',`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs><rect width="256" height="256" rx="48" fill="url(#a)"/><circle cx="207" cy="28" r="96" fill="${gold}" opacity=".08"/><circle cx="128" cy="128" r="97" stroke="${light}" stroke-opacity=".2" fill="none"/><g stroke="${light}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none">${glyphs[i]}</g><path d="M32 207h54m84-158h54" stroke="${gold}" stroke-opacity=".6" stroke-width="2"/></svg>`);
});
writeFileSync(root+'README.md','素材由 scripts/create-original-art.mjs 从数学路径和颜色生成，无图像输入、无游戏角色、无游戏地图复刻、无第三方字体或标志。人物头像由用户上传时，仍须确认使用权。\n');
console.log('Created 3 original vector landscapes and 6 geometric avatars.');
