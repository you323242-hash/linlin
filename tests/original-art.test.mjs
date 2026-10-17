import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {productArt} from '../dist/catalog.mjs';
import {AVATARS} from '../dist/persona-assets.mjs';
import {personSheet} from '../dist/people-cards.mjs';
import {DEMO_ROOMS} from '../dist/teams-model.mjs';
test('公开素材只保留平台原创插画与几何头像，无退役游戏角色和外链图像',()=>{
  assert.deepEqual(readdirSync(new URL('../dist/assets/',import.meta.url)),['original']);
  const dir=new URL('../dist/assets/original/',import.meta.url),files=readdirSync(dir);
  assert.deepEqual(files.filter(n=>n.endsWith('.svg')).sort(),['avatar-fox.svg','avatar-medic.svg','avatar-night.svg','avatar-pilot.svg','avatar-scout.svg','avatar-signal.svg','club-mark.svg','coast.svg','grove.svg','qingbo-favicon.svg','qingbo-mark.svg','space.svg']);assert.equal(AVATARS.length,6);
  for(const file of files.filter(n=>n.endsWith('.svg'))){const source=readFileSync(new URL(file,dir),'utf8');assert.match(source,/^<svg/);assert.doesNotMatch(source.replace('xmlns="http://www.w3.org/2000/svg"',''),/<(?:script|image|foreignObject)\b|\bon\w+=|href=|https?:\/\//);}
  assert.deepEqual(files.filter(n=>n.endsWith('.webp')).sort(),['amber-outpost.webp','avatar-female-a.webp','avatar-female-b.webp','avatar-male-a.webp','avatar-male-b.webp','background-moonport.webp','background-sunrise.webp','briefing-lounge.webp','coastal-outpost.webp','companion-amber.webp','companion-copper.webp','companion-jade.webp','copper-outpost.webp']);
  for(const file of files.filter(n=>n.endsWith('.webp'))){const data=readFileSync(new URL(file,dir));assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.toString('ascii',8,12),'WEBP');assert.ok(data.length<900_000);}
  assert.match(productArt('secret'),/original\/amber-outpost\.webp$/);assert.match(productArt('topsecret'),/original\/copper-outpost\.webp$/);
  for(const room of DEMO_ROOMS){const html=personSheet({...room,appearance:{operator:'luna-a',cover:'luna'}});assert.doesNotMatch(html,/personas\/|luna|tempest|vyron|persona-operator/);assert.match(html,/persona-cover-coast|persona-cover-grove|persona-cover-space/);}
});
