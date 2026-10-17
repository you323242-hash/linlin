import {existsSync,lstatSync,readFileSync,writeFileSync,renameSync,chmodSync,chownSync,statSync} from 'node:fs';
import path from 'node:path';

// Root-owned maintenance outcome. No backup path, key, user or order data in this file.
const filename='/var/lib/delta-monitor/backup-status.json';
try {
  if(process.platform!=='linux'||!['ok','failed'].includes(process.argv[2]))throw Error('INVALID_STATUS');
  if(existsSync(filename)&&(lstatSync(filename).isSymbolicLink()||lstatSync(filename).size>4096))throw Error('INVALID_FILE');
  const previous=existsSync(filename)?JSON.parse(readFileSync(filename,'utf8')):{};
  const now=new Date().toISOString(),ok=process.argv[2]==='ok';
  const state={version:1,ok,checkedAt:now,lastVerifiedAt:ok?now:previous.lastVerifiedAt||null};
  const tmp=path.join(path.dirname(filename),'.backup-status-'+process.pid);
  writeFileSync(tmp,JSON.stringify(state)+'\n',{flag:'wx',mode:0o640});
  chmodSync(tmp,0o640);chownSync(tmp,0,statSync(path.dirname(filename)).gid);renameSync(tmp,filename);
  console.log(JSON.stringify({event:'backup_cycle',ok}));
}catch{console.error(JSON.stringify({event:'backup_cycle',ok:false,code:'STATUS_WRITE_FAILED'}));process.exitCode=1;}
