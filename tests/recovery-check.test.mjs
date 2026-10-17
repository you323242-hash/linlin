import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {createAuth} from '../server/auth.mjs';
import {createLocalProviders} from '../server/providers/local.mjs';
import {createMarket} from '../server/market.mjs';
import {createEncryptedSnapshot} from '../scripts/secure-backup.mjs';
import {checkEncryptedRecovery} from '../scripts/recovery-check.mjs';

test('加密恢复演练在隔离目录核对两库，失败清理且不修改源目录',async()=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(path.join(parent,'delta-recovery-test-'));
 const source=path.join(root,'source'),backup=path.join(root,'backup'),key=randomBytes(32);
 try {
  const {database}=await createAuth({baseURL:'http://127.0.0.1:4174',dataDirectory:source});
  const providers=createLocalProviders({directory:source});createMarket(database,providers);providers.close();database.close();
  await createEncryptedSnapshot(source,backup,key);
  const result=await checkEncryptedRecovery(backup,key);assert.equal(result.ok,true);
  await assert.rejects(checkEncryptedRecovery(backup,randomBytes(32)));
  assert.equal(readdirSync(root).filter(n=>n.startsWith('.delta-recovery-')).length,0);
  assert.ok(readdirSync(source).includes('auth.sqlite'));
 }finally{
  const resolved=realpathSync(root);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('delta-recovery-test-'));rmSync(resolved,{recursive:true});
 }
});
