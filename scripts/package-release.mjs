import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../server/config.mjs';
import { verifyRelease } from './verify-release.mjs';

// Source allowlist, not git archive: current authored dist and uncommitted source are required.
const roots=['dist','server','scripts','tests','config','deploy','db'];
const top=['package.json','package-lock.json','README.md','AGENTS.md','PROJECT_BRAIN.md','.gitignore','.gitattributes','启动网站.cmd','.github/workflows/quality.yml'];
const denied=/(?:\.(?:sqlite3?|db3?|pem|key|p12|pfx|zip|bak|log)|-wal|-shm)$/i;
export function createRelease(target,{root=PROJECT_ROOT}={}) {
  root=path.resolve(root);target=path.resolve(target);
  const normalized=value=>process.platform==='win32'?value.toLowerCase():value;
  if(normalized(target)===normalized(root)||normalized(target).startsWith(normalized(root)+path.sep)||existsSync(target))throw Error('交付目录必须是项目外的新目录。');
  const sources=[];
  function collect(relative) {
    const filename=path.join(root,relative),info=lstatSync(filename);
    if(info.isSymbolicLink())throw Error('交付不接受符号链接。');
    if(info.isDirectory())for(const name of readdirSync(filename).sort())collect(relative+'/'+name);
    else if(info.isFile()) {
      const parts=relative.split('/');
      if(parts.some(p=>['node_modules','.git','.local','.data','storage','backups','logs'].includes(p))||denied.test(relative)||parts.some(p=>p.startsWith('.env'))||parts.includes('auth-secret')||parts.includes('auth-key.json'))throw Error('源码目录中发现不应交付的运行数据或密钥。');
      if(relative.startsWith('config/')&&!['config/local.env.example','config/staging.env.example','config/channels.env.example'].includes(relative))throw Error('只交付已审阅的环境模板，不导出其他私有配置。');
      // Environment templates must contain blanks only for actual credentials.
      const bytes=readFileSync(filename);
      if(bytes.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))throw Error('发现数据库内容，交付已停止。');
      if(/\.(?:mjs|js|json|md|ts|html|css|example|sh|cmd)$/.test(relative)){
        const content=bytes.toString('utf8');
        if(relative!=='tests/tls-fixture.mjs'&&/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))throw Error('发现私钥，交付已停止。');
        if(relative.startsWith('config/')&&/^(?:BETTER_AUTH_SECRET|STAGING_ACCESS_TOKEN|STAGING_GATE_PASSWORD_HASH|SMS_SECRET_FILE|WECHAT_LOGIN_SECRET_FILE|QQ_LOGIN_SECRET_FILE|PAYMENT_SECRET_FILE)[ \t]*=[ \t]*[^\s#]+/m.test(content))throw Error('配置模板中发现非空凭据或私有路径。');
      }
      sources.push({path:relative,bytes});
    }
  }
  for(const dir of roots)collect(dir);
  for(const filename of top)if(existsSync(path.join(root,filename)))collect(filename);
  // Historical documents remain as context; raw DOCX and screenshots are excluded from the scan pack.
  for(const filename of readdirSync(path.join(root,'docs')).sort())if(filename.endsWith('.md'))collect('docs/'+filename);
  // Raw evidence contains third-party archives, browser transcripts and deployment logs.
  // Keep it locally; source releases include reviewed top-level reports only.
  const lock=JSON.parse(readFileSync(path.join(root,'package-lock.json'),'utf8'));
  const dependencies=Object.entries(lock.packages||{}).filter(([name])=>name).map(([name,p])=>({path:name,version:p.version,license:p.license||'CHECK_UPSTREAM',integrity:p.integrity||null,resolved:p.resolved||null}));
  sources.push({path:'DEPENDENCY_INVENTORY.json',bytes:Buffer.from(JSON.stringify({source:'package-lock.json',dependencies},null,2)+'\n')});
  sources.push({path:'交付包阅读入口.md',bytes:Buffer.from('# 三角洲网站安全检测包\n\n当前范围为本地/受限内测，真实支付仍关闭。先阅读 docs/安全检测交付说明_2026-10-04.md。\n\nNode 24；先执行 node scripts/verify-release.mjs，再 npm ci，再 npm test。离线已有依赖时可运行，但此源码包不包含 node_modules，首次安装需要下载锁定依赖。\n\n当前源码不是仅已提交版本；dist 是手工维护的前端源文件。运行用 node scripts/dev.mjs start，默认 http://127.0.0.1:4174。不得通过删除 production 门禁启用真实交易。\n\n不包含真实数据库、账户、附件、密钥、运行日志或 node_modules；也不包含已退役的 archive 框架、原始 DOCX 和历史截图。tests/tls-fixture.mjs 是公开的合成测试证书及私钥，绝不能用于部署。其他本地测试密码也是公开测试资料。\n\nRELEASE_MANIFEST.json 是完整性清单，不是数字签名；请另外核对交付压缩包的 SHA256。\n','utf8')});
  mkdirSync(target,{recursive:true});
  const files=[];
  for(const file of sources.sort((a,b)=>a.path.localeCompare(b.path))){
    const destination=path.join(target,file.path);mkdirSync(path.dirname(destination),{recursive:true});writeFileSync(destination,file.bytes,{flag:'wx'});
    files.push({path:file.path,bytes:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex')});
  }
  writeFileSync(path.join(target,'RELEASE_MANIFEST.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),scope:'source-and-restricted-mock-staging',productionReady:false,nodeMajor:24,testFixturePrivateKey:'tests/tls-fixture.mjs',files},null,2)+'\n',{flag:'wx'});
  const result=verifyRelease(target);if(!result.ok)throw Error('交付完整性验证失败。');
  return {directory:target,...result};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(!process.argv[2])throw Error();console.log(JSON.stringify(createRelease(process.argv[2]),null,2));}
  catch{console.error('交付导出失败：使用项目外的全新目录，检查源码和配置中是否包含密钥/运行数据。不会覆盖原文件。');process.exitCode=1;}
}
