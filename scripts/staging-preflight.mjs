import {existsSync,statSync} from 'node:fs';
import path from 'node:path';
import {localConfig,PROJECT_ROOT} from '../server/config.mjs';
import {readBackupKey} from './secure-backup.mjs';
// Pure checks: no listener, database creation, cloud calls or secret printing.
try {
  const config=localConfig();
  let validBackupKey=false;try{validBackupKey=readBackupKey(process.env.BACKUP_KEY_FILE).length===32;}catch{}
  const checks=[
    {name:'restricted-staging',ok:config.environment==='staging'},
    {name:'verified-node-major',ok:Number(process.versions.node.split('.')[0])===24},
    {name:'entry-and-lockfile',ok:['server/index.mjs','server/teams.mjs','server/security.mjs','package-lock.json','dist/teams.html'].every(p=>existsSync(path.join(PROJECT_ROOT,p)))},
    {name:'single-loopback-proxy',ok:config.trustedProxies.length===1&&config.trustedProxies[0]==='127.0.0.1'},
    {name:'backup-key-file',ok:validBackupKey},
    {name:'auth-key-reference',ok:!!process.env.AUTH_KEY_REF},
    {name:'existing-data-directory',ok:existsSync(config.dataDirectory)},
  ];
  if(process.platform==='linux'&&process.env.BACKUP_KEY_FILE&&existsSync(process.env.BACKUP_KEY_FILE))checks.push({name:'private-backup-key',ok:(statSync(process.env.BACKUP_KEY_FILE).mode&0o077)===0});
  console.log(JSON.stringify({scope:'restricted-staging',productionReady:false,checks,notVerified:['Linux service installation','Caddy configuration and real certificate','external monitoring','offsite restore','real payment and account verification']},null,2));
  if(checks.some(c=>!c.ok))process.exitCode=1;
}catch{console.error('内测部署预检未通过；请核对私有配置、独立数据目录及部署文档。未输出密钥。');process.exitCode=1;}
