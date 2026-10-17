import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('部署预检只读、不打印密钥、不创建数据库；错误配置拒绝',t=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(path.join(parent,'delta-preflight-'));
  t.after(()=>{const target=realpathSync(dir);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('delta-preflight-'));rmSync(target,{recursive:true});});
  const secret=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex'),key=path.join(dir,'backup-key');
  const badKey=path.join(dir,'invalid-backup-key');writeFileSync(badKey,'invalid-key',{mode:0o600});
  writeFileSync(key,randomBytes(32).toString('hex'),{mode:0o600});
  const env={...process.env,APP_ENV:'staging',NODE_ENV:'production',PORT:'4174',BETTER_AUTH_URL:'https://staging.example.invalid',AUTH_DATA_DIR:dir,BETTER_AUTH_SECRET:secret,STAGING_ACCESS_TOKEN:token,TRUSTED_PROXY_IPS:'127.0.0.1',EXTERNAL_SERVICE_MODE:'local',ALLOW_STAGING_MOCKS:'true',BACKUP_KEY_FILE:key,AUTH_KEY_REF:'staging-auth-v1'};
  const script=path.resolve(import.meta.dirname,'../scripts/staging-preflight.mjs');
  const run=overrides=>spawnSync(process.execPath,[script],{env:{...env,...overrides},encoding:'utf8',windowsHide:true});
  const success=run({});assert.equal(success.status,0,success.stderr);assert.equal(JSON.parse(success.stdout).productionReady,false);
  for(const value of [secret,token,key])assert.ok(!(success.stdout+success.stderr).includes(value));
  assert.equal(existsSync(path.join(dir,'auth.sqlite')),false);assert.equal(existsSync(path.join(dir,'environment.json')),false);
  for(const bad of [{APP_ENV:'production'},{BACKUP_KEY_FILE:''},{BACKUP_KEY_FILE:badKey},{AUTH_KEY_REF:''},{STAGING_ACCESS_TOKEN:secret},{TRUSTED_PROXY_IPS:'0.0.0.0'}]){
    const result=run(bad);assert.notEqual(result.status,0);assert.ok(!(result.stdout+result.stderr).includes(secret));assert.equal(existsSync(path.join(dir,'auth.sqlite')),false);
  }
});
