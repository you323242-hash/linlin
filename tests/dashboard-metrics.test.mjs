import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { aftercareMetrics, aftercareMetricsFromDatabase } from '../server/aftercare.mjs';

test('SQLite售后汇总保持历史口径，不需加载整笔订单', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE orders(payload TEXT NOT NULL)');
    assert.deepEqual(aftercareMetricsFromDatabase(db,10000),aftercareMetrics([],10000));
    const orders=[{messages:[{text:'不应加载的私有消息'}],cases:[{kind:'service',stage:'closed',metricsVersion:1,openedAt:1000,firstReviewedAt:4100,closedAt:8000,humanActions:2}],case:{kind:'time',stage:'human',metricsVersion:1,openedAt:2000,humanActions:1}},
      {case:{kind:'complaint',stage:'closed',openedAt:0}},{cases:[{kind:'zero',stage:'closed',metricsVersion:1,openedAt:5000,firstReviewedAt:7000,closedAt:10000}]},{case:null}];
    for(const order of orders)db.prepare('INSERT INTO orders VALUES (?)').run(JSON.stringify(order));
    assert.deepEqual(aftercareMetricsFromDatabase(db,11000),aftercareMetrics(orders,11000));
  } finally {db.close();}
});
