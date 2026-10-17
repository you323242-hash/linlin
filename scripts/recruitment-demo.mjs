import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';

// A separate synthetic runtime. Never remove authentication from the original app.
export async function startRecruitmentDemo({source,data,origin,port,backendPort}) {
 source=fs.realpathSync(source);data=path.resolve(data);const external=new URL(origin);
 if(external.protocol!=='http:'||external.origin!==origin||external.username||external.password)throw Error('DEMO_ORIGIN_INVALID');
 if(![port,backendPort].every(v=>Number.isInteger(v)&&v>1024&&v<65536)||port===backendPort)throw Error('DEMO_PORT_INVALID');
 if(data===source||data.startsWith(source+path.sep))throw Error('DEMO_DATA_MUST_BE_SEPARATE');
 const marker=path.join(data,'recruitment-purpose.json');
 if(fs.existsSync(path.join(data,'auth.sqlite'))&&!fs.existsSync(marker))throw Error('REFUSE_EXISTING_NON_DEMO_DATABASE');
 fs.mkdirSync(data,{recursive:true,mode:0o700});
 if(fs.existsSync(marker)){if(JSON.parse(fs.readFileSync(marker,'utf8')).purpose!=='synthetic-recruitment-demo')throw Error('DEMO_PURPOSE_MISMATCH');}
 else fs.writeFileSync(marker,JSON.stringify({purpose:'synthetic-recruitment-demo'}),{flag:'wx',mode:0o600});
 const upstream='http://127.0.0.1:'+backendPort,publicPrefix='qingbo-recruitment.';
 let child=spawn(process.execPath,[path.join(source,'server/index.mjs')],{cwd:source,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOME:process.env.HOME,APP_ENV:'local',NODE_ENV:'development',PORT:String(backendPort),AUTH_DATA_DIR:data,BETTER_AUTH_URL:origin,TRUSTED_PROXY_IPS:'127.0.0.1',AUTH_REQUIRE_EMAIL_VERIFICATION:'false',AUTH_PHONE_MODE:'disabled'}});
 child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 const backendHeaders=(ip='127.0.0.1')=>({host:external.host,'x-forwarded-host':external.host,'x-forwarded-proto':'http','x-forwarded-for':ip});
 // Node's fetch normalizes Host; the existing proxy guard requires the external Host.
 const backendFetch=(route,options={})=>new Promise((resolve,reject)=>{
  const request=http.request(upstream+route,{method:options.method||'GET',headers:options.headers,timeout:15000},response=>{
   const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024)response.destroy(Error('DEMO_RESPONSE_TOO_LARGE'));else chunks.push(chunk);});response.on('error',reject);
   response.on('end',()=>{const headers=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)headers.append(response.rawHeaders[i],response.rawHeaders[i+1]);resolve(new Response([204,205,304].includes(response.statusCode)?null:Buffer.concat(chunks),{status:response.statusCode,headers}));});
  });request.on('error',reject);request.on('timeout',()=>request.destroy(Error('DEMO_UPSTREAM_TIMEOUT')));request.end(options.body);
 });
 const stopChild=async()=>{const running=child;child=null;if(running&&running.exitCode===null&&running.signalCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('DEMO_STOP_TIMEOUT')),8000);running.once('exit',()=>{clearTimeout(timer);resolve();});running.kill();});};
 try {
  let ready=false,lastStatus='unreachable';
  for(let i=0;i<100;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error('DEMO_BACKEND_START_FAILED');try{const response=await backendFetch('/api/health',{headers:backendHeaders()});lastStatus=String(response.status);if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  if(!ready)throw Error('DEMO_BACKEND_START_TIMEOUT_'+lastStatus);
 }catch(error){await stopChild();throw error;}
 const starts=new Map();
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow, noarchive'});res.end(JSON.stringify(body));};
 const internalCookies=value=>(value||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(publicPrefix)).map(v=>'delta.'+v.slice(publicPrefix.length)).join('; ');
 const publicCookies=values=>values.filter(v=>v.startsWith('delta.')).map(v=>publicPrefix+v.slice('delta.'.length));
 const server=http.createServer(async(req,res)=>{
  try {
   if(req.headers.host!==external.host||!req.url.startsWith('/')||req.url.startsWith('//'))return json(res,400,{message:'演示地址无效。'});
   const route=new URL(req.url,origin).pathname;
   if(route==='/__demo/health')return json(res,200,{ok:true,recruitmentDemo:true});
   if(/^\/api\/auth\/(sign-in|sign-up|phone-number|request-password-reset|forget-password|reset-password)(\/|$)/.test(route))return json(res,403,{message:'招聘体验无需账号密码，请直接浏览并操作演示功能。'});
   const ip=isIP(req.headers['x-forwarded-for'])?req.headers['x-forwarded-for']:'127.0.0.1';
   const headers={...backendHeaders(ip),cookie:internalCookies(req.headers.cookie),'accept-encoding':'identity'};
   for(const field of ['origin','content-type','if-match','range','if-none-match','if-modified-since'])if(req.headers[field])headers[field]=req.headers[field];
   let body;
   if(!['GET','HEAD'].includes(req.method)){let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>8*1024*1024)return json(res,413,{message:'演示提交内容过大。'});chunks.push(chunk);}body=Buffer.concat(chunks);}
   let response=await backendFetch(req.url,{method:req.method,headers,body});let cookies=[];
   if(route==='/api/me'&&req.method==='GET'&&response.status===401){
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{message:'请从演示首页进入。'});
    const now=Date.now();for(const [key,v] of starts)if(v.until<=now)starts.delete(key);
    const prior=starts.get(ip)||{count:0,until:now+3600000};if(prior.count>=20){res.setHeader('Retry-After','3600');return json(res,429,{message:'体验入口暂时繁忙，请稍后再试。'});}
    const db=new DatabaseSync(path.join(data,'auth.sqlite'),{readOnly:true});let count;try{count=db.prepare('SELECT count(*) AS n FROM user').get().n;}finally{db.close();}
    if(count>=100)return json(res,503,{message:'本轮演示名额已满，请联系网站作者。'});
    prior.count++;starts.set(ip,prior);
    const id=randomUUID();const signup=await backendFetch('/api/auth/sign-up/email',{method:'POST',headers:{...backendHeaders(ip),Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name:'体验访客 '+id.slice(0,4),email:'demo-'+id+'@example.test',password:randomUUID()+randomUUID(),termsAccepted:true})});
    if(!signup.ok)return json(res,503,{message:'暂时无法建立体验，请稍后刷新。'});
    cookies=signup.headers.getSetCookie();const cookie=cookies.map(v=>v.split(';')[0]).join('; ');
    response=await backendFetch('/api/me',{headers:{...backendHeaders(ip),cookie}});
   }
   const outgoing={};for(const [key,value] of response.headers)if(!['set-cookie','content-length','content-encoding','connection','transfer-encoding','www-authenticate','strict-transport-security'].includes(key))outgoing[key]=value;
   outgoing['cache-control']='no-store';outgoing['x-robots-tag']='noindex, nofollow, noarchive';outgoing['x-qingbo-recruitment-demo']='true';
   const setCookies=publicCookies([...cookies,...response.headers.getSetCookie()]);if(setCookies.length)outgoing['set-cookie']=setCookies;
   let bytes=Buffer.from(await response.arrayBuffer());
   if(outgoing['content-type']?.includes('text/html'))bytes=Buffer.from(bytes.toString('utf8').replace(/<body([^>]*)>/i,'<body$1><aside role="note" style="position:sticky;top:0;z-index:1000;padding:10px 16px;text-align:center;background:#eaf3ff;color:#28496c;font-size:14px;line-height:1.5">招聘体验 · 无需账号密码 · 所有操作仅用于演示，请勿填写真实个人信息或转账。</aside>'));
   res.writeHead(response.status,outgoing);res.end(req.method==='HEAD'?undefined:bytes);
  }catch{if(!res.headersSent)json(res,503,{message:'演示服务暂时不可用，请稍后刷新。'});else res.end();}
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}catch(error){await stopChild();throw error;}
 const close=async()=>{await new Promise(r=>server.close(r));await stopChild();};
 child.once('exit',()=>server.close());
 return {close,origin,port,data};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=Object.fromEntries(Array.from({length:Math.floor((process.argv.length-2)/2)},(_,i)=>[process.argv[i*2+2],process.argv[i*2+3]]));
 const app=await startRecruitmentDemo({source:args['--source'],data:args['--data'],origin:args['--origin'],port:Number(args['--port']),backendPort:Number(args['--backend'])});
 console.log('RECRUITMENT_DEMO_READY');let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
}
