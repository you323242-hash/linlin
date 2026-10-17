import test from 'node:test';
import assert from 'node:assert/strict';
import {readIdentityView,saveIdentityView} from '../dist/identity-view.mjs';
import {belongsToIdentity} from '../dist/orders.mjs';

test('身份偏好按账户保存；URL合法视角优先，错误值不能获得角色',()=>{
  const previous=globalThis.localStorage, values=new Map();
  globalThis.localStorage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  try{
    saveIdentityView('first','provider');
    assert.equal(readIdentityView('first'),'provider');
    assert.equal(readIdentityView('second'),'buyer');
    assert.equal(readIdentityView('first','buyer'),'buyer');
    saveIdentityView('second','admin');
    assert.equal(readIdentityView('second','admin'),'buyer');
    globalThis.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
    assert.equal(readIdentityView('first'),'buyer');
    assert.doesNotThrow(()=>saveIdentityView('first','provider'));
  }finally{if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;}
});

test('消费者和接单者只保留本人对应订单，未知用户与管理员视角不能混入',()=>{
  const order={buyerId:'buyer',providerId:'provider'};
  assert.equal(belongsToIdentity(order,'buyer','buyer'),true);
  assert.equal(belongsToIdentity(order,'provider','provider'),true);
  assert.equal(belongsToIdentity(order,'provider','buyer'),false);
  assert.equal(belongsToIdentity(order,'buyer','provider'),false);
  assert.equal(belongsToIdentity(order,'buyer',undefined),false);
  assert.equal(belongsToIdentity(order,'admin','buyer'),false);
  assert.equal(belongsToIdentity({...order,readOnly:true},'provider','provider'),true);
});
