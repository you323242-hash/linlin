import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsRoundConfirmation} from '../dist/orders.mjs';
test('双方对局核对与旧记录兼容',()=>{
  for(const reportedRole of ['buyer','provider']) {
    const order={rounds:[{reportedRole,normal:false}]};
    assert.equal(needsRoundConfirmation(order,reportedRole),false);
    assert.equal(needsRoundConfirmation(order,reportedRole==='buyer'?'provider':'buyer'),true);
    order.rounds[0].normal=true; assert.equal(needsRoundConfirmation(order,'buyer'),false);
  }
  assert.equal(needsRoundConfirmation({rounds:[{normal:false}]},'buyer'),true);
  assert.equal(needsRoundConfirmation({rounds:[{normal:false}]},'provider'),false);
});
