import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeReturnPath,showError} from '../dist/business-api.mjs';
test('登录返回保留订单视角与服务选择，拒绝外站及非白名单地址',()=>{
  for (const value of ['/orders.html?role=provider','/service.html?mode=secret','/account.html?role=buyer','/admin.html']) assert.equal(safeReturnPath(value),value);
  for (const value of ['https://evil.test','//evil.test','/\\evil.test','/api/admin','/orders.html/../api/admin',null]) assert.equal(safeReturnPath(value),'/account.html');
  const prior=globalThis.location;let destination;
  try {globalThis.location={pathname:'/orders.html',search:'?role=provider',replace:value=>destination=value};showError({status:401,message:'需登录'});assert.equal(new URL(destination,'http://local.test').searchParams.get('returnTo'),'/orders.html?role=provider');}
  finally {if(prior===undefined)delete globalThis.location;else globalThis.location=prior;}
});
