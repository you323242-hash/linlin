import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../server/config.mjs';

const files=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(?:js|mjs)$/.test(e.name))files.push(p);}}
for(const name of ['dist','server','scripts','tests'])walk(path.join(PROJECT_ROOT,name));
let failed=0;
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});if(result.status!==0){failed++;console.error(path.relative(PROJECT_ROOT,file));console.error(result.stderr||'语法检查进程失败。');}}
console.log(JSON.stringify({scope:'javascript-syntax-only',files:files.length,failed}));if(failed)process.exitCode=1;
