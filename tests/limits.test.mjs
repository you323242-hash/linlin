import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../server/limits.mjs';
import { createPersistentLimiter } from '../server/limits.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
test('本地限流按可信键隔离、到期恢复、键容量有界', () => {
  let clock = 0; const hit = createLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => clock });
  assert.equal(hit('a'), true); assert.equal(hit('a'), true); assert.equal(hit('a'), false); assert.equal(hit('b'), true); assert.equal(hit('c'), false);
  clock = 1000; assert.equal(hit('c'), true); assert.equal(hit('a'), true); assert.equal(hit('a'), true); assert.equal(hit('a'), false);
});
test('SQLite限流跨连接/重启不清零、按命名空间隔离、到期与容量有界，不保存原始IP', t => {
  const parent=realpathSync(tmpdir()), directory=mkdtempSync(path.join(parent,'delta-limit-'));
  let db=new DatabaseSync(path.join(directory,'limits.sqlite')), clock=0;
  t.after(()=>{db.close();const target=realpathSync(directory);assert.equal(path.dirname(target),parent);rmSync(target,{recursive:true});});
  const options={namespace:'test-peer',limit:2,maxKeys:2,windowMs:1000,now:()=>clock};
  let hit=createPersistentLimiter(db,options);
  assert.equal(hit('192.0.2.1'),true); db.close();db=new DatabaseSync(path.join(directory,'limits.sqlite'));hit=createPersistentLimiter(db,options);
  assert.equal(hit('192.0.2.1'),true);assert.equal(hit('192.0.2.1'),false);
  const second=new DatabaseSync(path.join(directory,'limits.sqlite'));
  try {assert.equal(createPersistentLimiter(second,options)('192.0.2.1'),false);} finally{second.close();}
  assert.equal(createPersistentLimiter(db,{...options,namespace:'other-peer'})('192.0.2.1'),true);
  assert.equal(hit('192.0.2.2'),true);assert.equal(hit('192.0.2.3'),false);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM runtime_limits').all()).includes('192.0.2.'));
  clock=1000;assert.equal(hit('192.0.2.3'),true);assert.equal(hit('192.0.2.1'),true);
});
