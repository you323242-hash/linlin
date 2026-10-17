import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyRelease(directory) {
  const root=path.resolve(directory), manifest=JSON.parse(readFileSync(path.join(root,'RELEASE_MANIFEST.json'),'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.files))throw Error('交付清单格式无效。');
  const expected=new Map(), problems=[];
  for(const file of manifest.files) {
    if(typeof file.path!=='string'||file.path.includes('\\')||file.path.split('/').some(p=>!p||p==='.'||p==='..')||expected.has(file.path))throw Error('交付清单含非法或重复路径。');
    expected.set(file.path,file);
    const filename=path.resolve(root,file.path);
    if(!filename.startsWith(root+path.sep))throw Error('交付路径越界。');
    try {
      if(!lstatSync(filename).isFile()||lstatSync(filename).isSymbolicLink())throw Error();
      const bytes=readFileSync(filename);
      if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)problems.push({path:file.path,code:'HASH_MISMATCH'});
    }catch{problems.push({path:file.path,code:'MISSING_OR_INVALID_FILE'});}
  }
  function walk(dir,relative='') {
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const name=relative?relative+'/'+entry.name:entry.name;
      // Runtime data/install artifacts may be created only AFTER unpacking.
      if(!relative&&['node_modules','.local','.data','.git'].includes(entry.name))continue;
      if(entry.isSymbolicLink())problems.push({path:name,code:'SYMLINK_NOT_ALLOWED'});
      else if(entry.isDirectory())walk(path.join(dir,entry.name),name);
      else if(name!=='RELEASE_MANIFEST.json'&&!expected.has(name))problems.push({path:name,code:'UNEXPECTED_FILE'});
    }
  }
  walk(root);
  return {ok:problems.length===0,files:expected.size,problems};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const report=verifyRelease(process.argv[2]||process.cwd());console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;}
  catch{console.error('交付包验证失败，请使用完整解压目录；没有修改任何文件。');process.exitCode=1;}
}
