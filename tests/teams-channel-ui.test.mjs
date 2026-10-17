import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../dist/teams.mjs',import.meta.url),'utf8');
test('平台请求不复用另一平台迟到结果，查询与写入均带平台',async()=>{
 let release;const calls=[];
 const context={api:(route,body)=>{calls.push({route,body});return new Promise(r=>{release=r;});},Error,Object};vm.createContext(context);
 const helper=source.slice(source.indexOf('async function teamAPI('),source.indexOf('function freeSheet('));
 vm.runInContext("let channel='pc';"+helper+"globalThis.call=teamAPI;globalThis.switchTo=value=>channel=value;",context);
 const old=context.call('/api/teams/mine');context.switchTo('mobile');release({private:'PC_ONLY'});
 await assert.rejects(old,e=>e.staleChannel===true);
 const body={message:'合成手游消息'},fresh=context.call('/api/teams/id/actions/message?after=1',body);
 assert.equal(calls[1].route,'/api/teams/id/actions/message?after=1&channel=mobile');assert.equal(calls[1].body,body);release({ok:true});await fresh;
});
